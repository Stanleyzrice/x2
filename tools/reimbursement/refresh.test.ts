// 刷新入口必须等待采集结束，CLI 才能关闭DB；不能在任务未完成时仅返回已接受。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "../../platform/db/index.ts";
import { refreshRecords } from "./index.ts";
import { type RefreshResult, refreshAccount, refreshAll } from "./sync.ts";

test("刷新工具在完整采集结束前不返回，随后交回账号实际结果", async () => {
	let finish!: (result: RefreshResult[]) => void;
	const pending = new Promise<RefreshResult[]>((resolve) => {
		finish = resolve;
	});
	let returned = false;
	const result = refreshRecords(
		{} as Sql,
		{},
		{
			all: () => pending,
			account: async () => {
				throw new Error("全部账号刷新不走单账号入口");
			},
		},
	).then((value) => {
		returned = true;
		return value;
	});
	await Promise.resolve();
	assert.equal(returned, false);
	finish([{ account: "A", status: "succeeded" }]);
	assert.deepEqual(await result, { results: [{ account: "A", status: "succeeded" }] });
});

test("同步失败向调用者报告，不能提前把任务当成已完成", async () => {
	await assert.rejects(
		refreshRecords(
			{} as Sql,
			{},
			{
				all: async () => {
					throw new Error("完整历史读取失败");
				},
				account: async () => {
					throw new Error("未调用");
				},
			},
		),
		/完整历史读取失败/,
	);
});

function reservedFixture(locked = true, held = true) {
	const queries: { text: string; values: unknown[] }[] = [];
	let released = 0;
	const conn = Object.assign(
		async (strings: TemplateStringsArray, ...values: unknown[]) => {
			const text = strings.join("?").trim();
			queries.push({ text, values });
			if (text.includes("pg_try_advisory_lock")) return [{ locked, pid: 42 }];
			if (text.includes("as held")) return [{ held }];
			if (text.startsWith("insert into reimbursement_runs") && !queries.some((q) => q.text.includes("pg_try_advisory_lock")))
				throw new Error("必须先领取session锁，不能直接创建全局running记录");
			return [];
		},
		{
			release: () => released++,
			unsafe: async () => [],
			json: (value: unknown) => value,
		},
	);
	const pool = Object.assign(
		async () => {
			throw new Error("reserved任务不能再向已满的连接池借连接");
		},
		{ reserve: async () => conn },
	);
	return { conn: conn as unknown as Sql, pool: pool as unknown as Sql, queries, released: () => released };
}

test("单账号失败复用调用方reserved session保存错误，不借新连接或释放调用方连接", async () => {
	const fixture = reservedFixture();
	const result = await refreshAccount(fixture.conn, { id: "failure-fixture", name: "fixture" }, async () => {
		throw new Error("fixture采集失败");
	});
	assert.deepEqual(result, { account: "failure-fixture", status: "failed", error: "fixture采集失败" });
	assert.ok(fixture.queries.some((q) => q.text.includes("set status = 'failed'") && q.values.includes("fixture采集失败")));
	assert.equal(fixture.released(), 0);
});

test("从已满连接池领取的账号session失败时，错误落在原session并释放，不再借连接", async () => {
	const fixture = reservedFixture();
	const result = await refreshAccount(fixture.pool, { id: "pool-failure-fixture", name: "fixture" }, async () => {
		throw new Error("fixture失败后连接池不可再借");
	});
	assert.equal(result.status, "failed");
	assert.equal(result.error, "fixture失败后连接池不可再借");
	assert.ok(fixture.queries.some((q) => q.text.includes("set status = 'failed'") && q.values.includes(result.error)));
	assert.equal(fixture.released(), 1);
});

test("全局刷新先拿session锁，记录backend_pid并复用同一连接逐账号运行，最后释放一次", async () => {
	const fixture = reservedFixture();
	const seen: Sql[] = [];
	const result = await refreshAll(fixture.pool, {
		discover: async (sql) => {
			seen.push(sql);
			return [{ id: "A", name: "fixture" }];
		},
		account: async (sql, who) => {
			seen.push(sql);
			return { account: who.id, status: "succeeded" };
		},
	});
	assert.deepEqual(result, [{ account: "A", status: "succeeded" }]);
	assert.deepEqual(seen, [fixture.conn, fixture.conn]);
	assert.ok(fixture.queries.find((q) => q.text.startsWith("insert into reimbursement_runs"))?.text.includes("backend_pid"));
	assert.ok(fixture.queries.some((q) => q.text.includes("pg_advisory_unlock")));
	assert.equal(fixture.released(), 1);
});

test("另一个进程持有全局刷新锁时不发现账号、不新增批次，保留正在执行的任务", async () => {
	const fixture = reservedFixture(false);
	await assert.rejects(
		refreshAll(fixture.pool, {
			discover: async () => {
				throw new Error("不应再次发现账号");
			},
			account: async () => {
				throw new Error("不应重复采集");
			},
		}),
		/其他进程正在刷新/,
	);
	assert.ok(!fixture.queries.some((q) => q.text.startsWith("insert into reimbursement_runs")));
	assert.equal(fixture.released(), 1);
});

test("连接或具体session锁丢失时，账号不发布数据，全局任务也不能记为成功", async () => {
	const account = reservedFixture(true, false);
	const result = await refreshAccount(account.pool, { id: "lost-lock-fixture", name: "fixture" }, async () => []);
	assert.equal(result.status, "failed");
	assert.match(result.error!, /同步锁已丢失/);
	assert.ok(!account.queries.some((q) => q.text.includes("set status = 'succeeded'") || q.text.startsWith("insert into reimbursement_orders")));
	const global = reservedFixture(true, false);
	await assert.rejects(refreshAll(global.pool, { discover: async () => [], account: refreshAccount }), /同步锁已丢失/);
	assert.ok(!global.queries.some((q) => q.text.includes("set status = 'succeeded'")));
	assert.ok(global.queries.some((q) => q.text.includes("set status = 'failed'") && q.values.some((v) => typeof v === "string" && v.includes("同步锁已丢失"))));
});
