// 用假连接和可控初始化验证失败后恢复、并发共享及旧连接代不影响新代，不访问真实数据库。
import assert from "node:assert/strict";
import { test } from "node:test";
import { databaseLifecycle } from "./lifecycle.ts";

test("初始化失败关闭失败代，下一次调用可恢复且保留原错误", async () => {
	const original = new Error("CONNECT_TIMEOUT");
	let created = 0;
	const disposed: number[] = [];
	const db = databaseLifecycle({
		create: () => ({ id: ++created }),
		initialize: async (client) => {
			if (client.id === 1) throw original;
		},
		dispose: async (client) => {
			disposed.push(client.id);
		},
	});
	await assert.rejects(db.get(), (error) => error === original);
	assert.equal(db.active(), false);
	assert.deepEqual(disposed, [1]);
	assert.equal((await db.get()).id, 2);
	assert.equal((await db.get()).id, 2);
	assert.equal(created, 2);
	await db.close();
	assert.deepEqual(disposed, [1, 2]);
});

test("并发调用共享一次初始化和同一失败，不耗尽新连接", async () => {
	const initialization = Promise.withResolvers<void>();
	const original = new Error("temporary failure");
	let created = 0;
	let initialized = 0;
	let disposed = 0;
	const db = databaseLifecycle({
		create: () => ++created,
		initialize: async () => {
			initialized++;
			await initialization.promise;
		},
		dispose: async () => {
			disposed++;
		},
	});
	const first = db.get();
	const second = db.get();
	assert.equal(first, second);
	await Promise.resolve();
	assert.equal(created, 1);
	assert.equal(initialized, 1);
	const observed = Promise.all([assert.rejects(first, (error) => error === original), assert.rejects(second, (error) => error === original)]);
	initialization.reject(original);
	await observed;
	assert.equal(disposed, 1);
	assert.equal(db.active(), false);
});

test("旧代关闭和延迟失败不能清掉新代，也不会重复关闭旧代", async () => {
	const oldInitialization = Promise.withResolvers<void>();
	const oldDisposal = Promise.withResolvers<void>();
	const original = new Error("old generation failed late");
	let created = 0;
	const disposed: number[] = [];
	const db = databaseLifecycle({
		create: () => ({ id: ++created }),
		initialize: async (client) => {
			if (client.id === 1) await oldInitialization.promise;
		},
		dispose: async (client) => {
			disposed.push(client.id);
			if (client.id === 1) await oldDisposal.promise;
		},
	});
	const old = db.get();
	const observed = assert.rejects(old, (error) => error === original);
	await Promise.resolve();
	const closing = db.close();
	const next = await db.get();
	assert.equal(next.id, 2);
	oldInitialization.reject(original);
	await Promise.resolve();
	assert.equal(await db.get(), next);
	oldDisposal.resolve();
	await Promise.all([closing, observed]);
	assert.equal(await db.get(), next);
	assert.equal(created, 2);
	assert.deepEqual(disposed, [1]);
	await db.close();
	assert.deepEqual(disposed, [1, 2]);
});

test("失败代清理报错不遮住初始化原错误", async () => {
	const original = new Error("initialization error");
	const db = databaseLifecycle({
		create: () => ({}),
		initialize: async () => {
			throw original;
		},
		dispose: async () => {
			throw new Error("cleanup error");
		},
	});
	await assert.rejects(db.get(), (error) => error === original);
	assert.equal(db.active(), false);
});
