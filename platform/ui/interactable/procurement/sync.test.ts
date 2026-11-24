// 采购通知与页面同步的并发、店铺隔离、失效与失败回显测试；不连真实站点或执行采购。
import assert from "node:assert/strict";
import { test } from "node:test";
import { monitorSync, preserveMonitor } from "./sync.ts";
import { type Monitor, type Order, selectedDemand } from "./types.ts";

const monitor: Monitor = { checkedAt: "2026-11-06T00:00:00Z", error: null, orders: [] };

test("通知与页面合并同一范围的同步；命中旧结果不再次回填新快照，不同店铺另读", async () => {
	const wait = Promise.withResolvers<Monitor>();
	let reads = 0;
	const published: { item: string; shops: string[]; value: Monitor }[] = [];
	const sync = monitorSync(
		async () => {
			reads++;
			return wait.promise;
		},
		(item, shops, value) => published.push({ item, shops, value }),
	);
	const first = sync("1", ["one", "two"]);
	const concurrent = sync("1", ["two", "one", "one"]);
	await Promise.resolve();
	assert.equal(reads, 1);
	wait.resolve(monitor);
	await Promise.all([first, concurrent]);
	assert.equal(published.length, 1);
	await sync("1", ["one", "two"]);
	assert.equal(published.length, 1, "已完成旧同步不能重新发布覆盖较新快照");
	await sync("1", ["other"]);
	assert.equal(reads, 2);
	assert.equal(published.length, 2);
});

test("确认后的快照已失效重读时，较早开始的同步不能回填旧采购状态；失败可重试", async () => {
	const wait = Promise.withResolvers<Monitor>();
	let epoch = 0,
		published = 0,
		reads = 0;
	const sync = monitorSync(
		async () => {
			reads++;
			if (reads === 1) return wait.promise;
			if (reads === 2) throw new Error("读取中断");
			return monitor;
		},
		() => published++,
		() => epoch,
	);
	const old = sync("1", ["one"]);
	await Promise.resolve();
	epoch++;
	wait.resolve(monitor);
	await old;
	assert.equal(published, 0);
	await assert.rejects(sync("1", ["one"], true), /读取中断/);
	await sync("1", ["one"], true);
	assert.equal(reads, 3);
	assert.equal(published, 1);
});

test("滑块或安全验证暂停自动同步；显式重试保留真实失败，成功后才发布恢复快照", async () => {
	const blocked = { ...monitor, error: "订单读取要过滑块验证" };
	let current: Monitor | null = blocked;
	let next: Monitor = blocked;
	let reads = 0;
	const published: Monitor[] = [];
	const sync = monitorSync(
		async () => {
			reads++;
			return next;
		},
		(_, __, value) => {
			current = value;
			published.push(value);
		},
		() => 0,
		() => current,
		0,
	);
	assert.equal(await sync("1", ["one"]), blocked);
	assert.equal(reads, 0, "已保存的验证错误不能触发自动外站同步");
	assert.equal(published.length, 0, "暂停期间不能重复发布或清掉原错误");
	assert.equal(await sync("1", ["one"], true), blocked);
	assert.equal(reads, 1, "用户显式重试必须真正读取，即使仍然验证失败");
	assert.equal(published[0], blocked);
	current = null;
	await sync("1", ["one"]);
	await sync("1", ["one"]);
	assert.equal(reads, 1, "短时缓存过期后也须保留验证快照，不能自动重载验证页");
	next = monitor;
	assert.equal(await sync("1", ["one"], true), monitor);
	assert.equal(reads, 2);
	assert.deepEqual(published, [blocked, monitor]);
	assert.equal(current, monitor, "只有真实成功的返回值才能替换验证错误");
});

test("同步失败保留已有订单和原采集时间，真实成功的空列表正常替换", () => {
	const order: Order = { sn: "1", shop: "one", createdAt: null, shipBy: null, items: "", lines: [], step: "待核对", cartPending: true, cartDone: false };
	const previous = { ...monitor, orders: [order] };
	const failed = { checkedAt: null, error: "Shopee 读取失败", orders: [] };
	assert.deepEqual(preserveMonitor(previous, failed), { ...failed, checkedAt: previous.checkedAt, orders: [order] });
	assert.equal(preserveMonitor(previous, monitor), monitor);
});

test("采购账号已变化时不回显另一账号的旧采购状态", () => {
	const purchases = { account: "one", loginId: "one", capturedAt: monitor.checkedAt, complete: true, error: null };
	const previous = { ...monitor, purchases };
	const current = { ...monitor, error: "新账号尚未同步", purchases: { ...purchases, account: "two", loginId: "two", complete: false } };
	assert.equal(preserveMonitor(previous, current), current);
});

test("后台同步正在读时，人工验证后的重检会单独执行，收到新结果再恢复", async () => {
	const wait = Promise.withResolvers<Monitor>();
	const calls: boolean[] = [];
	const sync = monitorSync(
		async (_id, _shops, force) => {
			calls.push(force);
			return force ? monitor : wait.promise;
		},
		() => {},
	);
	const automatic = sync("item", ["shop"]);
	const manual = sync("item", ["shop"], true);
	wait.resolve({ ...monitor, purchases: { account: "a", capturedAt: null, loginId: "a", complete: false, error: "需要安全验证" } });
	await automatic;
	assert.equal(await manual, monitor);
	assert.deepEqual(calls, [false, true]);
});

test("勾选仅取这些订单在同一规格的贡献，未勾选时显示全部，部分已付款不重复计入", () => {
	const one = { sn: "A", shop: "one", qty: 2, paidQty: 1, unpaidQty: 0, buyQty: 1, reviewQty: 0 };
	const two = { ...one, sn: "B", qty: 3, paidQty: 0, buyQty: 3 };
	const both = { key: "sku", name: "商品", spec: "红色", target: null, qty: 5, paidQty: 1, unpaidQty: 0, buyQty: 4, reviewQty: 0, orders: [one, two] };
	assert.deepEqual(selectedDemand([both], new Set()), [both]);
	assert.deepEqual(selectedDemand([both], new Set(["B"])), [{ ...both, qty: 3, paidQty: 0, buyQty: 3, orders: [two] }]);
	assert.deepEqual(selectedDemand([both], new Set(["missing"])), []);
});
