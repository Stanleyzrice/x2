// 工具：x2 能做的每一件事都声明成一个工具，按外部系统、按 skill 分成 toolkit，注册进平台（x2.ts 装配），命令行（cli.ts）、x2 schema 都照注册表生成。
// 先例 Composio：平台通用；一个外部系统一个连接器（connectors，site 经浏览器、service 用 API key）；一个 skill 管一类事（skills，例 处理订单、上品、选品）：它的 SKILL.md、代码、表、测试放在一起。
// 一个工具：说明、参数（zod：命令行的 --名字 值经它校验、转换）、怎么做。两种：
// - read：不改外面的系统，直接跑（读站点、服务；读写库里的东西也算）。回一个值（run），或一页一页的行（page：这一页和下一页的 cursor，null 是到底了；
//   命令行按 --pages 翻，输出 { rows, next }。先例 steampipe 的表：参数是 key columns，翻页藏在工具里）
// - write：改外面的系统。skill 的写工具决定做什么、该不该做（业务上的保护），排成一批或几批写入（plan），交至多一次写入（writes.ts）：记意图、只提交一次、读回对账；
//   连接器的写工具只发一次请求、回结果（submit），只经 skill 调
import { z } from "zod";
import { registerSite, type SiteDef } from "./browser/browser.ts";
import { addSchema, type Sql } from "./db/index.ts";
import type { Table } from "./web/tables.ts";
import type { Ran, WriteOp } from "./writes.ts";

export type Page = { rows: unknown[]; next: string | null };

type Common = { description: string; params: z.ZodObject; text?: (out: any) => string; exit?: (out: any) => "human" | "unknown" | undefined };
export type ReadTool = Common & { kind: "read" } & ({ run: (p: any) => Promise<unknown> } | { page: (p: any, cursor: string | null) => Promise<Page> });
export type Planned = { op: string; params: unknown };
export type WriteTool = Common & { kind: "write"; plan: (sql: Sql, p: any) => Promise<Planned[][]> };
export type Sent = { kind: "done"; data?: unknown } | { kind: "refused"; why: string } | { kind: "blocked"; why: string } | { kind: "unknown"; why: string };
export type SubmitTool = Common & { kind: "write"; submit: (p: any) => Promise<Sent> };
export type Tool = ReadTool | WriteTool | SubmitTool;

export type Reminder = { key: string; kind: string; title: string; detail: string; shop: string | null; due: Date | null; link: string | null };
export type Todo = { kind: string; why: string; tool?: string; params?: Record<string, unknown> };
export type Read = { what: string; who: string; ok: boolean; rows?: number; error?: string; blocked?: boolean };
export type Checked = { read: Read[]; human: Reminder[]; todo: Todo[] };

export type Toolkit = {
	name: string;
	title: string;
	kind: "platform" | "site" | "service" | "skill";
	tools: Record<string, Tool>;
	site?: SiteDef;
	scope?: { flag: string; description: string; run: <T>(value: string, fn: () => Promise<T>) => Promise<T> };
	schema?: URL;
	tables?: Table[];
	check?: (sql: Sql) => Promise<Checked>;
	writes?: Record<string, WriteOp>;
	written?: (sql: Sql, ran: Ran[]) => Promise<void>;
};

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
	return kits.find((k) => k.name === kit)?.tools[name];
}

export const writeOps = (): Record<string, WriteOp> => Object.assign({}, ...kits.map((k) => k.writes ?? {}));

const none = z.object({});

export function get<P extends z.ZodObject = typeof none>(description: string, params: P | undefined, run: (p: z.output<P>) => Promise<unknown>): ReadTool {
	return { kind: "read", description, params: params ?? none, run };
}

export function list<P extends z.ZodObject = typeof none>(
	description: string,
	params: P | undefined,
	page: (p: z.output<P>, cursor: string | null) => Promise<Page>,
): ReadTool {
	return { kind: "read", description, params: params ?? none, page };
}

export function byPage<P extends z.ZodObject = typeof none>(
	description: string,
	params: P | undefined,
	fetch: (p: z.output<P>, n: number) => Promise<{ rows: unknown[]; more: boolean }>,
	first = 1,
): ReadTool {
	return list(description, params, async (p, cursor) => {
		const n = cursor === null ? first : Number(cursor);
		const { rows, more } = await fetch(p, n);
		return { rows, next: more && rows.length > 0 ? String(n + 1) : null };
	});
}

export function all<P extends z.ZodObject = typeof none>(description: string, params: P | undefined, fetch: (p: z.output<P>) => Promise<unknown[]>): ReadTool {
	return list(description, params, async (p) => ({ rows: await fetch(p), next: null }));
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
