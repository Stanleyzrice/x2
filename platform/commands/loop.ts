// 循环的命令：x2 status、x2 do、x2 verify、x2 resolve、x2 handled。

import type { Reminder, Todo } from "../../skills/orders/check.ts";
import { readAll } from "../../skills/orders/read.ts";
import { addBatch } from "../batch.ts";
import { db } from "../db/index.ts";
import { EXIT, NeedsHuman, Usage } from "../errors.ts";
import { check } from "../status.ts";
import { type Outcome, run } from "../writes.ts";

const readStdin = async () => {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
};

/** x2 status：现读站点 → 检查 → 说三件事：这次读到了什么、要人做的、agent 能做的 */
export async function status(_args: string[], json: boolean): Promise<void> {
	const sql = await db();
	const reads = await readAll(sql);
	const { todo, reminders } = await check(sql, reads);
	const due = (r: Reminder) => r.due?.getTime() ?? Number.POSITIVE_INFINITY;
	const human = [...reminders].sort((a, b) => due(a) - due(b) || a.kind.localeCompare(b.kind));
	const who = (w: string) => reads.accounts.get(w) ?? w;
	if (json) {
		console.log(JSON.stringify({ read: reads.results.map((r) => ({ ...r, who: who(r.who) })), human, todo }));
	} else {
		const data = reads.results.map(
			(r) =>
				`${r.what}${r.what === "订单" || r.what === "采购账号" ? "" : ` ${who(r.who)}`}${r.ok ? (r.rows !== undefined && r.what !== "采购账号" ? ` ${r.rows} 行` : "") : `：读不了（${String(r.error).split("\n")[0]}）`}`,
		);
		// 中文字占两格：按显示宽度对齐
		const width = (t: string) => [...t].reduce((n, c) => n + (c.charCodeAt(0) > 0xff ? 2 : 1), 0);
		const pad = (label: string, lines: string[]) => lines.map((l, i) => `${i === 0 ? label : ""}${" ".repeat(8 - width(i === 0 ? label : ""))}${l}`).join("\n");
		console.log(pad("读到", data));
		console.log(pad("人", human.length ? human.map((r) => r.title) : ["现在没有要人做的"]));
		console.log(pad("agent", todo.length ? todo.map(todoLine) : ["没有"]));
	}
	if (reads.results.some((r) => r.blocked)) process.exitCode = EXIT.human;
}

function todoLine(t: Todo): string {
	if ("batch" in t) return `${t.kind}：${t.why}（x2 status --json 的 todo 里有现成的一批：给人看过、人同意了交给 x2 do）`;
	if (!("command" in t)) return `${t.kind}：${t.why}`;
	return `${t.kind}：${t.why}（${t.command}）`;
}

/** 写入的结果，一行一项；结果未知的退出码 4，要人处理的抛 NeedsHuman */
export function report(r: Outcome, json: boolean): void {
	if (r.unknown) process.exitCode = EXIT.unknown;
	if (json) console.log(JSON.stringify(r));
	else {
		console.log(
			r.ran.length ? r.ran.map((x) => `[${x.status}] #${x.id} ${x.op} ${x.display}${x.why ? `：${x.why}` : ""}`).join("\n") : "没有要核清、要执行的写入",
		);
		if (r.unknown) console.log("\n结果未知的不会重发：请人到站点上看一眼，x2 resolve <写入> 已核对|被拒");
	}
	if (r.blocked) throw new NeedsHuman(r.blocked);
}

const flag = (args: string[], name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

/** x2 do [--try 操作] < 一批.json：人在终端里同意了，记进库、马上执行 */
export async function doCommand(args: string[], json: boolean): Promise<void> {
	const text = await readStdin();
	let input: unknown;
	try {
		input = JSON.parse(text);
	} catch {
		throw new Usage("x2 do 从 stdin 读 JSON：{ title, writes: [{ op, params }] }（人在终端里同意了才用）");
	}
	const sql = await db();
	const batch = await addBatch(sql, input);
	const tryOp = flag(args, "--try");
	report(await run(sql, { batch, tryOps: tryOp ? tryOp.split(/[,，]/) : [] }), json);
}

/** x2 verify：读回来核清已提交、结果未知的写入 */
export async function verifyCommand(_args: string[], json: boolean): Promise<void> {
	report(await run(await db()), json);
}

/** x2 resolve <写入> 已核对|被拒：人到站点上看过结果未知、不一致的写入 */
export async function resolveCommand(args: string[], json: boolean): Promise<void> {
	const [id, status] = args;
	if (!id || !/^\d+$/.test(id) || (status !== "已核对" && status !== "被拒"))
		throw new Usage("x2 resolve <写入> 已核对|被拒（人到站点上看过了才用：做成了是已核对，没做成是被拒）");
	const rows =
		await (await db())`update writes set status = ${status}, finished_at = now() where id = ${id} and status in ('结果未知', '不一致', '已提交') returning id::text, op, display`;
	if (!rows.length) throw new Usage(`写入 #${id} 不是结果未知、不一致`);
	const w = rows[0]!;
	console.log(json ? JSON.stringify({ id, status }) : `#${id} ${w.op} ${w.display ?? ""}：${status}`);
}

/** x2 handled <key…> [--note 说明]：x2 看不到结果的事，人做完了，不再提醒 */
export async function handledCommand(args: string[], json: boolean): Promise<void> {
	const note = flag(args, "--note") ?? null;
	const keys = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--note");
	if (!keys.length) throw new Usage("x2 handled <key…> [--note 说明]（key 在 x2 status --json 的 human 里；人说做完了才用）");
	const sql = await db();
	for (const key of keys) await sql`insert into handled (key, note) values (${key}, ${note}) on conflict (key) do update set note = excluded.note, at = now()`;
	console.log(json ? JSON.stringify({ keys }) : `不再提醒：${keys.join("、")}`);
}
