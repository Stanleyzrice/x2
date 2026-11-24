// 采购通知与页面同步的并发、店铺隔离、失效与失败回显测试；不连真实站点或执行采购。
import assert from "node:assert/strict";
import { test } from "node:test";
import { preserveMonitor } from "./sync.ts";
import { type Monitor, type Order, selectedDemand } from "./types.ts";

const monitor: Monitor = { checkedAt: "2026-11-06T00:00:00Z", error: null, orders: [] };

test("同步失败保留已有订单和原采集时间，真实成功的空列表正常替换", () => {
	const order: Order = { sn: "1", shop: "one", createdAt: null, shipBy: null, items: "", lines: [], step: "待核对", cartPending: true, cartDone: false };
	const quantities = { qty: 1, buyQty: 0, paidQty: 0, unpaidQty: 0, reviewQty: 1 };
	const demand = [{ key: "sku", name: "商品", spec: "红", target: null, ...quantities, orders: [{ sn: order.sn, shop: order.shop, ...quantities }] }];
	const previous = { ...monitor, orders: [order], demand };
	const failed = { checkedAt: null, error: "Shopee 读取失败", orders: [], demand: [] };
	assert.deepEqual(preserveMonitor(previous, failed), { ...failed, checkedAt: previous.checkedAt, orders: [order], demand });
	assert.equal(preserveMonitor(previous, monitor), monitor);
});

test("采购账号已变化时不回显另一账号的旧采购状态", () => {
	const purchases = { account: "one", loginId: "one", capturedAt: monitor.checkedAt, complete: true, error: null };
	const previous = { ...monitor, purchases };
	const current = { ...monitor, error: "新账号尚未同步", purchases: { ...purchases, account: "two", loginId: "two", complete: false } };
	assert.equal(preserveMonitor(previous, current), current);
});

test("勾选仅取这些订单在同一规格的贡献，未勾选时显示全部，部分已付款不重复计入", () => {
	const one = { sn: "A", shop: "one", qty: 2, paidQty: 1, unpaidQty: 0, buyQty: 1, reviewQty: 0 };
	const two = { ...one, sn: "B", qty: 3, paidQty: 0, buyQty: 3 };
	const both = { key: "sku", name: "商品", spec: "红色", target: null, qty: 5, paidQty: 1, unpaidQty: 0, buyQty: 4, reviewQty: 0, orders: [one, two] };
	assert.deepEqual(selectedDemand([both], new Set()), [both]);
	assert.deepEqual(selectedDemand([both], new Set(["B"])), [{ ...both, qty: 3, paidQty: 0, buyQty: 3, orders: [two] }]);
	assert.deepEqual(selectedDemand([both], new Set(["missing"])), []);
});
