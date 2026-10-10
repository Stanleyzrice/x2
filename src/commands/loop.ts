// 循环的命令：x2 status、x2 propose、x2 approve、x2 run。见 docs/loop.md「agent 开起来做什么」
import { check } from "../check/index.ts";
import type { Todo } from "../check/orders.ts";
import { db } from "../db/index.ts";
import { EXIT, NeedsHuman, Usage } from "../errors.ts";
import { approve, propose } from "../propose.ts";
import { readAll } from "../read.ts";
import { run } from "../run.ts";

const readStdin = async () => {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
};

/** x2 status：现读站点 → 检查 → 更新收件箱 → 说三件事：这次读到了什么、收件箱里有什么、agent 能做什么 */
export async function status(_args: string[], json: boolean): Promise<void> {
	const sql = await db();
	const reads = await readAll(sql);
	const { todo } = await check(sql, reads);
	const inbox = await sql`select key, kind, title, detail, due, approve from inbox where open and (snooze_until is null or snooze_until < now()) order by due nulls last, kind`;
	const snoozed = await sql`select count(*)::int as n from inbox where open and snooze_until >= now()`;
	const [{ n: unknown }] = await sql`select count(*)::int as n from writes where status in ('结果未知', '已提交', '不一致')` as any;
	const who = (w: string) => reads.accounts.get(w) ?? w;
	if (json) {
		return console.log(JSON.stringify({
			read: reads.results.map((r) => ({ ...r, who: who(r.who) })),
			inbox: inbox.map((i) => ({ key: i.key, kind: i.kind, title: i.title, detail: i.detail, due: i.due, approve: i.approve })),
			snoozed: snoozed[0]!.n, todo, unknown,
		}));
	}
	const data = reads.results.map((r) => `${r.what}${r.what === "订单" || r.what === "采购账号" ? "" : ` ${who(r.who)}`}${r.ok ? (r.rows !== undefined && r.what !== "采购账号" ? ` ${r.rows} 行` : "") : `：读不了（${String(r.error).split("\n")[0]}）`}`);
	// 中文字占两格：按显示宽度对齐
	const width = (t: string) => [...t].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
	const pad = (label: string, lines: string[]) => lines.map((l, i) => `${(i === 0 ? label : "")}${" ".repeat(8 - width(i === 0 ? label : ""))}${l}`).join("\n");
	console.log(pad("读到", data));
	console.log(pad("收件箱", inbox.length ? inbox.map((i) => `${i.title}${i.approve ? "（已勾批准，等 x2 run）" : ""}`) : ["空的：现在没有要人做的"]));
	if (snoozed[0]!.n) console.log(pad("", [`另有 ${snoozed[0]!.n} 件推迟了`]));
	console.log(pad("agent", todo.length ? todo.map(todoLine) : ["没有"]));
	console.log(pad("未知", [String(unknown)]));
	if (reads.results.some((r) => r.blocked)) process.exitCode = EXIT.human;
}

function todoLine(t: Todo): string {
	if (t.kind === "找货源") return `找货源：${t.why}（${t.command}）`;
	if (t.kind === "核清") return `核清：${t.why}（${t.command}）`;
	if (t.kind === "取消预报") return `取消预报：${t.why}`;
	if (t.kind === "做商品稿" || t.kind === "写文案" || t.kind === "Gemini 文字检查" || t.kind === "估重量、国内运费") return `${t.kind}：${t.why}（${t.command}）`;
	return `${t.kind}：${t.why}（x2 status --json 的 todo 里有现成的一批，看过交给 x2 propose）`;
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
	const r = await run(await db(), { batch: flag("--batch"), tryOps: tryOp ? tryOp.split(/[,，]/) : [] });
	if (r.unknown) process.exitCode = EXIT.unknown;
	if (json) console.log(JSON.stringify(r));
	else {
		console.log(r.ran.length ? r.ran.map((x) => `[${x.status}] #${x.id} ${x.op} ${x.display}${x.why ? `：${x.why}` : ""}`).join("\n") : "没有要执行的写入");
		if (r.unknown) console.log("\n结果未知的不会重发：到站点上看一眼，在「写入」里改成已核对或被拒");
	}
	if (r.blocked) throw new NeedsHuman(r.blocked);
}
