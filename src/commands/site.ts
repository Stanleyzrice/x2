// x2 <站点> <操作> [--参数 值…]：站点的读操作的通用入口（声明在 site/op.ts）。
// 参数经操作的 zod 声明校验、转换；list 默认翻到底，--pages N 只翻 N 页，--cursor 从上次输出的 next 接着翻，输出 { rows, next }。
// x2 <站点> 列出操作，x2 <站点> <操作> --help 列出参数，x2 schema 输出全部操作的参数（JSON Schema）
import { z } from "zod";
import { Usage } from "../errors.ts";
import { ops as alibaba } from "../site/1688.ts";
import { ops as chanboss } from "../site/chanboss.ts";
import type { Op, Ops } from "../site/op.ts";
import { ops as shopee } from "../site/shopee/ops.ts";
import { ops as zhixia } from "../site/zhixia.ts";

export type Site = { describe: string; ops: Ops };

// Map：保持这个顺序（普通对象会把 "1688" 这种数字键排到最前）
export const sites = new Map<string, Site>([
	["shopee", { describe: "Shopee 卖家中心（台湾站）", ops: shopee }],
	["1688", { describe: "1688", ops: alibaba }],
	["zhixia", { describe: "知虾（Shopee 的数据平台；限流：每次隔 6～10 秒、每小时 200 次）", ops: zhixia }],
	["chanboss", { describe: "仓老板（货代）", ops: chanboss }],
]);

const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const table = (rows: [string, string][]) => {
	const width = Math.max(0, ...rows.map(([a]) => a.length));
	return rows.map(([a, b]) => `  ${a.padEnd(width)}  ${b}`);
};

const schemaOf = (op: Op) => z.toJSONSchema(op.params, { io: "input", unrepresentable: "any" }) as { properties?: Record<string, any>; required?: string[] };

/** --名字 值、--名字=值、单独的 --名字（开关） */
function parseFlags(args: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (!a.startsWith("--")) throw new Usage(`多余的参数：${a}（参数都写成 --名字 值）`);
		const eq = a.indexOf("=");
		if (eq > 0) { out[a.slice(2, eq)] = a.slice(eq + 1); continue; }
		const next = args[i + 1];
		if (next === undefined || next.startsWith("--")) out[a.slice(2)] = "true";
		else { out[a.slice(2)] = next; i++; }
	}
	return out;
}

export function opHelp(site: string, name: string, op: Op): string {
	const s = schemaOf(op);
	const required = new Set(s.required ?? []);
	const params = Object.entries(s.properties ?? {}).map(([k, p]): [string, string] => {
		const value = p.placeholder ?? (p.enum ? p.enum.join("|") : p.type ?? "值");
		// JSON Schema 里没有 preprocess 过的参数的默认值：从 zod 的声明里取
		const def = (op.params.shape[k] as any)?.def;
		const fallback = def?.type === "default" ? def.defaultValue : undefined;
		const note = required.has(k) ? "必填" : (p.default ?? fallback) !== undefined ? `默认 ${JSON.stringify(p.default ?? fallback)}` : "可选";
		return [`--${kebab(k)} <${value}>`, `${note}。${p.description ?? ""}`];
	});
	const tail = op.kind === "list" ? "输出 { rows, next }：默认翻到底；--pages N 只翻 N 页；--cursor <next> 从上次停下的地方接着翻" : "输出一个值";
	return [`x2 ${site} ${name}：${op.describe}`, ...(params.length ? table(params) : ["  （没有参数）"]), tail].join("\n");
}

function siteHelp(name: string, site: Site): string {
	return [`x2 ${name} <操作>：${site.describe}。只读；x2 ${name} <操作> --help 看参数`, ...table(Object.entries(site.ops).map(([k, op]) => [k, op.describe]))].join("\n");
}

/** 跑一个站点的一个操作，回要输出的值；是帮助时回帮助文本 */
export async function runOp(name: string, site: Site, args: string[]): Promise<{ help: string } | { value: unknown }> {
	const [opName, ...rest] = args;
	if (!opName || opName === "--help" || opName === "-h") return { help: siteHelp(name, site) };
	const op = site.ops[opName];
	if (!op) throw new Usage(`${name} 没有 ${opName} 这个操作\n${siteHelp(name, site)}`);
	if (rest.includes("--help") || rest.includes("-h")) return { help: opHelp(name, opName, op) };

	const { pages, cursor, ...given } = parseFlags(rest);
	if (op.kind === "get" && (pages !== undefined || cursor !== undefined)) throw new Usage(`${opName} 不是列表，没有 --pages、--cursor`);
	const known = new Set(Object.keys(op.params.shape));
	const raw: Record<string, string> = {};
	for (const [k, v] of Object.entries(given)) {
		if (!known.has(camel(k))) throw new Usage(`${opName} 没有参数 --${k}\n${opHelp(name, opName, op)}`);
		raw[camel(k)] = v;
	}
	const parsed = op.params.safeParse(raw);
	if (!parsed.success) throw new Usage(`参数不对：\n${parsed.error.issues.map((i) => `  --${kebab(i.path.join("."))}：${i.message}`).join("\n")}\n${opHelp(name, opName, op)}`);

	if (op.kind === "get") return { value: await op.run(parsed.data) };
	const limit = pages === undefined ? Infinity : Number(pages);
	if ((limit !== Infinity && !Number.isInteger(limit)) || limit < 1) throw new Usage("--pages 要是正整数");
	const rows: unknown[] = [];
	let next: string | null = cursor ?? null;
	for (let n = 1; n <= limit; n++) {
		const page = await op.run(parsed.data, next);
		rows.push(...page.rows);
		next = page.next;
		if (next !== null || n > 1) console.error(`${name} ${opName}：第 ${n} 页，共 ${rows.length} 行`);
		if (next === null) break;
	}
	return { value: { rows, next } };
}

export async function site(name: string, args: string[], json: boolean): Promise<void> {
	const r = await runOp(name, sites.get(name)!, args);
	if ("help" in r) return console.log(r.help);
	console.log(json ? JSON.stringify(r.value) : JSON.stringify(r.value, null, 2));
}

/** x2 schema：全部站点操作的说明和参数（JSON Schema），给 agent 读 */
export function schema(): void {
	const out: Record<string, unknown> = {};
	for (const [s, { ops }] of sites) {
		for (const [name, op] of Object.entries(ops)) {
			out[`${s} ${name}`] = { describe: op.describe, kind: op.kind, output: op.kind === "list" ? "{ rows, next }" : "一个值", params: schemaOf(op) };
		}
	}
	console.log(JSON.stringify(out, null, 2));
}

export function sitesHelp(): string[] {
	return table([...sites].map(([k, s]) => [`x2 ${k} <操作>`, s.describe]));
}
