// 工作区缓存按店铺、账号范围和筛选隔离；人工操作后的失效会重新读取，不访问真实服务。
import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "./api.ts";

test("采购缓存隔离店铺范围，同一范围合并读取，同步结果回填可立即回显", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		return Response.json({ checkedAt: String(calls), error: null, orders: [] });
	});
	const item = "procurement-cache-test";
	try {
		const [first, shared] = await Promise.all([api.procurementMonitor(item, ["one"]), api.procurementMonitor(item, ["one"])]);
		assert.equal(calls, 1);
		assert.equal(first, shared);
		assert.equal(api.peekProcurementMonitor(item, ["two"]), null);
		await api.procurementMonitor(item, ["two"]);
		assert.equal(calls, 2);
		const updated = { checkedAt: "latest", error: null, orders: [] };
		api.setProcurementMonitor(item, ["one"], updated);
		assert.equal(await api.procurementMonitor(item, ["one"]), updated);
		assert.equal(calls, 2);
		const epoch = api.procurementMonitorEpoch(item);
		api.invalidateProcurementMonitor(item);
		assert.equal(api.procurementMonitorEpoch(item), epoch + 1);
		assert.equal(api.peekProcurementMonitor(item, ["one"]), null);
		assert.equal(api.peekProcurementMonitor(item, ["two"]), null);
	} finally {
		api.invalidateProcurementMonitor(item);
	}
});

test("报账缓存隔离账号范围、筛选及页码，失效后重新取人工标记", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => Response.json({ revision: ++calls }));
	const item = "reimbursement-cache-test";
	const query = { accounts: ["one"], search: "", paidFrom: "", paidTo: "", offset: 0 };
	try {
		assert.deepEqual(await api.reimbursementRecords(item, query), { revision: 1 });
		assert.deepEqual(await api.reimbursementRecords(item, { ...query }), { revision: 1 });
		for (const changed of [
			{ ...query, accounts: ["two"] },
			{ ...query, account: "one" },
			{ ...query, search: "SKU" },
			{ ...query, paidFrom: "2026-11-01" },
			{ ...query, paidTo: "2026-11-06" },
			{ ...query, offset: 50 },
		]) {
			assert.equal(api.peekReimbursementRecords(item, changed), null);
			await api.reimbursementRecords(item, changed);
		}
		assert.equal(calls, 7);
		api.invalidateReimbursementRecords(item);
		assert.equal(api.peekReimbursementRecords(item, query), null);
		assert.deepEqual(await api.reimbursementRecords(item, query), { revision: 8 });
	} finally {
		api.invalidateReimbursementRecords(item);
	}
});

test("采购同步期间保留内容，人工操作失效后重新核对，同一店铺集合不受顺序影响", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => Response.json({ checkedAt: String(++calls), error: null, orders: [] }));
	const item = "procurement-sync-cache-test";
	const shops = ["one", "two"];
	const first = await api.procurementMonitor(item, shops);
	api.beginProcurementSync(item, shops);
	try {
		assert.equal(await api.procurementMonitor(item, ["two", "one", "one"], true), first);
		assert.equal(calls, 1);
		api.invalidateProcurementMonitor(item);
		assert.equal((await api.procurementMonitor(item, shops, true)).checkedAt, "2");
	} finally {
		api.endProcurementSync(item, shops);
	}
	try {
		assert.equal((await api.procurementMonitor(item, shops, true)).checkedAt, "3");
	} finally {
		api.invalidateProcurementMonitor(item);
	}
});

test("采购同步失败后的只读轮询仍保留旧内容，成功确认无订单时正常清空", async (t) => {
	const item = "procurement-failed-poll-test";
	const order = { sn: "saved-order", shop: "one", createdAt: null, shipBy: null, items: "商品", lines: [], step: "待核对", cartPending: true, cartDone: false };
	const replies = [
		{ checkedAt: "last-success", error: null, orders: [order] },
		{ checkedAt: null, error: "同步失败", orders: [] },
		{ checkedAt: null, error: "同步仍未成功", orders: [] },
		{ checkedAt: "fresh-success", error: null, orders: [] },
	];
	t.mock.method(globalThis, "fetch", async () => Response.json(replies.shift()));
	try {
		await api.procurementMonitor(item, ["one"]);
		for (const message of ["同步失败", "同步仍未成功"]) {
			const data = await api.procurementMonitor(item, ["one"], true);
			assert.equal(data.error, message);
			assert.equal(data.checkedAt, "last-success");
			assert.deepEqual(data.orders, [order]);
		}
		const fresh = await api.procurementMonitor(item, ["one"], true);
		assert.equal(fresh.error, null);
		assert.equal(fresh.checkedAt, "fresh-success");
		assert.deepEqual(fresh.orders, []);
	} finally {
		api.invalidateProcurementMonitor(item);
	}
});
