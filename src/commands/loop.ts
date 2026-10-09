// 循环的命令：x2 status、x2 sync、x2 propose、x2 approve、x2 run。见 docs/loop.md「agent 开起来做什么」
import { check } from "../check/index.ts";
import type { Todo } from "../check/orders.ts";
import { db } from "../db/index.ts";
import { EXIT, NeedsHuman, Usage } from "../errors.ts";
import { approve, propose } from "../propose.ts";
import { run } from "../run.ts";
import { DOMAINS, sync } from "../sync/index.ts";

const NAMES: Record<string, string> = { orders: "chanboss", skus: "规格", cart: "购物车", purchases: "采购单" };

const ago = (d: Date | null) => {
	if (!d) return "没读过";
	const m = Math.round((Date.now() - d.getTime()) / 60_000);
	return m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
};

const readStdin = async () => {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
};

/** x2 status [--no-sync]：同步过期的数据 → 检查 → 更新收件箱 → 说三件事：数据新不新、收件箱里有什么、agent 能做什么 */
export async function status(args: string[], json: boolean): Promise<void> {
	const sql = await db();
	if (!args.includes("--no-sync")) await sync(sql);
	const { todo } = await check(sql);
	const syncs = await sql`select s.name, s.scope, s.last_ok_at, s.result, s.error, s.blocked, coalesce(sh.account, s.scope) as who from syncs s left join shops sh on sh.shop_id = s.scope order by s.name, s.scope`;
	const inbox = await sql`select key, kind, title, detail, due, approve from inbox where open and (snooze_until is null or snooze_until < now()) order by due nulls last, kind`;
	const snoozed = await sql`select count(*)::int as n from inbox where open and snooze_until >= now()`;
	const [{ n: unknown }] = await sql`select count(*)::int as n from writes where status in ('结果未知', '已提交', '不一致')` as any;
	if (json) {
		return console.log(JSON.stringify({
			data: syncs.map((s) => ({ name: s.name, scope: s.who, lastOk: s.last_ok_at, result: s.result, error: s.error, blocked: s.blocked })),
			inbox: inbox.map((i) => ({ key: i.key, kind: i.kind, title: i.title, detail: i.detail, due: i.due, approve: i.approve })),
			snoozed: snoozed[0]!.n, todo, unknown,
		}));
	}
	const data = syncs.map((s) => `${NAMES[s.name] ?? s.name}${s.scope ? ` ${s.who}` : ""} ${ago(s.last_ok_at)}${s.result === "失败" ? `（这次读不了：${String(s.error).split("\n")[0]}）` : ""}`);
	// 中文字占两格：按显示宽度对齐
	const width = (t: string) => [...t].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
	const pad = (label: string, lines: string[]) => lines.map((l, i) => `${(i === 0 ? label : "")}${" ".repeat(8 - width(i === 0 ? label : ""))}${l}`).join("\n");
	console.log(pad("数据", data.length ? data : ["还没同步过"]));
	console.log(pad("收件箱", inbox.length ? inbox.map((i) => `${i.title}${i.approve ? "（已勾批准，等 x2 run）" : ""}`) : ["空的：现在没有要人做的"]));
	if (snoozed[0]!.n) console.log(pad("", [`另有 ${snoozed[0]!.n} 件推迟了`]));
	console.log(pad("agent", todo.length ? todo.map(todoLine) : ["没有"]));
	console.log(pad("未知", [String(unknown)]));
}

function todoLine(t: Todo): string {
	if (t.kind === "找货源") return `找货源：${t.why}（${t.command}）`;
	if (t.kind === "核清") return `核清：${t.why}（${t.command}）`;
	return `${t.kind}：${t.why}（x2 status --json 的 todo 里有现成的一批，看过交给 x2 propose）`;
}

/** x2 sync [域…] [--shop 店] [--force] */
export async function syncCommand(args: string[], json: boolean): Promise<void> {
	const only = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--shop");
	for (const d of only) if (!(d in DOMAINS)) throw new Usage(`没有 ${d} 这个域（有：${Object.keys(DOMAINS).join("、")}）`);
	const i = args.indexOf("--shop");
	const r = await sync(await db(), { only: only.length ? only : undefined, force: args.includes("--force") || only.length > 0, shop: i >= 0 ? args[i + 1] : undefined });
	if (json) return console.log(JSON.stringify(r));
	for (const x of r) console.log(`${x.name}${x.scope ? ` ${x.scope}` : ""}：${x.result}${x.rows !== undefined ? ` ${x.rows} 行` : ""}${x.error ? `：${x.error}` : ""}`);
	if (r.some((x) => x.blocked)) process.exitCode = EXIT.human;
}

/** x2 propose < 一批.json */
export async function proposeCommand(_args: string[], json: boolean): Promise<void> {
	const text = await readStdin();
	let input: unknown;
	try { input = JSON.parse(text); } catch { throw new Usage("x2 propose 从 stdin 读 JSON：{ title, writes: [{ op, params }] }"); }
	const r = await propose(await db(), input);
	if (json) return console.log(JSON.stringify(r));
	const waiting = r.writes.some((w) => w.status === "待批准");
	console.log(`第 ${r.batch} 批，${r.writes.length} 项：\n${r.writes.map((w) => `  ${w.display}（${w.status}）`).join("\n")}`);
	console.log(waiting ? "收件箱里加了一行「批准」：人勾了以后 x2 run；人在终端里说「批准」，用 x2 approve " + r.batch : "不用批准：x2 run");
}

/** x2 approve <批次> */
export async function approveCommand(args: string[], json: boolean): Promise<void> {
	if (!args[0]) throw new Usage("x2 approve <批次>：替人在收件箱里勾「批准」（人在终端里说了批准时用）");
	const n = await approve(await db(), args[0]);
	console.log(json ? JSON.stringify({ batch: args[0], writes: n }) : `第 ${args[0]} 批勾上了批准（${n} 项）：x2 run 执行`);
}

/** x2 run [--batch N] [--try 操作] */
export async function runCommand(args: string[], json: boolean): Promise<void> {
	const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
	const tryOp = flag("--try");
	const r = await run(await db(), { batch: flag("--batch"), tryOps: tryOp ? [tryOp] : [] });
	if (r.unknown) process.exitCode = EXIT.unknown;
	if (json) console.log(JSON.stringify(r));
	else {
		console.log(r.ran.length ? r.ran.map((x) => `[${x.status}] #${x.id} ${x.op} ${x.display}${x.why ? `：${x.why}` : ""}`).join("\n") : "没有要执行的写入");
		if (r.unknown) console.log("\n结果未知的不会重发：到站点上看一眼，在「写入」里改成已核对或被拒");
	}
	if (r.blocked) throw new NeedsHuman(r.blocked);
}
