// 采购快照只读与货源索引并发测试；不触发 Shopee 同步、加购或真实数据库写入。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "../../platform/db/index.ts";
import { monitor, selectionParams, syncMonitor } from "./procurement.ts";

test("采购预览的 CLI 与网页复用订单号数组校验并保留长编号", () => {
	const requestId = "11111111-1111-4111-8111-111111111111";
	const orders = ["12345678901234567890"];
	assert.deepEqual(selectionParams.parse({ shops: '["cheeroutdoor"]', orders: JSON.stringify(orders), requestId }), {
		shops: ["cheeroutdoor"],
		orders,
		requestId,
	});
	assert.equal(selectionParams.safeParse({ orders: "[12345678901234567890]", requestId }).success, false);
});

test("采购快照并行读取已有货源索引，保留待核对状态且不假造 Shopee 核对时间", async () => {
	const wait = Promise.withResolvers<void>();
	const queries: string[] = [];
	const sql = ((strings: TemplateStringsArray | string[]) => {
		if (!("raw" in strings)) return {};
		const query = strings.join("?");
		queries.push(query);
		if (query.includes("from orders o"))
			return Promise.resolve([
				{
					sn: "order-1",
					shop: "one",
					shop_id: "10",
					created_at: null,
					ship_by: null,
					items_text: "商品",
					items: [{ itemId: "11", modelId: "12", name: "商品", spec: "大号", qty: 1, image: "" }],
					step: null,
					cart_pending: true,
					cart_done: true,
				},
			]);
		if (query.includes("from sources") || query.includes("from listings")) return wait.promise.then(() => []);
		if (query.includes("from order_settings s") || query.includes("from catalog_products p")) return Promise.resolve([]);
		throw new Error(`非预期查询：${query}`);
	}) as unknown as Sql;
	const reading = monitor(sql, ["one"]);
	await new Promise((resolve) => setImmediate(resolve));
	try {
		assert.equal(queries.length, 6, "账号/历史需求及三类规格索引只读，索引须在等待首条响应前发出");
		assert.ok(queries.every((query) => query.startsWith("select")));
	} finally {
		wait.resolve();
	}
	const result = await reading;
	assert.equal(result.checkedAt, null);
	assert.equal(result.error, null);
	assert.equal(result.orders[0]?.cartPending, true);
	assert.equal(result.orders[0]?.step, "采购状态待核对");
	assert.equal(result.orders[0]?.purchase.canPurchase, false);
	assert.equal(result.orders[0]?.lines[0]?.sources.length, 0);
	assert.equal(result.purchases.selected, null);
	assert.equal(result.purchases.error, "尚未选择采购账号");
	assert.deepEqual(result.demand[0]?.orders, [{ sn: "order-1", shop: "one", qty: 1 }]);
	assert.equal(result.demand[0]?.reviewQty, 1);
});

test("Shopee 同步失败后仍尝试读取 1688，分别报告两边的结果", async () => {
	const sql = (async (strings: TemplateStringsArray | string[]) => {
		if (!("raw" in strings)) return {};
		const query = strings.join("?");
		if (query.startsWith("update orders")) throw new Error("Shopee 订单同步失败");
		if (query.startsWith("select buy_account")) throw new Error("1688 采购账号读取失败");
		if (query.includes("from order_settings s")) return [{ selected: "fixture", account: null }];
		if (query.includes("from orders o")) return [];
		throw new Error(`非预期查询：${query}`);
	}) as unknown as Sql;
	const result = await syncMonitor(sql, ["fixture"]);
	assert.equal(result.checkedAt, null);
	assert.equal(result.error, "Shopee 订单同步失败");
	assert.equal(result.purchases.complete, false);
	assert.equal(result.purchases.error, "1688 采购账号读取失败");
});
