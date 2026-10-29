// 写入引擎：一批马上做；结果未知停下这一批、不重发；没核清的同一个对象不再做；被拒的记下原因。连库（test/db.ts）
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { check, skip, sql } from "../test/db.ts";
import { Usage } from "./errors.ts";
import { register } from "./tool.ts";
import { perform, run, type Submitted, type WriteOp } from "./writes.ts";

const outcome = new Map<number, { sent: Submitted; done: boolean | null }>();
const submitted: number[] = [];
const fake: WriteOp<{ n: number }> = {
	describe: "试写",
	params: z.object({ n: z.number() }),
	target: (p) => `t:${p.n}`,
	key: (p) => `k:${p.n}`,
	display: (p) => `第 ${p.n} 项`,
	where: (_sql, _p, fn) => fn(),
	prepare: async (_sql, p) => ({ params: p, before: { n: p.n } }),
	submit: async (_sql, p) => {
		submitted.push(p.n);
		return outcome.get(p.n)?.sent ?? { kind: "done" };
	},
	check: async (p) => ({ done: outcome.has(p.n) ? outcome.get(p.n)!.done : true, readback: { n: p.n } }),
};
const ops = { 试写: fake };
register({ name: "test", title: "试", kind: "skill", tools: {}, writes: ops });
const perform1 = (db: NonNullable<typeof sql>, writes: { op: string; params: unknown }[]) => perform(db, [writes], {}, ops);

test("写入：写工具交的一批马上做；结果未知停下这一批（剩下的未执行），不重发；没核清的同一个对象不再做；x2 verify 核清", {
	skip,
}, async () => {
	const db = sql!;
	outcome.set(1, { sent: { kind: "unknown", why: "超时" }, done: null });
	const r1 = await perform1(db, [
		{ op: "试写", params: { n: 1 } },
		{ op: "试写", params: { n: 2 } },
	]);
	assert.equal(r1.unknown, true);
	assert.deepEqual(
		r1.ran.map((x) => [x.display, x.status]),
		[
			["第 1 项", "结果未知"],
			["第 2 项", "未执行"],
		],
	);
	assert.deepEqual(submitted, [1]);

	await assert.rejects(perform1(db, [{ op: "试写", params: { n: 1 } }]), (e: Error) => e instanceof Usage && /还没核清/.test(e.message));

	assert.equal((await run(db, {}, ops)).ran[0]!.status, "结果未知");
	assert.deepEqual(submitted, [1]);
	const unknown = (await check(db)).reminders.filter((x) => x.kind === "结果未知");
	assert.equal(unknown.length, 1);

	outcome.set(1, { sent: { kind: "unknown", why: "超时" }, done: true });
	assert.deepEqual(
		(await run(db, {}, ops)).ran.map((x) => [x.display, x.status]),
		[["第 1 项", "已核对"]],
	);
	assert.deepEqual(
		(await perform1(db, [{ op: "试写", params: { n: 2 } }])).ran.map((x) => [x.display, x.status]),
		[["第 2 项", "已核对"]],
	);
	assert.deepEqual(submitted, [1, 2]);
	assert.deepEqual(
		(await check(db)).reminders.filter((x) => x.kind === "结果未知"),
		[],
	);
});

test("写入：被拒的记下原因；同一个 key 被拒过的再交加次数", { skip }, async () => {
	const db = sql!;
	outcome.set(4, { sent: { kind: "refused", why: "库存不够" }, done: false });
	const r = await perform1(db, [{ op: "试写", params: { n: 4 } }]);
	assert.deepEqual(
		r.ran.map((x) => [x.display, x.status, x.why]),
		[["第 4 项", "被拒", "库存不够"]],
	);
	outcome.delete(4);
	await perform1(db, [{ op: "试写", params: { n: 4 } }]);
	const rows = await db`select key, status from writes where params->>'n' = '4' order by id`;
	assert.deepEqual(
		rows.map((x) => [x.key, x.status]),
		[
			["k:4", "被拒"],
			["k:4#2", "已核对"],
		],
	);
});
