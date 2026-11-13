// 工作区缓存按店铺、账号范围和筛选隔离；人工操作后的失效会重新读取，不访问真实服务。
import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "./api.ts";
import { preloadPage } from "./preload.ts";

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

test("备选进入、预读与强制轮询合并在途请求，缓存按店铺及筛选隔离", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async (_url: unknown, options?: RequestInit) => {
		const input = JSON.parse(String(options?.body)).input;
		return Response.json({ shop: input.targetShop, total: ++calls, items: [] });
	});
	const item = "sources-cache-test";
	const query = { targetShop: "one", query: "", platform: "all", status: "all" };
	try {
		const [preload, active, poll] = await Promise.all([api.sources(item, query), api.sources(item, query, true), api.sources(item, query, true)]);
		assert.equal(calls, 1);
		assert.equal(preload, active);
		assert.equal(active, poll);
		assert.equal(api.peekSources(item, query), active);
		for (const input of [
			{ ...query, targetShop: "two" },
			{ ...query, query: "拖鞋" },
			{ ...query, platform: "1688" },
			{ ...query, status: "ready" },
		]) {
			assert.equal(api.peekSources(item, input), null);
			await api.sources(item, input);
		}
		assert.equal(calls, 5);
		assert.equal((await api.sources(item, query, true)).total, 6);
	} finally {
		api.invalidateSources(item);
	}
});

test("备选变更失效后重新取数，变更前的慢请求不能回填旧列表或详情", async (t) => {
	const delayed = Promise.withResolvers<Response>();
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => (++calls === 1 ? delayed.promise : Response.json({ shop: "one", id: "1", total: 2, items: [] })));
	const item = "sources-invalidation-test";
	const query = { targetShop: "one", query: "", platform: "all", status: "all" };
	try {
		const old = api.sources(item, query, true);
		await Promise.resolve();
		api.invalidateSources(item);
		const current = await api.sources(item, query, true);
		assert.equal(calls, 2);
		delayed.resolve(Response.json({ shop: "one", total: 1, items: [] }));
		await old;
		assert.equal(api.peekSources(item, query), current);
		await api.sourceDetail(item, { targetShop: "one", sourceId: "1" });
		assert.equal(api.peekSourceDetail(item, { targetShop: "two", sourceId: "1" }), null);
		assert.equal(api.peekSourceDetail(item, { targetShop: "one", sourceId: "2" }), null);
		api.invalidateSources();
		assert.equal(api.peekSources(item, query), null);
		assert.equal(api.peekSourceDetail(item, { targetShop: "one", sourceId: "1" }), null);
	} finally {
		api.invalidateSources(item);
	}
});

test("Catalog不同模式预读对应对象，人工采集不误查店铺目录", async (t) => {
	const modes = ["collect", "candidates", "catalog", undefined];
	const actions: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: unknown, options?: RequestInit) => {
		if (String(url).startsWith("/api/page?")) {
			const index = Number(new URL(String(url), "http://x").searchParams.get("id")?.split("-").at(-1));
			return Response.json({ items: [{ id: `mode-item-${index}`, component: "catalog", props: { shop: "one", mode: modes[index] } }] });
		}
		const input = JSON.parse(String(options?.body));
		actions.push(input.action);
		return Response.json({ shop: "one", items: [], rows: [] });
	});
	try {
		for (let index = 0; index < modes.length; index++) await preloadPage(`mode-preload-test-${index}`);
		assert.deepEqual(actions, ["sources", "products", "products"]);
	} finally {
		api.invalidateSources();
		for (let index = 0; index < modes.length; index++) api.invalidateCatalog(`mode-item-${index}`);
	}
});
