import assert from "node:assert/strict";
import { test } from "node:test";
import { ItemId, ModelId } from "../../connectors/sites/shopee/seller.ts";
import { productsOf, readCompleteList, trafficOf } from "./snapshot.ts";

test("店铺指标按台湾日期对齐，使用平台去重汇总并保留缺失值", () => {
	const start = Date.parse("2026-11-13T00:00:00+08:00") / 1000;
	const end = start + 7 * 86_400 - 1;
	const points = Array.from({ length: 7 }, (_, i) => ({ timestamp: start + i * 86_400, value: i === 1 ? null : 2 })).reverse();
	const metric = { value: 9, chain_ratio: -0.1, points };
	const report = { shop_uv: metric, product_clicks: metric, paid_orders: metric, confirmed_orders: { value: 0 } };
	const traffic = trafficOf(report, start, end);
	assert.deepEqual(traffic.visitors, { total: 9, change: -0.1 });
	assert.equal(traffic.points[0]?.date, "2026-11-13");
	assert.equal(traffic.points[1]?.visitors, null);
	assert.equal(traffic.points[6]?.date, "2026-11-19");
	assert.throws(() => trafficOf(report, start + 86_400, end + 86_400), /日期/);
});

test("全量分页遇到重复或缺页时拒绝替换快照", async () => {
	const read = (lists: string[][]) =>
		readCompleteList(
			"列表",
			async (page) => ({ total: 2, rows: lists[page - 1] ?? [] }),
			(id) => id,
		);
	assert.deepEqual(await read([["1"], ["2"]]), ["1", "2"]);
	await assert.rejects(read([["1"], ["1"]]), /重复/);
	await assert.rejects(read([["1"]]), /不完整/);
});

test("禁卖、缺货与未知独立计数，商品曝光只汇总有数据的在售款", () => {
	const product = (productId: string, status: number, stock: number | null) => ({
		productId,
		status,
		name: "商品",
		cover: "",
		bulk: { parentSku: null, models: [{ modelId: ModelId.parse(productId), sku: "", name: "", price: null, stock, sold: null, tierIndex: [] }] },
	});
	const report = (id: string, impressions: unknown) => ({ id: ItemId.parse(id), name: "商品", product_card_impressions: impressions });
	const catalog = [product("1", 1, 3), product("2", 1, 0), product("3", 1, null), product("4", 3, 3)];
	assert.deepEqual(productsOf(catalog, [report("1", 0), report("2", null), report("4", 8)]), {
		inStock: 1,
		outOfStock: 1,
		unknownStock: 1,
		review: 0,
		offShelf: 0,
		reported: 1,
		impressions: 0,
		blocked: [{ id: "4", name: "商品" }],
	});
	assert.equal(productsOf(catalog, []).impressions, null);
});
