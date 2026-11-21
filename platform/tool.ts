// 工具：x2 能做的每一件事都声明成一个工具，按外部系统、按一类业务分成 toolkit，注册进平台（x2.ts 装配），命令行（cli.ts）、x2 schema 都照注册表生成。
// 先例 Composio：平台通用；一个外部系统一个连接器（connectors，site 经浏览器、service 用 API key）；一类业务一个业务工具（tools，例 订单、上品、选品）：它的代码、表、测试放在一起；教 agent 怎么用的 SKILL.md 在 skills/<名字>/，只有 md。
// 一个工具：说明、参数（zod：命令行的 --名字 值经它校验、转换）、怎么做。两种：
// - read：不改外面的系统，直接跑（读站点、服务；读写库里的东西也算）。回一个值（run），或一页一页的行（page：这一页和下一页的 cursor，null 是到底了；
//   命令行按 --pages 翻，输出 { rows, next }。先例 steampipe 的表：参数是 key columns，翻页藏在工具里）
// - write：改外面的系统。业务工具的写工具决定做什么、该不该做（业务上的保护），排成一批或几批写入（plan），交至多一次写入（writes.ts）：记意图、只提交一次、读回对账；
//   连接器的写工具只发一次请求、回结果（submit），只经业务工具调
import { z } from "zod";
import { registerSite, type SiteDef } from "./browser/browser.ts";
import { addSchema, type Sql } from "./db/index.ts";
import { Usage } from "./errors.ts";
import type { Table } from "./web/tables.ts";
import type { Outcome, Ran, WriteOp } from "./writes.ts";

export type Page<R = unknown> = { rows: R[]; next: string | null };

/** 命令行怎么显示一个工具的输出（不给是 JSON）、什么样的输出算出错、要人处理、结果未知（退出码） */
export type Show<O> = { text?: (out: O) => string; exit?: (out: O) => "error" | "human" | "unknown" | undefined };
// 注册表里放各种工具，参数、输出各不一样：存起来时函数的参数写成 never（什么都传不进），
// 只有照这个工具自己的 zod 解析过的参数、它自己的输出才传回给它（cli.ts、invoke 在那几处写 as never）。定义工具用下面的 get、list、write、submit，参数和输出的类型照 zod、照函数推出来
type Common = { description: string; params: z.ZodObject } & Show<never>;
type ToolSource = "cli" | "web";
export type ReadTool = Common & { kind: "read" } & (
		| {
				run: (p: never, source?: ToolSource) => Promise<unknown>;
		  }
		| { page: (p: never, cursor: string | null) => Promise<Page> }
	);
export type Planned = { op: string; params: unknown };
export type WriteTool = Common & { kind: "write"; plan: (sql: Sql, p: never) => Promise<Planned[][]>; replay?: (sql: Sql, p: never) => Promise<Outcome> };
export type Sent = { kind: "done"; data?: unknown } | { kind: "refused"; why: string } | { kind: "blocked"; why: string } | { kind: "unknown"; why: string };
export type SubmitTool = Common & { kind: "write"; submit: (p: never) => Promise<Sent> };
export type Tool = ReadTool | WriteTool | SubmitTool;

export type Reminder = { key: string; kind: string; title: string; detail: string; shop: string | null; due: Date | null; link: string | null };
export type Todo = { kind: string; why: string; tool?: string; params?: Record<string, unknown> };
export type Read = { what: string; who: string; ok: boolean; rows?: number; error?: string; blocked?: boolean };
export type Checked = { read: Read[]; human: Reminder[]; todo: Todo[] };

export type Workspace = { key: string; title: string; component: string; props: Record<string, unknown>; group?: string; icon?: string; order?: number };
export type Job = { name: string; hour: number; timeZone: string; run: (sql: Sql) => Promise<unknown> };

type ToolkitInfo = {
	name: string;
	title: string;
	workspaces?: Workspace[];
	jobs?: Job[];
	site?: SiteDef;
	scope?: { flag: string; description: string; run: <T>(value: string, fn: () => Promise<T>) => Promise<T> };
	schema?: URL;
	tables?: Table[];
	check?: (sql: Sql) => Promise<Checked>;
};

export type Toolkit = ToolkitInfo &
	(
		| {
				kind: "platform" | "tool";
				tools: Record<string, ReadTool | WriteTool>;
				writes?: Record<string, WriteOp>;
				written?: (sql: Sql, ran: Ran[]) => Promise<void>;
		  }
		| { kind: "site" | "service"; tools: Record<string, ReadTool | SubmitTool>; writes?: never; written?: never }
	);

const kits: Toolkit[] = [];

export function register(...add: Toolkit[]): void {
	for (const k of add) {
		if (kits.some((x) => x.name === k.name)) continue;
		kits.push(k);
		if (k.site) registerSite(k.site);
		if (k.schema) addSchema(k.schema);
	}
}
export const toolkits = (): readonly Toolkit[] => kits;

export function findTool(id: string): Tool | undefined {
	const dot = id.indexOf(".");
	const [kit, name] = dot < 0 ? ["", id] : [id.slice(0, dot), id.slice(dot + 1)];
	const tools = kits.find((k) => k.name === kit)?.tools;
	return tools && Object.hasOwn(tools, name) ? tools[name] : undefined;
}

/** 网页按组件登记的名称调用工具，业务代码可直接引用已知工具。 */
export async function invoke(id: string, input: Record<string, unknown>, source?: ToolSource): Promise<unknown> {
	const t = findTool(id);
	if (!t) throw new Usage(`没有工具 ${id}`);
	if (t.kind !== "read") throw new Usage(`${id} 是写工具，网页还不调写工具`);
	return runReadTool(id, t, input, source);
}

/** 复用工具参数校验，分页工具只读第一页。 */
export async function runReadTool(id: string, t: ReadTool, input: Record<string, unknown>, source?: ToolSource): Promise<unknown> {
	const p = t.params.safeParse(input);
	if (!p.success) throw new Usage(`${id} 的参数不对：${p.error.issues.map((x) => `${x.path.join(".")}：${x.message}`).join("；")}`);
	return "run" in t ? t.run(p.data as never, source) : t.page(p.data as never, null);
}

export const writeOps = (): Record<string, WriteOp> => Object.assign({}, ...kits.map((k) => k.writes ?? {}));

const none = z.object({});

export function get<P extends z.ZodObject = typeof none, O = unknown>(
	description: string,
	params: P | undefined,
	run: (p: z.output<P>, source: ToolSource) => Promise<O>,
	show: Show<O> = {},
): ReadTool {
	return { kind: "read", description, params: params ?? none, run: (p, source = "cli") => run(p, source), ...show };
}

export function list<P extends z.ZodObject = typeof none, R = unknown>(
	description: string,
	params: P | undefined,
	page: (p: z.output<P>, cursor: string | null) => Promise<Page<R>>,
	show: Show<Page<R>> = {},
): ReadTool {
	return { kind: "read", description, params: params ?? none, page, ...show };
}

export function byPage<P extends z.ZodObject = typeof none, R = unknown>(
	description: string,
	params: P | undefined,
	fetch: (p: z.output<P>, n: number) => Promise<{ rows: R[]; more: boolean }>,
	first = 1,
	show: Show<Page<R>> = {},
): ReadTool {
	return list(
		description,
		params,
		async (p, cursor) => {
			const n = cursor === null ? first : Number(cursor);
			const { rows, more } = await fetch(p, n);
			return { rows, next: more && rows.length > 0 ? String(n + 1) : null };
		},
		show,
	);
}

export function all<P extends z.ZodObject = typeof none, R = unknown>(
	description: string,
	params: P | undefined,
	fetch: (p: z.output<P>) => Promise<R[]>,
	show: Show<Page<R>> = {},
): ReadTool {
	return list(description, params, async (p) => ({ rows: await fetch(p), next: null }), show);
}

/** 业务工具的写工具：照参数排成一批或几批写入，交给写入引擎（writes.ts）；命令行显示引擎的结果 */
export function write<P extends z.ZodObject>(description: string, params: P, plan: (sql: Sql, p: z.output<P>) => Promise<Planned[][]>): WriteTool {
	return { kind: "write", description, params, plan };
}

/** 连接器的写工具：只发一次请求、回结果，只经业务工具的写操作调（回的对象保留参数的类型，业务工具直接调它的 submit） */
export function submit<P extends z.ZodObject>(description: string, params: P, send: (p: z.output<P>) => Promise<Sent>) {
	return { kind: "write" as const, description, params, submit: send } satisfies SubmitTool;
}

/** 字符串（id 一律是字符串：Shopee、1688 的订单号超过 JS 数字的精度） */
export const str = (describe: string) => z.string().min(1).describe(describe);
export const num = (describe: string) => z.coerce.number().describe(describe);
export const flag = (describe: string) => z.preprocess((v) => (v === "false" ? false : v === "true" ? true : v), z.boolean()).describe(describe);
export const strs = (describe: string) =>
	z
		.preprocess(
			(v) =>
				typeof v === "string"
					? v
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean)
					: v,
			z.array(z.string()).min(1),
		)
		.meta({ description: describe, placeholder: "a,b,…" });
export const ints = (describe: string) =>
	z
		.preprocess(
			(v) =>
				typeof v === "string"
					? v
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean)
							.map(Number)
					: v,
			z.array(z.number().int()),
		)
		.meta({ description: describe, placeholder: "1,2,…" });

export const parseJson = (v: unknown) => {
	if (typeof v !== "string") return v;
	try {
		return JSON.parse(v);
	} catch {
		return v;
	}
};

const DAY = 86400,
	TW = 8 * 3600;
export const day = (describe: string, end = false) =>
	z
		.preprocess((v) => {
			if (typeof v !== "string") return v;
			if (/^\d+$/.test(v)) return Number(v);
			if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
			const start = Date.parse(`${v}T00:00:00Z`) / 1000 - TW;
			return end ? start + DAY - 1 : start;
		}, z.number().int())
		.meta({ description: `${describe}（台湾时间；也可以给秒）`, placeholder: "YYYY-MM-DD" });
