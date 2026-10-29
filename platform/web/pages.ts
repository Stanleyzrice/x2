// 页：agent 开一页（x2 page create），往上放组件（x2 page push）。网页的侧栏是页列表，中间是页上 generative 组件的流，右边是 interactable 组件（一个一个 tab）。
// generative 是快照：agent 说话那一刻的内容，数据在组件里，人只看。interactable 是引用：组件里只记指向谁（例 一张表的哪几行），数据每次现读，人在上面做的事写回去。
// 文件夹就是分类：组件放在 platform/ui/generative/<名字>/ 或 platform/ui/interactable/<名字>/，参数、说明、例子在它的 schema.ts（只有 zod），网页照 view.tsx 画。
// 这里照这两个目录收 schema.ts：x2 page push 照它校验（不对说哪一格），x2 page components 照它给 agent 看
import { readdirSync } from "node:fs";
import { z } from "zod";
import type { Json, Sql } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { invoke } from "../tool.ts";
import { checkRef, type Ref } from "./grid.ts";
import { tables } from "./tables.ts";

export const KINDS = ["generative", "interactable"] as const;
export type Kind = (typeof KINDS)[number];
/** 一个组件的 schema.ts：参数、说明、例子；要人回答的（例 choice）还有 answer：照这一个组件的参数，人的答案长什么样；
 * 要现读站点的（例 chat）还有 actions：网页能替它调哪几个工具（名字 → 注册表里的工具 id），和 inputs：调的时候网页能填哪几个参数（别的都照引用） */
export type Component = {
	name: string;
	kind: Kind;
	description: string;
	props: z.ZodType;
	examples: unknown[];
	answer?: (props: any) => z.ZodType;
	actions?: Record<string, string>;
	inputs?: string[];
};

const UI = new URL("../ui/", import.meta.url);

/** 一类组件：目录下的每个文件夹是一个组件，读它的 schema.ts */
async function collect(kind: Kind): Promise<Component[]> {
	const dir = new URL(`${kind}/`, UI);
	const names = readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
	return Promise.all(
		names.map(async (name) => {
			const m = await import(new URL(`${name}/schema.ts`, dir).href);
			return { name, kind, description: m.description, props: m.props, examples: m.examples, answer: m.answer, actions: m.actions, inputs: m.inputs };
		}),
	);
}

export const COMPONENTS: ReadonlyMap<string, Component> = new Map((await Promise.all(KINDS.map(collect))).flat().map((c) => [c.name, c]));

/** 引用别处的组件，服务端再查一遍指向的东西在不在（schema.ts 只管形状，不认库） */
const REFS: Record<string, (props: any) => string[]> = { datagrid: (p: Ref) => checkRef(tables(), p) };

export type Item = { id: PageItemId; component: string; props: unknown; at: string; answer: unknown; answeredAt: string | null };
export type Page = { id: PageId; title: string; createdAt: string; updatedAt: string; items: Item[] };
export type PageSummary = Omit<Page, "items">;

const names = () => [...COMPONENTS.keys()].join("、");

export function parseItem(input: unknown): { component: string; props: unknown } {
	const spec = z.object({ component: z.string(), props: z.unknown() }).safeParse(input);
	if (!spec.success) throw new Usage(`组件要写成 { "component": 名字, "props": {…} }（有：${names()}）`);
	return { component: spec.data.component, props: parseProps(spec.data.component, spec.data.props) };
}

/** 照组件的 schema.ts 校验参数，引用的再查指向的东西在不在；不对说哪一格 */
export function parseProps(component: string, input: unknown): unknown {
	const c = COMPONENTS.get(component);
	if (!c) throw new Usage(`没有组件 ${component}（有：${names()}）`);
	const r = c.props.safeParse(input ?? {});
	const bad = r.success ? (REFS[component]?.(r.data) ?? []) : r.error.issues.map((x) => `${x.path.join(".") || "props"}：${x.message}`);
	if (bad.length) throw new Usage(`${component} 的参数不对：${bad.join("；")}`);
	return r.data;
}

export const catalog = () =>
	[...COMPONENTS.values()].map((c) => ({
		name: c.name,
		kind: c.kind,
		description: c.description,
		props: z.toJSONSchema(c.props, { io: "input", unrepresentable: "any" }),
		examples: c.examples,
	}));

// 库里的一行（bigint 回字符串）
type PageRow = { id: PageId; title: string; created_at: Date; updated_at: Date };
type ItemRow = { id: PageItemId; component: string; props: unknown; created_at: Date; answer: unknown; answered_at: Date | null };

const summary = (r: PageRow): PageSummary => ({
	id: r.id,
	title: r.title,
	createdAt: r.created_at.toISOString(),
	updatedAt: r.updated_at.toISOString(),
});

export async function listPages(sql: Sql): Promise<PageSummary[]> {
	return (await sql<PageRow[]>`select * from pages order by updated_at desc`).map(summary);
}

export async function createPage(sql: Sql, title: string): Promise<PageSummary> {
	const t = title.trim();
	if (!t) throw new Usage("页要有标题");
	const [r] = await sql<PageRow[]>`insert into pages (title) values (${t}) returning *`;
	return summary(r!);
}

export async function deletePage(sql: Sql, id: string): Promise<void> {
	const r = await sql`delete from pages where id = ${pageId(id)} returning id`;
	if (!r.length) throw new Usage(`没有页 ${id}`);
}

export async function showPage(sql: Sql, id: string): Promise<Page> {
	const [s] = await sql<PageRow[]>`select * from pages where id = ${pageId(id)}`;
	if (!s) throw new Usage(`没有页 ${id}`);
	const items = await sql<ItemRow[]>`select * from page_items where page_id = ${s.id} order by id`;
	return {
		...summary(s),
		items: items.map(
			(i): Item => ({
				id: i.id,
				component: i.component,
				props: i.props,
				at: i.created_at.toISOString(),
				answer: i.answer,
				answeredAt: i.answered_at?.toISOString() ?? null,
			}),
		),
	};
}

export async function push(sql: Sql, id: string, input: unknown): Promise<{ id: string; component: string; replaced: boolean }> {
	const { component, props } = parseItem(input);
	const pid = pageId(id);
	return sql.begin(async (tx) => {
		const [s] = await tx`select id from pages where id = ${pid} for update`;
		if (!s) throw new Usage(`没有页 ${id}`);
		await tx`update pages set updated_at = now() where id = ${pid}`;
		if (COMPONENTS.get(component)!.kind === "interactable") {
			const same = (await tx`select id, props from page_items where page_id = ${pid} and component = ${component}`).find(
				(r) => refKey(r.props) === refKey(props),
			);
			if (same) {
				await tx`update page_items set props = ${tx.json(props as Json)}, created_at = now() where id = ${same.id}`;
				return { id: String(same.id), component, replaced: true };
			}
		}
		const [r] = await tx`insert into page_items (page_id, component, props) values (${pid}, ${component}, ${tx.json(props as Json)}) returning id`;
		return { id: String(r!.id), component, replaced: false };
	});
}

/** 改一个组件的参数：整份换掉，照它的 schema.ts 校验（generative、interactable 都行）；网页下一次重读就变 */
export async function update(sql: Sql, item: string, input: unknown): Promise<{ id: string; component: string }> {
	const id = itemId(item);
	return sql.begin(async (tx) => {
		const [i] = await tx`select component, page_id from page_items where id = ${id} for update`;
		if (!i) throw new Usage(`没有组件 ${item}（x2 page show 看编号）`);
		const props = parseProps(i.component, input);
		await tx`update page_items set props = ${tx.json(props as Json)} where id = ${id}`;
		await tx`update pages set updated_at = now() where id = ${i.page_id}`;
		return { id, component: i.component as string };
	});
}

/** 照组件的 answer 查人的答案（例 choice 只认它的选项、单选只能一个）；不对说哪一格 */
export function parseAnswer(component: string, props: unknown, input: unknown): unknown {
	const c = COMPONENTS.get(component);
	if (!c?.answer) throw new Usage(`${component} 不收答案`);
	const r = c.answer(c.props.parse(props)).safeParse(input);
	if (!r.success) throw new Usage(`答案不对：${r.error.issues.map((x) => `${x.path.join(".") || "answer"}：${x.message}`).join("；")}`);
	return r.data;
}

/** 人在网页上回答（例 在 choice 上选了）：存进这个组件的 answer，记下时间；再答是换掉 */
export async function answer(sql: Sql, item: string, input: unknown): Promise<void> {
	const id = itemId(item);
	const [i] = await sql`select component, props, page_id from page_items where id = ${id}`;
	if (!i) throw new Usage(`没有组件 ${item}`);
	const a = parseAnswer(i.component, i.props, input);
	await sql`update page_items set answer = ${sql.json(a as Json)}, answered_at = now() where id = ${id}`;
	await sql`update pages set updated_at = now() where id = ${i.page_id}`;
}

/** 网页替组件调它声明的一个工具：参数是组件的引用（props，标题不算）加上人在网页上选的（例 换了一个会话）。只调 schema.ts 的 actions 里写着的 */
export async function act(sql: Sql, item: string, action: string, input: unknown): Promise<unknown> {
	const id = itemId(item);
	const [i] = await sql`select component, props from page_items where id = ${id}`;
	if (!i) throw new Usage(`没有组件 ${item}`);
	const tool = COMPONENTS.get(i.component)?.actions?.[action];
	if (!tool) throw new Usage(`${i.component} 没有 ${action}`);
	return invoke(tool, actParams(i.props, input, COMPONENTS.get(i.component)?.inputs ?? []));
}

/** 替组件调工具的参数：引用说了算（例 chat 的店），网页只能填组件声明过的 inputs（例 换一个会话）；别的网页发来的不要 */
export function actParams(props: unknown, input: unknown, inputs: readonly string[]): Record<string, unknown> {
	const { title: _, ...ref } = props as Record<string, unknown>;
	const given = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
	return { ...ref, ...Object.fromEntries(inputs.filter((k) => k in given).map((k) => [k, given[k]])) };
}

export async function closeItem(sql: Sql, item: string): Promise<void> {
	itemId(item);
	const interactable = [...COMPONENTS.values()].filter((c) => c.kind === "interactable").map((c) => c.name);
	await sql`delete from page_items where id = ${item} and component in ${sql(interactable)}`;
}

/** 一个引用的样子：除了标题的参数，对象的键排好（jsonb 存进去会重排对象的键，不能直接比 JSON） */
export const refKey = (props: unknown) => {
	const { title: _, ...rest } = props as Record<string, unknown>;
	return JSON.stringify(rest, (k, v) => {
		if (!v || typeof v !== "object" || Array.isArray(v)) return v;
		const entries = Object.entries(v).sort(([a], [b]) => a.localeCompare(b));
		// filter 里一个值和只有它的一列算同一个（{ shop: "x" } 和 { shop: ["x"] }）
		return Object.fromEntries(k === "filter" ? entries.map(([c, x]) => [c, Array.isArray(x) ? x : [x]]) : entries);
	});
};

/** 页的编号、页上组件的编号：命令行、网页给的字符串在这里认成编号，之后别互相传错 */
export const PageId = z.string().regex(/^\d+$/).brand<"PageId">();
export type PageId = z.output<typeof PageId>;
export const PageItemId = z.string().regex(/^\d+$/).brand<"PageItemId">();
export type PageItemId = z.output<typeof PageItemId>;

function pageId(id: string): PageId {
	const r = PageId.safeParse(id);
	if (!r.success) throw new Usage(`页是数字编号：${id}`);
	return r.data;
}

function itemId(id: string): PageItemId {
	const r = PageItemId.safeParse(id);
	if (!r.success) throw new Usage(`组件是数字编号：${id}`);
	return r.data;
}
