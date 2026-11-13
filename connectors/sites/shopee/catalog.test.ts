// 全状态商品列表用合成 fixture 验证；缺页结构不能被误当作空店铺。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { allProductsOf, allProductsRequest, productImageUrl, productInfoOf, productModelImage } from "./products.ts";

test("全状态分页走 get_product_list，页码逐页传递且保持 all 范围", () => {
	assert.deepEqual(allProductsRequest(2, 48), {
		path: "/api/v3/opt/mpsku/list/v2/get_product_list",
		request: { query: { page_size: 48, page_number: 2, list_type: "all", need_ads: false } },
	});
	assert.equal(allProductsRequest(1, 100).request.query?.page_size, 48);
	assert.equal(allProductsRequest(1).request.query?.page_number, 1);
});

test("全状态列表保留删除、禁卖、审核及未知状态，长 id 始终为字符串", () => {
	const raw: unknown = JSON.parse(readFileSync(new URL("./fixtures/get-all-products.json", import.meta.url), "utf8"));
	const result = allProductsOf(raw);
	assert.equal(result.total, 7);
	assert.deepEqual(
		result.rows.map((p) => p.status),
		[1, 8, 3, 2, 0, 17, null],
	);
	assert.equal(result.rows.at(-1)?.productId, "9007199254740993123");
	assert.throws(() => allProductsOf({ data: { page_info: { total: 1 }, products: [{ id: Number.MAX_SAFE_INTEGER + 2 }] } }));
});

test("全状态列表把平台 create_time 秒值透传为创建时间，缺省或无效时间保留 null", () => {
	const raw: unknown = JSON.parse(readFileSync(new URL("./fixtures/get-all-products-created-at.json", import.meta.url), "utf8"));
	const rows = allProductsOf(raw).rows;
	assert.equal(rows[0]?.createdAt, "2026-11-13T05:52:38.000Z");
	assert.equal(rows[1]?.createdAt, "2026-11-13T05:55:05.000Z");
	assert.equal(
		allProductsOf({ data: { page_info: { total: 1 }, products: [{ id: "10", create_time: "1794549158" }] } }).rows[0]?.createdAt,
		"2026-11-13T05:52:38.000Z",
	);
	for (const create_time of [undefined, null, "", "invalid", "Infinity", 0, -1, 1e20]) {
		const row = allProductsOf({ data: { page_info: { total: 1 }, products: [{ id: "10", create_time, model_list: [{ id: "11" }] }] } }).rows[0];
		assert.equal(row?.createdAt, null);
		assert.equal(row?.bulk?.models.length, 1);
	}
});

test("缺 total、products 或空的 total 报错，明确空数组加零才是空目录", () => {
	for (const data of [{}, { page_info: { total: 0 } }, { page_info: { total: "" }, products: [] }, { page_info: { total: -1 }, products: [] }])
		assert.throws(() => allProductsOf({ data }));
	assert.deepEqual(allProductsOf({ data: { page_info: { total: 0 }, products: [] } }), { total: 0, rows: [] });
});

test("原生列表 model_list 提供 bulk SKU、价格与库存，缺值保留 null", () => {
	const raw: unknown = JSON.parse(readFileSync(new URL("./fixtures/get-product-list.json", import.meta.url), "utf8"));
	const bulk = allProductsOf(raw).rows[0]?.bulk;
	assert.equal(bulk?.parentSku, "X2-12-cheeroutdoor");
	assert.equal(bulk?.models.length, 2);
	assert.equal(bulk?.models[0]?.modelId, "250000000011");
	assert.equal(bulk?.models[0]?.price, 299);
	assert.equal(bulk?.models[0]?.stock, 50);
	assert.equal(bulk?.models[0]?.image, "https://down-tw.img.susercontent.com/file/sg-11134275-0000model");
	assert.equal(bulk?.models[1]?.price, null);
	assert.equal(bulk?.models[1]?.stock, null);
	assert.equal(bulk?.models[1]?.image, null);
});

test("原生列表缺规格、为空或声明截断/数量不符时不声称有完整 bulk", () => {
	const raw = JSON.parse(readFileSync(new URL("./fixtures/get-product-list.json", import.meta.url), "utf8")) as {
		data: { products: Record<string, unknown>[] };
	};
	const first = raw.data.products[0]!;
	for (const fields of [{ model_list: [] }, { model_list: null }, { has_more_models: true }, { model_list_truncated: true }, { model_count: 3 }]) {
		assert.equal(allProductsOf({ data: { page_info: { total: 1 }, products: [{ ...first, ...fields }] } }).rows[0]?.bulk, undefined);
	}
	assert.equal(
		allProductsOf({ data: { page_info: { total: 1 }, products: [{ ...first, model_count: 2, model_list_truncated: false }] } }).rows[0]?.bulk?.models.length,
		2,
	);
});

test("bulk 原样保留明确的 is_default，不从空名字或单规格推定默认标志", () => {
	const model = { id: "1", name: "", tier_index: [0], price_detail: { origin_price: 99 }, stock_detail: { total_seller_stock: 0 } };
	const parse = (value: Record<string, unknown>) =>
		allProductsOf({ data: { page_info: { total: 1 }, products: [{ id: "10", status: 8, model_list: [value] }] } }).rows[0]?.bulk?.models[0];
	assert.equal(parse({ ...model, is_default: true })?.isDefault, true);
	assert.equal(parse({ ...model, is_default: false })?.isDefault, false);
	assert.equal(parse(model)?.isDefault, undefined);
});

test("SKU 图片按原生字段和第零层 tierIndex 对应，不按名称、尺寸或商品封面猜图", () => {
	const raw: unknown = JSON.parse(readFileSync(new URL("./fixtures/get-product-images.json", import.meta.url), "utf8"));
	const p = productInfoOf(raw);
	assert.deepEqual(
		p.model_list?.map((m) => productModelImage(p, m)),
		[
			"https://down-tw.img.susercontent.com/file/tw-11134207-first-style",
			"https://down-tw.img.susercontent.com/file/second-style",
			"https://down-tw.img.susercontent.com/file/direct-model",
			null,
		],
	);
	for (const tier_index of [[], [-1, 0], [100, 0], ["", 0], [0.5, 0]]) assert.equal(productModelImage(p, { tier_index }), null);
	assert.equal(productModelImage(p, { tier_index: ["0", "1"] }), "https://down-tw.img.susercontent.com/file/tw-11134207-first-style");
});

test("图片 id 转 URL，完整 URL 保留；缺图或不支持的地址为 null", () => {
	assert.equal(productImageUrl(" tw-11134207-image "), "https://down-tw.img.susercontent.com/file/tw-11134207-image");
	assert.equal(productImageUrl("https://img.example/sku.jpg?width=200"), "https://img.example/sku.jpg?width=200");
	for (const value of [undefined, null, "", "   ", "javascript:alert(1)", "not an id", "https://"]) assert.equal(productImageUrl(value), null);
});
