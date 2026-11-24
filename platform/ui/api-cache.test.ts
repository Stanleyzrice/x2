// 工作区缓存按店铺、账号范围和筛选隔离；人工操作后的失效会重新读取，不访问真实服务。
import assert from "node:assert/strict";
import { test } from "node:test";
import { api } from "./api.ts";
import { preloadPage } from "./preload.ts";

test("API 错误只显示文字消息，空回包或非文字 error 仍保留 HTTP 状态", async (t) => {
	for (const body of [null, { error: { detail: "upstream" } }, { error: 503 }]) {
		t.mock.method(globalThis, "fetch", async () => Response.json(body, { status: 503 }));
		await assert.rejects(api.pages(), { name: "Error", message: "503" });
	}
	t.mock.method(globalThis, "fetch", async () => Response.json({ error: "需要重新登录" }, { status: 401 }));
	await assert.rejects(api.pages(), { name: "Error", message: "需要重新登录" });
});

test("采购必须带上自定义下单日期，拒绝截断或缺少订单的快照，允许重读", async (t) => {
	const dateRange = { from: "2026-11-03", to: "2026-11-11" };
	const good = { checkedAt: "latest", error: null, orders: [] };
	const replies = [new Response('{"orders":'), Response.json({}), Response.json(good)];
	const bodies: unknown[] = [];
	t.mock.method(globalThis, "fetch", async (_: unknown, opt: RequestInit) => {
		bodies.push(JSON.parse(String(opt.body)));
		return replies.shift()!;
	});
	await assert.rejects(api.readProcurement("one", dateRange, true), /返回的数据不完整/);
	await assert.rejects(api.readProcurement("one", dateRange, false), /缺少订单列表/);
	assert.deepEqual(await api.readProcurement("one", dateRange, true), good);
	assert.deepEqual(bodies.slice(0, 2), [
		{ item: "one", action: "sync", input: { dateRange, force: true } },
		{ item: "one", action: "monitor", input: { dateRange } },
	]);
});

test("预加载订单采购页面不启动无日期订单采集或汇总", async (t) => {
	const paths: string[] = [];
	t.mock.method(globalThis, "fetch", async (url: string) => {
		paths.push(url);
		return Response.json({ items: [{ component: "procurement", id: "fixture" }] });
	});
	await preloadPage("date-fixture");
	assert.equal(paths.length, 1);
	assert.match(paths[0]!, /api\/page\?/);
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
