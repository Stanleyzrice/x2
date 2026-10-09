// 连库的测试：propose → 批准 → run → 结果未知停下 → 人核清 → 接着做。用 X2_TEST_DATABASE_URL 指的库（会清空它的 public schema），没设就跳过
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { z } from "zod";
import { check } from "../src/check/index.ts";
import { migrate } from "../src/db/index.ts";
import { Usage } from "../src/errors.ts";
import { approve, propose } from "../src/propose.ts";
import { run } from "../src/run.ts";
import type { Submitted, WriteOp } from "../src/site/writes.ts";

const url = process.env.X2_TEST_DATABASE_URL;
const sql = url ? postgres(url, { onnotice: () => {}, max: 2 }) : null;

// 一个假的写操作：n 是对象；outcome 决定提交和读回来的结果
const outcome = new Map<number, { sent: Submitted; done: boolean | null }>();
const submitted: number[] = [];
const fake: WriteOp<{ n: number }> = {
	describe: "试写", params: z.object({ n: z.number() }),
	target: (p) => `t:${p.n}`, key: (p) => `k:${p.n}`, display: (p) => `第 ${p.n} 项`,
	where: (_p, fn) => fn(),
	prepare: async (_sql, p) => ({ params: p, before: { n: p.n } }),
	submit: async (_sql, p) => { submitted.push(p.n); return outcome.get(p.n)?.sent ?? { kind: "done" }; },
	check: async (p) => ({ done: outcome.has(p.n) ? outcome.get(p.n)!.done : true, readback: { n: p.n } }),
};
const ops = { 试写: fake };

before(async () => {
	if (!sql) return;
	await sql.unsafe("drop schema public cascade; create schema public");
	await migrate(sql);
});
after(async () => { await sql?.end(); });

test("写入：批准了才做；结果未知停下这一批，不重发；人核清以后接着做", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const p = await propose(db, { title: "试两项", writes: [{ op: "试写", params: { n: 1 } }, { op: "试写", params: { n: 2 } }] }, ops);
	assert.deepEqual(p.writes.map((w) => w.status), ["待批准", "待批准"]);
	const [inbox] = await db`select kind, open, approve from inbox where key = ${`approve:${p.batch}`}`;
	assert.deepEqual({ ...inbox }, { kind: "批准", open: true, approve: null });

	// 没批准：不做
	assert.equal((await run(db, {}, ops)).ran.length, 0);
	assert.equal(submitted.length, 0);

	// 同一个对象还在等批准：不再准备
	await assert.rejects(propose(db, { title: "再来", writes: [{ op: "试写", params: { n: 1 } }] }, ops), Usage);

	// 批准；第 1 项提交后读回来看不出：结果未知，第 2 项不做
	await approve(db, p.batch);
	outcome.set(1, { sent: { kind: "unknown", why: "超时" }, done: null });
	const r1 = await run(db, {}, ops);
	assert.equal(r1.unknown, true);
	assert.deepEqual(r1.ran.map((x) => [x.display, x.status]), [["第 1 项", "结果未知"], ["第 2 项", "已批准"]]);
	assert.deepEqual(submitted, [1]);

	// 再跑：先核清，还看不出就还是停着，也不重发
	const r2 = await run(db, {}, ops);
	assert.deepEqual(submitted, [1]);
	assert.equal(r2.ran[0]!.status, "结果未知");

	// 读回来看到做成了：已核对，第 2 项接着做
	outcome.set(1, { sent: { kind: "unknown", why: "超时" }, done: true });
	const r3 = await run(db, {}, ops);
	assert.deepEqual(r3.ran.map((x) => [x.display, x.status]), [["第 1 项", "已核对"], ["第 2 项", "已核对"]]);
	assert.deepEqual(submitted, [1, 2]);

	// 这一批没有待批准的了：检查关掉「批准」那一行
	await check(db);
	const [closed] = await db`select open from inbox where key = ${`approve:${p.batch}`}`;
	assert.equal(closed!.open, false);
});

test("写入：取消勾的不做；被拒的记下原因", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const p = await propose(db, { title: "再试两项", writes: [{ op: "试写", params: { n: 3 } }, { op: "试写", params: { n: 4 } }] }, ops);
	await db`update writes set include = false where batch = ${p.batch} and params->>'n' = '3'`;
	outcome.set(4, { sent: { kind: "refused", why: "库存不够" }, done: false });
	await approve(db, p.batch);
	const r = await run(db, {}, ops);
	assert.deepEqual(r.ran.map((x) => [x.display, x.status, x.why]), [["第 4 项", "被拒", "库存不够"]]);
	const rows = await db`select params->>'n' as n, status from writes where batch = ${p.batch} order by id`;
	assert.deepEqual(rows.map((x) => [x.n, x.status]), [["3", "没做"], ["4", "被拒"]]);
});

test("收件箱：每轮重算，只更新不重复；同步读全了才关", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const soon = new Date(Date.now() + 86400_000);
	await db`insert into orders (sn, shop, ship_by, platform_status, chanboss_status, chanboss_id, chanboss_time, items, created_at)
		values ('S1', 'ni1206', ${soon}, '待出货', '已预报', 'c1', 1, ${db.json([{ itemId: "I", modelId: "M", chanbossModelId: "cM", name: "红T", spec: "L", qty: 1, image: "" }])}, now())`;
	await db`insert into syncs (name, scope, max_minutes, result) values ('orders', '', 20, '成功')`;
	await check(db);
	await check(db);
	const open = await db`select key, open from inbox where key = 'late:S1'`;
	assert.deepEqual(open.map((x) => ({ ...x })), [{ key: "late:S1", open: true }]);

	// 订单打包了，但这一轮同步失败：不关
	await db`update orders set chanboss_status = '已打包' where sn = 'S1'`;
	await db`update syncs set result = '失败' where name = 'orders'`;
	await check(db);
	assert.equal((await db`select open from inbox where key = 'late:S1'`)[0]!.open, true);
	// 同步成功了：关
	await db`update syncs set result = '成功' where name = 'orders'`;
	await check(db);
	assert.equal((await db`select open from inbox where key = 'late:S1'`)[0]!.open, false);
});

test("收件箱：人勾「处理好了」就关，以后不再开；「谁做」照 inbox_roles 填", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const soon = new Date(Date.now() + 86400_000);
	await db`insert into orders (sn, shop, ship_by, platform_status, chanboss_status, chanboss_id, chanboss_time, items, created_at)
		values ('S2', 'ni1206', ${soon}, '待出货', '已预报', 'c2', 1, ${db.json([{ itemId: "I", modelId: "M", chanbossModelId: "cM", name: "白T", spec: "L", qty: 1, image: "" }])}, now())`;
	await db`update inbox_roles set role = '采购' where kind = '快到期'`;
	await check(db);
	assert.deepEqual({ ...(await db`select open, role from inbox where key = 'late:S2'`)[0] }, { open: true, role: "采购" });
	await db`update inbox set done = true where key = 'late:S2'`;
	await check(db);
	await check(db);
	assert.equal((await db`select open from inbox where key = 'late:S2'`)[0]!.open, false);
});
