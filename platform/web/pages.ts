// 页：agent 开一页（x2 page create），往上放组件（x2 page push）。网页的侧栏是页列表，中间是页上 generative 组件的流，右边是 interactable 组件（一个一个 tab）。
// generative 是快照：agent 说话那一刻的内容，数据在组件里，人只看。interactable 是引用：组件里只记指向谁（例 一张表的哪几行），数据每次现读，人在上面做的事写回去。
// 文件夹就是分类：组件放在 platform/ui/generative/<名字>/ 或 platform/ui/interactable/<名字>/，参数、说明、例子在它的 schema.ts（只有 zod），网页照 view.tsx 画。
// 这里照这两个目录收 schema.ts：x2 page push 照它校验（不对说哪一格），x2 page components 照它给 agent 看
import { readdirSync } from "node:fs";
import { z } from "zod";
import type { Json, Sql } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { configuredWorkspaces, invoke, type Workspace } from "../tool.ts";
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
	/** 拿到的 props 是照这个组件的 props 解析过的（各个组件不一样，写成 never） */
	answer?: (props: never) => z.ZodType;
	/** 人按行填写的描述，独立保存，不占用选用决定。 */
	note?: (props: never) => z.ZodType<{ rowId: string; text: string }>;
	/** 逐行选择只送改动的键；普通 choice 仍整份替换。 */
	answerMode?: "merge";
	actions?: Record<string, string>;
	inputs?: string[];
	writeActions?: Record<string, string>;
	writePreviews?: Record<string, string>;
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
			return {
				name,
				kind,
				description: m.description,
				props: m.props,
				examples: m.examples,
				answer: m.answer,
				note: m.note,
				answerMode: m.answerMode,
				actions: m.actions,
				inputs: m.inputs,
				writeActions: m.writeActions,
				writePreviews: m.writePreviews,
			};
		}),
	);
}

export const COMPONENTS: ReadonlyMap<string, Component> = new Map((await Promise.all(KINDS.map(collect))).flat().map((c) => [c.name, c]));

/** 引用别处的组件，服务端再查一遍指向的东西在不在（schema.ts 只管形状，不认库） */
const REFS: Record<string, (props: never) => string[]> = { datagrid: (p: Ref) => checkRef(tables(), p) };

/** invalid：库里存的参数和现在的组件对不上（组件改过、引用过时了）：说哪一格，网页上不画这个组件，免得悄悄变成别的查询 */
export type Item = {
	id: PageItemId;
	component: string;
	props: unknown;
	at: string;
	answer: unknown;
	answeredAt: string | null;
	notes?: Record<string, string>;
	notesAt?: string | null;
	invalid?: string;
	fixed?: boolean;
};
export type Page = { id: PageId; title: string; createdAt: string; updatedAt: string; items: Item[]; workspace?: Workspace };
export type PageSummary = Omit<Page, "items">;

const names = () => [...COMPONENTS.keys()].join("、");

export function parseItem(input: unknown): { component: string; props: unknown } {
	const spec = z.object({ component: z.string(), props: z.unknown() }).safeParse(input);
	if (!spec.success) throw new Usage(`组件要写成 { "component": 名字, "props": {…} }（有：${names()}）`);
	return { component: spec.data.component, props: parseProps(spec.data.component, spec.data.props) };
}

/** 照组件的 schema.ts 校验参数，引用的再查指向的东西在不在；不对说哪一格 */
/** 库里读出的参数照现在的组件再查一遍：对不上回 { invalid: 原话 } */
export function invalidOf(component: string, props: unknown): { invalid?: string } {
	try {
		parseProps(component, props);
		return {};
	} catch (e) {
		return { invalid: (e as Error).message };
	}
}

export function parseProps(component: string, input: unknown): unknown {
	const c = COMPONENTS.get(component);
	if (!c) throw new Usage(`没有组件 ${component}（有：${names()}）`);
	const r = c.props.safeParse(input ?? {});
	const bad = r.success ? (REFS[component]?.(r.data as never) ?? []) : r.error.issues.map((x) => `${x.path.join(".") || "props"}：${x.message}`);
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
type PageRow = { id: PageId; title: string; created_at: Date; updated_at: Date; workspace_key?: string | null };
type ItemRow = {
	id: PageItemId;
	component: string;
	props: unknown;
	created_at: Date;
	answer: unknown;
	answered_at: Date | null;
	notes: Record<string, string>;
	notes_at: Date | null;
	fixed?: boolean;
};

export const workspaces = configuredWorkspaces;

export async function ensureWorkspaces(sql: Sql): Promise<void> {
	for (const w of workspaces()) {
		const props = parseProps(w.component, w.props);
		await sql.begin(async (tx) => {
			const [p] = await tx<
				{ id: PageId }[]
			>`insert into pages (title, workspace_key) values (${w.title}, ${w.key}) on conflict (workspace_key) do update set title = excluded.title returning id`;
			await tx`insert into page_items (page_id, component, props, fixed) values (${p!.id}, ${w.component}, ${tx.json(props as Json)}, true)
				on conflict (page_id) where fixed do update set component = excluded.component, props = excluded.props`;
		});
	}
}

const summary = (r: PageRow): PageSummary => ({
	id: r.id,
	title: r.title,
	createdAt: r.created_at.toISOString(),
	updatedAt: r.updated_at.toISOString(),
	...(r.workspace_key ? { workspace: workspaces().find((w) => w.key === r.workspace_key) } : {}),
});

/** 已停用的固定工作区保留历史，但不降级成临时页或接受旧链接访问。 */
export function pageVisible(workspaceKey: string | null | undefined, registered: readonly string[]): boolean {
	return !workspaceKey || registered.includes(workspaceKey);
}

export async function listPages(sql: Sql): Promise<PageSummary[]> {
	const registered = workspaces().map((w) => w.key);
	return (await sql<PageRow[]>`select * from pages order by updated_at desc`).filter((p) => pageVisible(p.workspace_key, registered)).map(summary);
}

export async function createPage(sql: Sql, title: string): Promise<PageSummary> {
	const t = title.trim();
	if (!t) throw new Usage("页要有标题");
	const [r] = await sql<PageRow[]>`insert into pages (title) values (${t}) returning *`;
	return summary(r!);
}

export async function deletePage(sql: Sql, id: string): Promise<void> {
	const r = await sql`delete from pages where id = ${pageId(id)} and workspace_key is null returning id`;
	if (!r.length) throw new Usage(`没有页 ${id}`);
}

type DeletionPage = { id: string; workspace_key: string | null; fixed: boolean };

/** 批量选择先全量校验，再进入删除；任何固定页或缺失编号都拒绝整批。 */
export function deletablePageIds(input: unknown, pages: readonly DeletionPage[]): PageId[] {
	const parsed = z.array(PageId).min(1).max(1000).safeParse(input);
	if (!parsed.success) throw new Usage("请选择 1–1000 个有效的页编号");
	const ids = [...new Set(parsed.data)];
	for (const id of ids) {
		const page = pages.find((p) => p.id === id);
		if (!page) throw new Usage(`页 ${id} 不存在，请刷新后重新选择`);
		if (page.workspace_key !== null || page.fixed) throw new Usage(`页 ${id} 是固定工作区，不能删除`);
	}
	return ids;
}

export async function deletePages(sql: Sql, input: unknown): Promise<{ deleted: string[] }> {
	const parsed = z.array(PageId).min(1).max(1000).safeParse(input);
	if (!parsed.success) throw new Usage("请选择 1–1000 个有效的页编号");
	const ids = [...new Set(parsed.data)];
	return sql.begin(async (tx) => {
		const pages = await tx<DeletionPage[]>`select p.id, p.workspace_key,
			exists(select 1 from page_items i where i.page_id = p.id and i.fixed) as fixed
			from pages p where p.id in ${tx(ids)} order by p.id for update`;
		const selected = deletablePageIds(ids, pages);
		await tx`delete from pages where id in ${tx(selected)} and workspace_key is null`;
		return { deleted: selected };
	});
}

export async function showPage(sql: Sql, id: string): Promise<Page> {
	const [s] = await sql<PageRow[]>`select * from pages where id = ${pageId(id)}`;
	if (
		!s ||
		!pageVisible(
			s.workspace_key,
			workspaces().map((w) => w.key),
		)
	)
		throw new Usage(`没有页 ${id}`);
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
				notes: i.notes,
				notesAt: i.notes_at?.toISOString() ?? null,
				fixed: Boolean(i.fixed),
				...invalidOf(i.component, i.props),
			}),
		),
	};
}

export async function push(sql: Sql, id: string, input: unknown): Promise<{ id: string; component: string; replaced: boolean }> {
	const { component, props } = parseItem(input);
	const pid = pageId(id);
	return sql.begin(async (tx) => {
		const [s] = await tx`select id, workspace_key from pages where id = ${pid} for update`;
		if (!s) throw new Usage(`没有页 ${id}`);
		if (s.workspace_key) throw new Usage("固定工作区不接收临时组件");
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
		const [i] = await tx`select component, page_id, fixed from page_items where id = ${id} for update`;
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
	const r = c.answer(c.props.parse(props) as never).safeParse(input);
	if (!r.success) throw new Usage(`答案不对：${r.error.issues.map((x) => `${x.path.join(".") || "answer"}：${x.message}`).join("；")}`);
	return r.data;
}

/** 组件决定答案是整体替换还是按行合并；不把其他行已经做出的决定丢掉。 */
export function nextAnswer(component: string, props: unknown, previous: unknown, input: unknown): unknown {
	const parsed = parseAnswer(component, props, input);
	if (COMPONENTS.get(component)?.answerMode !== "merge") return parsed;
	const before = z.record(z.string(), z.unknown()).safeParse(previous ?? {});
	const patch = z.record(z.string(), z.unknown()).safeParse(parsed);
	if (!before.success || !patch.success) throw new Usage("逐行答案不是对象，保留原答案，未保存");
	return { ...before.data, ...patch.data };
}

/** 描述只能写到组件允许的行；清空某行时仍保留其他行和原换行。 */
export function nextNotes(component: string, props: unknown, previous: unknown, input: unknown): Record<string, string> {
	const c = COMPONENTS.get(component);
	if (!c?.note) throw new Usage(`${component} 不支持自定义描述`);
	const parsed = c.note(c.props.parse(props) as never).safeParse(input);
	if (!parsed.success) throw new Usage(`描述不对：${parsed.error.issues.map((x) => `${x.path.join(".") || "note"}：${x.message}`).join("；")}`);
	const before = z.record(z.string(), z.string()).safeParse(previous ?? {});
	if (!before.success) throw new Usage("原描述数据不对，保留原描述，未保存");
	return { ...before.data, [parsed.data.rowId]: parsed.data.text };
}

/** 只改描述，不改答案或组件参数；锁住行后合并，多个窗口编辑不同行不会互相覆盖。 */
export async function saveNote(sql: Sql, item: string, input: unknown): Promise<{ updatedAt: string }> {
	const id = itemId(item);
	return sql.begin(async (tx) => {
		const [i] = await tx<{ component: string; props: unknown; notes: unknown; page_id: PageId; fixed: boolean }[]>`
			select component, props, notes, page_id, fixed from page_items where id = ${id} for update`;
		if (!i) throw new Usage(`没有组件 ${item}`);
		if (i.fixed) throw new Usage("固定工作区不支持此描述入口");
		const notes = nextNotes(i.component, i.props, i.notes, input);
		const [saved] = await tx<
			{ notes_at: Date }[]
		>`update page_items set notes = ${tx.json(notes)}, notes_at = clock_timestamp() where id = ${id} returning notes_at`;
		await tx`update pages set updated_at = now() where id = ${i.page_id}`;
		return { updatedAt: saved!.notes_at.toISOString() };
	});
}

/** 人在网页上回答：锁住这一份答案再合并，多个窗口选不同行也不会互相覆盖。 */
export async function answer(sql: Sql, item: string, input: unknown): Promise<void> {
	const id = itemId(item);
	await sql.begin(async (tx) => {
		const [i] = await tx<
			{ component: string; props: unknown; answer: unknown; page_id: PageId; fixed: boolean }[]
		>`select component, props, answer, page_id, fixed from page_items where id = ${id} for update`;
		if (!i) throw new Usage(`没有组件 ${item}`);
		if (i.fixed) throw new Usage("固定工作区的引用由应用装配，不允许修改身份");
		const a = nextAnswer(i.component, i.props, i.answer, input);
		await tx`update page_items set answer = ${tx.json(a as Json)}, answered_at = now() where id = ${id}`;
		await tx`update pages set updated_at = now() where id = ${i.page_id}`;
	});
}

/** 网页替组件调它声明的一个工具：参数是组件的引用（props，标题不算）加上人在网页上选的（例 换了一个会话）。只调 schema.ts 的 actions 里写着的 */
export async function act(sql: Sql, item: string, action: string, input: unknown): Promise<unknown> {
	const id = itemId(item);
	const [i] = await sql`select component, props from page_items where id = ${id}`;
	if (!i) throw new Usage(`没有组件 ${item}`);
	const tool = COMPONENTS.get(i.component)?.actions?.[action];
	if (!tool) throw new Usage(`${i.component} 没有 ${action}`);
	return invoke(tool, actParams(i.props, input, COMPONENTS.get(i.component)?.inputs ?? []), "web");
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
	await sql`delete from page_items where id = ${item} and not fixed and component in ${sql(interactable)}`;
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
