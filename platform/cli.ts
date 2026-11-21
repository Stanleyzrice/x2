// 命令行：照注册表（tool.ts）生成。x2 <toolkit> <工具> [--参数 值…] [--json]；平台的工具直接是命令（x2 status）；x2 orders.cart 和 x2 orders cart 一样。
// 参数经工具的 zod 声明校验、转换：--kebab-case 对上 camelCase，单独的 --名字 是开关，值写 - 从 stdin 读（例 JSON）。
// 读一页一页的：默认翻到底，--pages N 只翻 N 页，--cursor 从上次输出的 next 接着翻，输出 { rows, next }。
// 写（业务工具的写工具）：照它排的一批或几批交给写入引擎执行，--try 跑还没在真站点上跑过的写操作；连接器的写工具只经业务工具的写工具调。
// 输出约定：stdout 只放结果（--json 时是一个 JSON 值，出错是 { "error": { "kind", "message" } }）；stderr 只放进度。
// 退出码：0 成功；1 出错；2 用法不对；3 要人处理（登录、滑块、浏览器没连上）；4 写的结果未知（不许重发，先 x2 verify）
import { z } from "zod";
import { close, db } from "./db/index.ts";
import { EXIT, kindOf, Usage } from "./errors.ts";
import { type Tool, type Toolkit, toolkits, type WriteTool } from "./tool.ts";
import { type Outcome, perform } from "./writes.ts";

const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const table = (rows: [string, string][]) => {
	const width = Math.max(0, ...rows.map(([a]) => a.length));
	return rows.map(([a, b]) => `  ${a.padEnd(width)}  ${b}`);
};

/** 命令行帮助用到的 JSON Schema 的几格（placeholder 是 tool.ts 的 meta 加的） */
type Prop = { type?: string; enum?: unknown[]; default?: unknown; description?: string; placeholder?: string };
const schemaOf = (t: Tool) => z.toJSONSchema(t.params, { io: "input", unrepresentable: "any" }) as { properties?: Record<string, Prop>; required?: string[] };
const isWrite = (t: Tool): t is WriteTool => t.kind === "write" && "plan" in t;
const paged = (t: Tool) => t.kind === "read" && "page" in t;
const call = (kit: Toolkit, name: string) => (kit.name ? `x2 ${kit.name} ${name}` : `x2 ${name}`);

const readStdin = async () => {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
};

async function parseFlags(args: string[]): Promise<{ flags: Record<string, string>; bare: Set<string> }> {
	const out: Record<string, string> = {};
	const bare = new Set<string>();
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (!a.startsWith("--")) throw new Usage(`多余的参数：${a}（参数都写成 --名字 值）`);
		const eq = a.indexOf("=");
		if (eq > 0) {
			out[a.slice(2, eq)] = a.slice(eq + 1);
			continue;
		}
		const next = args[i + 1];
		if (next === undefined || (next.startsWith("--") && next !== "--")) {
			out[a.slice(2)] = "true";
			bare.add(a.slice(2));
		} else {
			out[a.slice(2)] = next;
			i++;
		}
	}
	for (const [k, v] of Object.entries(out)) if (v === "-") out[k] = (await readStdin()).trim();
	return { flags: out, bare };
}

export function toolHelp(kit: Toolkit, name: string, t: Tool): string {
	const s = schemaOf(t);
	const required = new Set(s.required ?? []);
	const params = Object.entries(s.properties ?? {}).map(([k, p]): [string, string] => {
		const value = p.placeholder ?? (p.enum ? p.enum.join("|") : (p.type ?? "值"));
		// JSON Schema 里没有 preprocess 过的参数的默认值：从 zod 的声明里取
		const def = (t.params.shape[k] as z.ZodType | undefined)?.def;
		const fallback = def?.type === "default" ? (def as z.core.$ZodDefaultDef).defaultValue : undefined;
		const note = required.has(k) ? "必填" : (p.default ?? fallback) !== undefined ? `默认 ${JSON.stringify(p.default ?? fallback)}` : "可选";
		return [`--${kebab(k)} <${value}>`, `${note}。${p.description ?? ""}`];
	});
	if (kit.scope) params.push([`--${kit.scope.flag} <值>`, `可选。${kit.scope.description}`]);
	if (isWrite(t)) params.push(["--try", "可选。还没在真站点上跑过的写操作（会说要 --try）：和人约好一单，一起跑"]);
	const tail = paged(t)
		? "输出 { rows, next }：默认翻到底；--pages N 只翻 N 页；--cursor <next> 从上次停下的地方接着翻"
		: isWrite(t)
			? "在已获授权的范围内写。每一项先现读、记意图、提交一次并读回；结果未知退出码 4，不重发（x2 verify）"
			: t.kind === "write"
				? "连接器的写工具：只经业务工具的写工具调"
				: "输出一个值";
	return [`${call(kit, name)}：${t.description}`, ...(params.length ? table(params) : ["  （没有参数）"]), tail].join("\n");
}

function kitHelp(kit: Toolkit): string {
	return [
		`x2 ${kit.name} <工具>：${kit.title}。x2 ${kit.name} <工具> --help 看参数`,
		...table(Object.entries(kit.tools).map(([k, t]) => [k, `${t.kind === "write" ? "（写）" : ""}${t.description}`])),
		...(kit.scope ? [`每个工具都收 --${kit.scope.flag}：${kit.scope.description}`] : []),
	].join("\n");
}

function help(): string {
	const kits = toolkits();
	const top = kits.filter((k) => !k.name);
	const group = (kind: Toolkit["kind"], title: string) => {
		const ks = kits.filter((k) => k.kind === kind && k.name);
		return ks.length ? [title, ...table(ks.map((k) => [`x2 ${k.name} <工具>`, k.title]))] : [];
	};
	return [
		"x2 <命令> [--参数 值…] [--json]",
		"平台：",
		...table(top.flatMap((k) => Object.entries(k.tools).map(([n, t]): [string, string] => [`x2 ${n}`, t.description]))),
		...group("platform", "页（网页）："),
		...group("tool", "业务工具（生意的规则写成代码）："),
		...group("site", "站点（经浏览器、用人的登录）："),
		...group("service", "服务（用 API key）："),
		"x2 <toolkit> --help 列工具；x2 <toolkit> <工具> --help 看参数；x2 schema 全部工具的说明和参数（JSON Schema）",
		"退出码：0 成功；1 出错；2 用法不对；3 要人处理（登录、滑块、浏览器没连上）；4 写的结果未知（不许重发，先 x2 verify）",
	].join("\n");
}

export function schema(): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const kit of toolkits()) {
		for (const [name, t] of Object.entries(kit.tools)) {
			const params = schemaOf(t);
			if (kit.scope) params.properties = { ...params.properties, [kit.scope.flag]: { type: "string", description: kit.scope.description } };
			out[kit.name ? `${kit.name}.${name}` : name] = {
				description: t.description,
				kind: t.kind,
				output: paged(t) ? "{ rows, next }" : isWrite(t) ? "写入的结果 { ran, unknown, blocked }" : "一个值",
				...(t.kind === "write" && !isWrite(t) ? { via: "只经业务工具的写工具调" } : {}),
				params,
			};
		}
	}
	return out;
}

export async function runTool(kit: Toolkit, args: string[]): Promise<{ help: string } | { value: unknown; tool: Tool }> {
	const [name, ...rest] = args;
	if (!name || name === "--help" || name === "-h") return { help: kitHelp(kit) };
	const t = Object.hasOwn(kit.tools, name) ? kit.tools[name] : undefined;
	if (!t) throw new Usage(`${kit.name} 没有 ${name} 这个工具\n${kitHelp(kit)}`);
	const usage = () => toolHelp(kit, name, t);
	if (rest.includes("--help") || rest.includes("-h")) return { help: usage() };
	if (t.kind === "write" && !isWrite(t)) throw new Usage(`${call(kit, name)} 是连接器的写工具，只经业务工具的写工具调（x2 schema 看有哪些）`);

	const { flags, bare } = await parseFlags(rest);
	const { pages, try: tryFlag, ...given } = flags;
	const cursor = paged(t) ? given.cursor : undefined;
	if (paged(t)) delete given.cursor;
	if (!paged(t) && pages !== undefined) throw new Usage(`${name} 不是列表，没有 --pages\n${usage()}`);
	if (!isWrite(t) && tryFlag !== undefined) throw new Usage(`${name} 不是写工具，没有 --try\n${usage()}`);
	const scoped = kit.scope ? given[kit.scope.flag] : undefined;
	if (kit.scope) delete given[kit.scope.flag];
	if (scoped === "true") throw new Usage(`--${kit.scope!.flag} 后面写哪一个：${kit.scope!.description}\n${usage()}`);
	const known = new Set(Object.keys(t.params.shape));
	const raw: Record<string, string> = {};
	for (const [k, v] of Object.entries(given)) {
		if (!known.has(camel(k))) throw new Usage(`${name} 没有参数 --${k}\n${usage()}`);
		if (bare.has(k) && !(t.params.shape[camel(k)] as z.ZodType).safeParse(true).success) throw new Usage(`--${k} 后面要写值\n${usage()}`);
		raw[camel(k)] = v;
	}
	const parsed = t.params.safeParse(raw);
	if (!parsed.success)
		throw new Usage(
			`参数不对：\n${parsed.error.issues.map((i) => `  ${i.path.length ? `--${kebab(i.path.join("."))}：` : ""}${i.message}`).join("\n")}\n${usage()}`,
		);
	const limit = pages === undefined ? Infinity : Number(pages);
	if ((limit !== Infinity && !Number.isInteger(limit)) || limit < 1) throw new Usage("--pages 要是正整数");

	const where = <T>(fn: () => Promise<T>) => (scoped === undefined ? fn() : kit.scope!.run(scoped, fn));
	if (isWrite(t)) {
		const sql = await db();
		const batches = await t.plan(sql, parsed.data as never);
		return {
			value: !batches.length && t.replay ? await t.replay(sql, parsed.data as never) : await perform(sql, batches, { try: tryFlag === "true" }),
			tool: t,
		};
	}
	if (!("page" in t)) return { value: await where(() => t.run(parsed.data as never)), tool: t };
	return where(async () => {
		const rows: unknown[] = [];
		let next: string | null = cursor ?? null;
		for (let n = 1; n <= limit; n++) {
			const page = await t.page(parsed.data as never, next);
			rows.push(...page.rows);
			next = page.next;
			if (next !== null || n > 1) console.error(`${kit.name} ${name}：第 ${n} 页，共 ${rows.length} 行`);
			if (next === null) break;
		}
		return { value: { rows, next }, tool: t };
	});
}

export function outcomeText(r: Outcome): string {
	return [
		r.ran.length ? r.ran.map((x) => `[${x.status}] #${x.id} ${x.op} ${x.display}${x.why ? `：${x.why}` : ""}`).join("\n") : "没有要核清、要执行的写入",
		...(r.unknown ? ["", "结果未知的不会重发：请人到站点上看一眼，x2 resolve --id <写入> --status 已核对|被拒"] : []),
		...(r.blocked ? ["", `要人处理：${r.blocked}`] : []),
	].join("\n");
}

export async function main(argv: string[]): Promise<void> {
	const json = argv.includes("--json");
	const [first, ...args] = argv.filter((a) => a !== "--json");
	try {
		if (!first || first === "--help" || first === "-h" || first === "help") return console.log(help());
		const [kitName, toolName] = first.includes(".") ? (first.split(".", 2) as [string, string]) : [first, undefined];
		const kit = toolkits().find((k) => k.name && k.name === kitName);
		const platformKit = toolkits().find((k) => !k.name && first in k.tools);
		if (!kit && !platformKit) throw new Usage(`没有 ${first} 这个命令\n${help()}`);
		const r = kit ? await runTool(kit, toolName ? [toolName, ...args] : args) : await runTool(platformKit!, [first, ...args]);
		if ("help" in r) return console.log(r.help);
		const out = r.value;
		// 写工具的输出是写入引擎的结果（runTool 里 perform 回的）；读工具的输出交回给它自己的 text、exit
		const ran = isWrite(r.tool) ? (out as Outcome) : null;
		if (json) console.log(JSON.stringify(out));
		else if (ran) console.log(outcomeText(ran));
		else console.log(r.tool.text ? r.tool.text(out as never) : JSON.stringify(out, null, 2));
		const exit = ran ? (ran.unknown ? "unknown" : ran.blocked ? "human" : undefined) : r.tool.exit?.(out as never);
		if (exit) process.exitCode = EXIT[exit];
	} catch (e) {
		const kind = kindOf(e);
		const message = (e as Error).message;
		if (json) console.log(JSON.stringify({ error: { kind, message } }));
		else console.error(message);
		process.exitCode = EXIT[kind];
	} finally {
		await close();
	}
}
