// 缓存测试：并发只读一次；失败可重试；失效隔离旧响应；过期和容量不让缓存无限增长。
import assert from "node:assert/strict";
import { test } from "node:test";
import { readCache } from "./read-cache.ts";

test("并发预加载与页面读取合并，过期重新读", async () => {
	let now = 100,
		calls = 0;
	const cache = readCache<number>(30, 2, () => now);
	const load = async () => ++calls;
	assert.deepEqual(await Promise.all([cache.read("a", load), cache.read("a", load)]), [1, 1]);
	assert.equal(await cache.read("a", load), 1);
	now += 31;
	assert.equal(await cache.read("a", load), 2);
});

test("失效后的旧请求不能覆盖新结果", async () => {
	const cache = readCache<number>();
	let finish!: (value: number) => void;
	const old = cache.read(
		"shop:1",
		() =>
			new Promise<number>((resolve) => {
				finish = resolve;
			}),
	);
	await Promise.resolve();
	cache.invalidate("shop:");
	await cache.read("shop:1", async () => 2);
	finish(1);
	await old;
	assert.equal(cache.peek("shop:1"), 2);
});

test("重读失败保留缓存并允许重试，容量有界", async () => {
	const cache = readCache<number>(30_000, 2);
	await cache.read("a", async () => 1);
	await assert.rejects(
		cache.read(
			"a",
			async () => {
				throw new Error("offline");
			},
			true,
		),
		/offline/,
	);
	assert.equal(cache.peek("a"), 1);
	assert.equal(await cache.read("a", async () => 2, true), 2);
	await cache.read("b", async () => 3);
	await cache.read("c", async () => 4);
	assert.equal(cache.peek("a"), null);
});

test("同步结果回填后旧的只读请求不能覆盖，新值按回填时间保鲜", async () => {
	let now = 0;
	const cache = readCache<number>(30, 2, () => now);
	const delayed = Promise.withResolvers<number>();
	const reading = cache.read("shop:1", () => delayed.promise);
	await Promise.resolve();
	now = 20;
	cache.set("shop:1", 2);
	assert.equal(cache.peek("shop:1"), 2);
	delayed.resolve(1);
	await reading;
	assert.equal(cache.peek("shop:1"), 2);
	now = 49;
	assert.equal(await cache.read("shop:1", async () => 3), 2);
	now = 50;
	assert.equal(await cache.read("shop:1", async () => 3), 3);
});
