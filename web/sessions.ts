// 会话：agent 开一个会话（x2 session create），往里放组件（x2 session push）。网页的侧栏是会话列表，中间是会话里 generative 组件的流，右边是 interactive 组件（一个一个 tab）。
// generative 是快照：agent 说话那一刻的内容，数据在组件里，人只看。interactive 是引用：组件里只记指向谁（例 一张表的一个视图），数据每次现读，人在上面做的事写回去。
// 组件的参数在这里声明一次：x2 session push 照它校验（不对说哪一格），x2 session components 照它给 agent 看，网页照它的类型画
import { z } from "zod";
import type { Sql } from "../src/db/index.ts";
import { Usage } from "../src/errors.ts";
import { TABLES } from "./tables.ts";

const title = z.string().trim().min(1).max(60).optional().describe("标题，短的一句；不给就不写");
const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** datagrid：引用 tables.ts 里的一张表（view 是它的一个视图，filter 是按列筛，值是一个或几个），只存引用，不存行 */
const datagrid = z
	.object({
		title,
		table: z.string().describe(`tables.ts 里的表：${TABLES.map((t) => `${t.name}（${t.title}）`).join("、")}`),
		view: z.string().optional().describe("表的视图（tables.ts 的 views 的 title）；不给用第一个"),
		filter: z
			.record(z.string(), z.union([z.string(), z.array(z.string()).min(1)]))
			.optional()
			.describe("按列筛：{ 列名: 值 或 [值…] }，只认这张表给人看的列和主键；例 { id: ['3', '5'] }"),
	})
	.superRefine((p, ctx) => {
		const t = TABLES.find((x) => x.name === p.table);
		if (!t) return ctx.addIssue({ code: "custom", path: ["table"], message: `没有表 ${p.table}（有：${TABLES.map((x) => x.name).join("、")}）` });
		if (p.view && !t.views.some((v) => v.title === p.view))
			ctx.addIssue({ code: "custom", path: ["view"], message: `${t.title}没有视图「${p.view}」（有：${t.views.map((v) => v.title).join("、")}）` });
		for (const col of Object.keys(p.filter ?? {}))
			if (!filterable(t.name).has(col))
				ctx.addIssue({ code: "custom", path: ["filter", col], message: `${t.title}不能按「${col}」筛（能：${[...filterable(t.name)].join("、")}）` });
	});

/** 一张表能筛的列：主键和给人看的库里的列（算出来的不算） */
export function filterable(table: string): Set<string> {
	const t = TABLES.find((x) => x.name === table);
	if (!t) return new Set();
	return new Set([...t.key, ...Object.keys(t.columns).filter((c) => !t.computed?.[c])]);
}

/** 组件：kind 是放哪（generative 进流，interactive 进右边），description 给 agent 看 */
export const COMPONENTS = {
	markdown: {
		kind: "generative",
		description: "一段话（Markdown，可以有标题、列表、表格、链接）：结论、说明、要人知道的",
		props: z.object({ text: z.string().min(1) }),
	},
	table: {
		kind: "generative",
		description: "一张小表（数据在组件里，几十行以内）：对比、清单。要人改、要现读库里的用 datagrid",
		props: z
			.object({ title, columns: z.array(z.string().min(1)).min(1), rows: z.array(z.array(cell)) })
			.refine((p) => p.rows.every((r) => r.length === p.columns.length), { message: "每一行的格数要和 columns 一样多", path: ["rows"] }),
	},
	chart: {
		kind: "generative",
		description: "一张图：bar 比大小，line、area 看变化，pie 看占比。data 一行一个点，x 是横轴的列，y 是画的列（最多 8 个）",
		props: z
			.object({
				title,
				type: z.enum(["bar", "line", "area", "pie"]),
				data: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).min(1),
				x: z.string(),
				y: z.array(z.string()).min(1).max(8),
			})
			.refine((p) => p.data.some((r) => p.x in r), { message: "data 里没有 x 这一列", path: ["x"] })
			.refine((p) => p.type !== "pie" || p.y.length === 1, { message: "pie 只画一列", path: ["y"] }),
	},
	images: {
		kind: "generative",
		description: "一组图（商品图、货源图、竞品图），可以带说明、点了打开的链接",
		props: z.object({
			title,
			images: z.array(z.object({ url: z.url(), caption: z.string().optional(), link: z.url().optional() })).min(1),
		}),
	},
	datagrid: {
		kind: "interactive",
		description: "库里的一张表（引用，不是数据）：人看现在的行、改人能改的格（照 tables.ts）。同一个会话里同一个引用只开一个 tab",
		props: datagrid,
	},
} as const satisfies Record<string, { kind: "generative" | "interactive"; description: string; props: z.ZodType }>;

export type ComponentName = keyof typeof COMPONENTS;
export type Props<C extends ComponentName> = z.infer<(typeof COMPONENTS)[C]["props"]>;
export type GenerativeName = { [C in ComponentName]: (typeof COMPONENTS)[C]["kind"] extends "generative" ? C : never }[ComponentName];
export type InteractiveName = Exclude<ComponentName, GenerativeName>;
/** 会话里的一个组件 */
export type Item = { [C in ComponentName]: { id: string; component: C; props: Props<C>; at: string } }[ComponentName];
export type Session = { id: string; title: string; createdAt: string; updatedAt: string; items: Item[] };
export type SessionSummary = Omit<Session, "items">;

/** 校验一个组件：{ component, props }；不对说哪一格 */
export function parseItem(input: unknown): { component: ComponentName; props: unknown } {
	const spec = z.object({ component: z.string(), props: z.unknown() }).safeParse(input);
	if (!spec.success) throw new Usage(`组件要写成 { "component": 名字, "props": {…} }（有：${Object.keys(COMPONENTS).join("、")}）`);
	const c = COMPONENTS[spec.data.component as ComponentName];
	if (!c) throw new Usage(`没有组件 ${spec.data.component}（有：${Object.keys(COMPONENTS).join("、")}）`);
	const r = (c.props as z.ZodType).safeParse(spec.data.props ?? {});
	if (!r.success) throw new Usage(`${spec.data.component} 的参数不对：${r.error.issues.map((x) => `${x.path.join(".") || "props"}：${x.message}`).join("；")}`);
	return { component: spec.data.component as ComponentName, props: r.data };
}

/** 给 agent 看的：每个组件的放哪、说明、参数（JSON Schema） */
export const catalog = () =>
	Object.entries(COMPONENTS).map(([name, c]) => ({
		name,
		kind: c.kind,
		description: c.description,
		props: z.toJSONSchema(c.props as z.ZodType, { io: "input", unrepresentable: "any" }),
	}));

const summary = (r: any): SessionSummary => ({
	id: String(r.id),
	title: r.title,
	createdAt: r.created_at.toISOString(),
	updatedAt: r.updated_at.toISOString(),
});

export async function listSessions(sql: Sql): Promise<SessionSummary[]> {
	return (await sql`select * from sessions order by updated_at desc`).map(summary);
}

export async function createSession(sql: Sql, title: string): Promise<SessionSummary> {
	const t = title.trim();
	if (!t) throw new Usage("会话要有标题");
	const [r] = await sql`insert into sessions (title) values (${t}) returning *`;
	return summary(r);
}

export async function deleteSession(sql: Sql, id: string): Promise<void> {
	const r = await sql`delete from sessions where id = ${sessionId(id)} returning id`;
	if (!r.length) throw new Usage(`没有会话 ${id}`);
}

export async function showSession(sql: Sql, id: string): Promise<Session> {
	const [s] = await sql`select * from sessions where id = ${sessionId(id)}`;
	if (!s) throw new Usage(`没有会话 ${id}`);
	const items = await sql`select * from session_items where session_id = ${s.id} order by id`;
	return { ...summary(s), items: items.map((i) => ({ id: String(i.id), component: i.component, props: i.props, at: i.created_at.toISOString() }) as Item) };
}

/** 往会话里放一个组件。interactive 的同一个引用已经开着：换成新的（回原来那个的 id），不另开 */
export async function push(sql: Sql, id: string, input: unknown): Promise<{ id: string; component: ComponentName; replaced: boolean }> {
	const { component, props } = parseItem(input);
	const sid = sessionId(id);
	return sql.begin(async (tx) => {
		const [s] = await tx`select id from sessions where id = ${sid} for update`;
		if (!s) throw new Usage(`没有会话 ${id}`);
		await tx`update sessions set updated_at = now() where id = ${sid}`;
		if (COMPONENTS[component].kind === "interactive") {
			const ref = props as Props<"datagrid">;
			const same = (await tx`select id, props from session_items where session_id = ${sid} and component = ${component}`).find(
				(r) => refKey(r.props) === refKey(ref),
			);
			if (same) {
				await tx`update session_items set props = ${tx.json(props as any)}, created_at = now() where id = ${same.id}`;
				return { id: String(same.id), component, replaced: true };
			}
		}
		const [r] = await tx`insert into session_items (session_id, component, props) values (${sid}, ${component}, ${tx.json(props as any)}) returning id`;
		return { id: String(r!.id), component, replaced: false };
	});
}

/** 人在网页上关掉右边的一个 tab */
export async function closeItem(sql: Sql, item: string): Promise<void> {
	if (!/^\d+$/.test(item)) throw new Usage(`没有这个组件：${item}`);
	await sql`delete from session_items where id = ${item} and component in ${sql(Object.keys(COMPONENTS).filter((c) => COMPONENTS[c as ComponentName].kind === "interactive"))}`;
}

/** 一个 datagrid 引用的样子：表、视图、按列名排好的筛选（jsonb 存进去会重排对象的键，不能直接比 JSON） */
const refKey = (p: Props<"datagrid">) =>
	JSON.stringify([
		p.table,
		p.view ?? null,
		Object.entries(p.filter ?? {})
			.map(([k, v]) => [k, Array.isArray(v) ? v : [v]] as const)
			.sort(([a], [b]) => a.localeCompare(b)),
	]);

function sessionId(id: string): string {
	if (!/^\d+$/.test(id)) throw new Usage(`会话是数字编号：${id}`);
	return id;
}
