// 调度按业务注册的当地自然日判定，午夜、整点和不同时区不会错算。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "./db/index.ts";
import { dueDay, runDueJobs } from "./jobs.ts";

function fixture() {
	const rows = new Map<string, { status: string; pid: number | null }>();
	const locks = new Map<string, number>();
	let serial = 0,
		released = 0;
	const sql = Object.assign(
		() => {
			throw new Error("任务必须复用持锁连接，不能额外借用连接");
		},
		{
			reserve: async () => {
				const pid = ++serial;
				const conn = Object.assign(
					async (strings: TemplateStringsArray, ...values: unknown[]) => {
						const query = strings.join("?");
						if (query.includes("pg_try_advisory_lock")) {
							const key = String(values[0]),
								locked = !locks.has(key);
							if (locked) locks.set(key, pid);
							return [{ locked, pid }];
						}
						if (query.includes("insert into job_runs")) {
							const key = `${values[0]}:${values[1]}`,
								previous = rows.get(key);
							if (previous && previous.status !== "running") return [];
							rows.set(key, { status: "running", pid });
							return [{ name: values[0] }];
						}
						if (query.includes("update job_runs")) {
							const status = query.includes("'completed'") ? "completed" : "failed";
							const start = status === "completed" ? 0 : 1;
							const key = `${values[start]}:${values[start + 1]}`,
								previous = rows.get(key);
							if (previous?.pid === pid && locks.get(String(values.at(-1))) === pid) previous.status = status;
							return [];
						}
						if (query.includes("pg_advisory_unlock")) {
							const key = String(values[0]);
							if (locks.get(key) === pid) locks.delete(key);
							return [];
						}
						throw new Error(`未处理的任务查询：${query}`);
					},
					{
						release: () => {
							released++;
						},
					},
				);
				return conn;
			},
		},
	) as unknown as Sql;
	return { sql, rows, locks, released: () => released };
}

test("Asia/Shanghai 每天20点到期，UTC日期与当地日期分开", () => {
	const j = { hour: 20, timeZone: "Asia/Shanghai" };
	assert.equal(dueDay(j, new Date("2026-11-01T11:59:59Z")), null);
	assert.equal(dueDay(j, new Date("2026-11-01T12:00:00Z")), "2026-11-01");
	assert.equal(dueDay(j, new Date("2026-11-01T15:59:59Z")), "2026-11-01");
	assert.equal(dueDay(j, new Date("2026-11-01T16:00:00Z")), null);
});

test("当天running失去持锁进程后可重领，已完成或明确失败的不重复执行", async () => {
	const f = fixture();
	const job = {
		name: "refresh",
		hour: 20,
		timeZone: "Asia/Shanghai",
		run: async () => {
			calls++;
		},
	};
	let calls = 0;
	f.rows.set("refresh:2026-11-01", { status: "running", pid: 99 });
	await runDueJobs(f.sql, [job], new Date("2026-11-01T12:00:00Z"));
	assert.equal(calls, 1);
	assert.equal(f.rows.get("refresh:2026-11-01")?.status, "completed");
	await runDueJobs(f.sql, [job], new Date("2026-11-01T13:00:00Z"));
	assert.equal(calls, 1);
	f.rows.set("refresh:2026-11-02", { status: "failed", pid: 99 });
	await runDueJobs(f.sql, [job], new Date("2026-11-02T12:00:00Z"));
	assert.equal(calls, 1);
	assert.equal(f.locks.size, 0);
});

test("仍持有当天任务锁的进程不会被另一进程重领，任务复用连接并最终释放", async () => {
	const f = fixture();
	let finish!: () => void,
		started!: () => void,
		calls = 0;
	const ready = new Promise<void>((ok) => {
		started = ok;
	});
	const wait = new Promise<void>((ok) => {
		finish = ok;
	});
	const job = {
		name: "refresh",
		hour: 20,
		timeZone: "Asia/Shanghai",
		run: async (conn: Sql) => {
			assert.ok("release" in conn);
			calls++;
			started();
			await wait;
		},
	};
	const first = runDueJobs(f.sql, [job], new Date("2026-11-01T12:00:00Z"));
	await ready;
	await runDueJobs(f.sql, [job], new Date("2026-11-01T12:01:00Z"));
	assert.equal(calls, 1);
	finish();
	await first;
	assert.equal(f.rows.get("refresh:2026-11-01")?.status, "completed");
	assert.equal(f.released(), 2);
	assert.equal(f.locks.size, 0);
});

test("任务结束前失去锁或换了执行人，旧执行者不能覆盖新的running记录", async () => {
	const f = fixture();
	const job = {
		name: "refresh",
		hour: 20,
		timeZone: "Asia/Shanghai",
		run: async () => {
			for (const key of f.locks.keys()) f.locks.set(key, 99);
			f.rows.set("refresh:2026-11-01", { status: "running", pid: 99 });
		},
	};
	await runDueJobs(f.sql, [job], new Date("2026-11-01T12:00:00Z"));
	assert.deepEqual(f.rows.get("refresh:2026-11-01"), { status: "running", pid: 99 });
	assert.equal(f.released(), 1);
});

test("任务明确失败后释放会话锁，不重复当日失败任务", async (t) => {
	t.mock.method(console, "error", () => {});
	const f = fixture();
	let calls = 0;
	const job = {
		name: "refresh",
		hour: 20,
		timeZone: "Asia/Shanghai",
		run: async () => {
			calls++;
			throw new Error("需要人工恢复登录");
		},
	};
	await runDueJobs(f.sql, [job], new Date("2026-11-01T12:00:00Z"));
	assert.equal(f.rows.get("refresh:2026-11-01")?.status, "failed");
	assert.equal(f.locks.size, 0);
	await runDueJobs(f.sql, [job], new Date("2026-11-01T12:01:00Z"));
	assert.equal(calls, 1);
	assert.equal(f.released(), 2);
});
