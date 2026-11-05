// Catalog 的身份、分页、未知值及货源归属测试，不读网站或数据库。
import assert from "node:assert/strict";
import { test } from "node:test";
import { allProductsOf, type ProductSummary, productInfoOf } from "../../connectors/sites/shopee/products.ts";
import { type CatalogReader, collectCatalog, productFact, supplierLinks } from "./facts.ts";
import { queryParams } from "./index.ts";

const target = { shop: "fixture", shopId: "10" };
const summary = (id: string, status = 1): ProductSummary => ({ productId: id, name: `商品 ${id}`, status, cover: "" });
const info = (id: string, stocks: unknown[] = [0], prices: unknown[] = [59]) =>
	productInfoOf({
		data: {
			product_info: {
				id,
				parent_sku: "PARENT",
				model_list: stocks.map((stock, i) => ({
					id: `${id}-${i}`,
					sku: `SKU-${i}`,
					tier_index: [i],
					stock_detail: { total_seller_stock: stock },
					price_info: { normal_price: prices[i] },
				})),
				std_tier_variation_list: [{ value_list: stocks.map((_, i) => ({ custom_value: `款式 ${i}` })) }],
			},
		},
	});
const reader = (pages: { total: number; rows: ProductSummary[] }[]): CatalogReader => ({
	identity: async () => ({ shopId: target.shopId, username: target.shop }),
	list: async (page) => pages[page - 1] ?? { total: pages[0]!.total, rows: [] },
	detail: async (id) => info(id),
});

test("未知价格库存保留 null；已知零库存是售罄，有部分未知不能冒充售罄", () => {
	assert.equal(productFact(summary("1"), info("1")).stockState, "sold_out");
	const partial = productFact(summary("1"), info("1", [0, null], [59, null]));
	assert.equal(partial.stockState, "unknown");
	assert.equal(partial.stockTotal, null);
	assert.equal(partial.priceMin, null);
	assert.equal(partial.models?.[1]?.price, null);
	assert.match(partial.detailError ?? "", /未返回/);
	assert.equal(productFact(summary("1"), info("1", ["  "], ["  "])).stockState, "unknown");
	assert.equal(productFact(summary("1"), info("1", [1, null], [59, null])).stockState, "in_stock");
	assert.equal(productFact(summary("1"), null).models, null);
	assert.throws(() => productFact(summary("1"), info("2")), /编号不匹配/);
});

test("完整消费分页，商品详情保留规格名、SKU与字符串ID", async () => {
	const result = await collectCatalog(
		target,
		reader([
			{ total: 3, rows: [summary("1"), summary("2", 8)] },
			{ total: 3, rows: [summary("3", 3)] },
		]),
	);
	assert.equal(result.products.length, 3);
	assert.equal(result.complete, true);
	assert.equal(result.detailsComplete, true);
	assert.equal(result.products[0]?.models?.[0]?.name, "款式 0");
	assert.equal(result.products[0]?.models?.[0]?.sku, "SKU-0");
});

test("多层规格缺少任一层值时不以剩余名称冒充完整规格", () => {
	const detail = productInfoOf({
		data: {
			product_info: {
				id: "1",
				model_list: [{ id: "11", tier_index: [0, 1], price_info: { normal_price: 59 }, stock_detail: { total_seller_stock: 1 } }],
				std_tier_variation_list: [{ value_list: [{ custom_value: "粉色" }] }, { value_list: [{ custom_value: "小号" }] }],
			},
		},
	});
	const result = productFact(summary("1"), detail);
	assert.equal(result.models?.[0]?.name, "规格名未知");
	assert.match(result.detailError ?? "", /规格名称未返回/);
});

test("分页列表已有 SKU 时直接保留价格库存，不对每个商品重复读取详情", async () => {
	const page = allProductsOf({
		data: {
			page_info: { total: 1 },
			products: [
				{
					id: "1",
					name: "商品",
					parent_sku: "PARENT",
					status: 8,
					model_list: [
						{
							id: "11",
							name: "藍色",
							sku: "SKU-B",
							image: "tw-model-blue",
							tier_index: [0],
							price_detail: { origin_price: "99" },
							stock_detail: { total_seller_stock: 0 },
						},
					],
				},
			],
		},
	});
	const r = reader([page]);
	r.detail = async () => {
		throw new Error("不应补读已有的SKU");
	};
	const result = await collectCatalog(target, r);
	assert.equal(result.detailsComplete, true);
	assert.equal(result.products[0]?.parentSku, "PARENT");
	assert.equal(result.products[0]?.status, 8);
	assert.equal(result.products[0]?.stockState, "sold_out");
	assert.equal(result.products[0]?.models?.[0]?.image, "https://down-tw.img.susercontent.com/file/tw-model-blue");
	assert.deepEqual(
		result.products[0]?.models?.map(({ modelId, sku, name, price, stock }) => ({ modelId, sku, name, price, stock })),
		[{ modelId: "11", sku: "SKU-B", name: "藍色", price: 99, stock: 0 }],
	);
});

test("多 SKU 缺规格名不能冒充默认规格或完整详情；无 tier 的单 SKU 可保留默认规格", async () => {
	const unnamed = (count: number) =>
		productInfoOf({
			data: {
				product_info: {
					id: "1",
					model_list: Array.from({ length: count }, (_, i) => ({
						id: String(i + 1),
						price_info: { normal_price: 59 },
						stock_detail: { total_seller_stock: 1 },
					})),
				},
			},
		});
	const multi = productFact(summary("1"), unnamed(2));
	assert.deepEqual(
		multi.models?.map((m) => m.name),
		["规格名未知", "规格名未知"],
	);
	assert.match(multi.detailError ?? "", /规格名称未返回/);
	const r = reader([{ total: 1, rows: [summary("1")] }]);
	r.detail = async () => unnamed(2);
	assert.equal((await collectCatalog(target, r)).detailsComplete, false);
	const withoutTiers = productFact(summary("1"), unnamed(1));
	assert.equal(withoutTiers.models?.[0]?.name, "规格名未知");
	assert.match(withoutTiers.detailError ?? "", /规格名称未返回/);
	const singleInfo = unnamed(1);
	singleInfo.std_tier_variation_list = [];
	const single = productFact(summary("1"), singleInfo);
	assert.equal(single.models?.[0]?.name, "默认规格");
	assert.equal(single.detailError, null);
});

test("单 SKU 的原生 is_default 标识可确认默认规格；无标识或多 SKU 不推定默认", async () => {
	for (const [count, isDefault, expected] of [
		[1, true, true],
		[1, false, false],
		[2, true, false],
	] as const) {
		const page = allProductsOf({
			data: {
				page_info: { total: 1 },
				products: [
					{
						id: "1",
						status: 8,
						model_list: Array.from({ length: count }, (_, i) => ({
							id: String(i + 1),
							name: "",
							is_default: isDefault,
							tier_index: [0],
							price_detail: { origin_price: 99 },
							stock_detail: { total_seller_stock: 1 },
						})),
					},
				],
			},
		});
		const result = await collectCatalog(target, reader([page]));
		assert.equal(result.detailsComplete, expected);
		assert.equal(result.products[0]?.models?.[0]?.name, expected ? "默认规格" : "规格名未知");
	}
});

test("分页缺失、重复和总数变化均拒绝产出可替换快照", async () => {
	for (const pages of [
		[
			{ total: 2, rows: [summary("1")] },
			{ total: 2, rows: [] },
		],
		[
			{ total: 2, rows: [summary("1")] },
			{ total: 2, rows: [summary("1")] },
		],
		[
			{ total: 2, rows: [summary("1")] },
			{ total: 3, rows: [summary("2")] },
		],
		[{ total: 1, rows: [summary("1"), summary("2")] }],
	])
		await assert.rejects(collectCatalog(target, reader(pages)), /不完整|重复|变化|不一致/);
});

test("读取前后均核对店铺；详情失败不会返回完整快照", async () => {
	const a = reader([{ total: 1, rows: [summary("1")] }]);
	a.identity = async () => ({ shopId: "other", username: target.shop });
	await assert.rejects(collectCatalog(target, a), /店铺身份不匹配/);
	let calls = 0;
	const b = reader([{ total: 1, rows: [summary("1")] }]);
	b.identity = async () => ({ shopId: ++calls === 1 ? target.shopId : "other", username: target.shop });
	await assert.rejects(collectCatalog(target, b), /店铺身份不匹配/);
	const c = reader([{ total: 1, rows: [summary("1")] }]);
	c.detail = async () => {
		throw new Error("详情读取失败");
	};
	await assert.rejects(collectCatalog(target, c), /详情读取失败/);
});

test("网站仍返回的删除商品保留概要，详情不可读明确标缺项", async () => {
	const r = reader([{ total: 1, rows: [summary("1", 0)] }]);
	r.detail = async () => {
		throw new Error("商品已删除");
	};
	const result = await collectCatalog(target, r);
	assert.equal(result.complete, true);
	assert.equal(result.detailsComplete, false);
	assert.equal(result.products[0]?.status, 0);
	assert.equal(result.products[0]?.stockState, "unknown");
	assert.match(result.products[0]?.detailError ?? "", /删除/);
});

test("货源关联按店铺和商品精确引用；chosen 无唯一订单归属时不冒认", () => {
	const listings = [{ shop: "fixture", shopId: "10", productId: "1", offerId: "101" }];
	const chosen = [{ productId: "1", offerId: "102", broken: null, selectedAt: null }];
	const valid = supplierLinks("fixture", "10", "1", listings, chosen, [{ productId: "1", shopId: "10" }]);
	assert.deepEqual(
		valid.suppliers.map((s) => s.offerId),
		["101", "102"],
	);
	assert.ok(valid.supplierWarnings.length);
	for (const owners of [
		[{ productId: "1", shopId: "20" }],
		[
			{ productId: "1", shopId: "10" },
			{ productId: "1", shopId: "20" },
		],
		[{ productId: "1", shopId: null }],
	]) {
		const result = supplierLinks("fixture", "10", "1", listings, chosen, owners);
		assert.deepEqual(
			result.suppliers.map((s) => s.offerId),
			["101"],
		);
		assert.match(result.supplierWarnings[0] ?? "", /归属/);
	}
	assert.equal(supplierLinks("fixture", "10", "1", [], chosen, []).suppliers.length, 0);
	const conflicting = [...listings, { shop: "other", shopId: "20", productId: "1", offerId: "999" }];
	assert.deepEqual(
		supplierLinks("fixture", "10", "1", conflicting, chosen, [{ productId: "1", shopId: "10" }]).suppliers.map((s) => s.offerId),
		["101"],
	);
});

test("查询显式限定已配置店铺，支持未知库存和所有状态码且限制分页", () => {
	assert.equal(queryParams.safeParse({}).success, false);
	assert.equal(queryParams.parse({ shop: "fixture", stock: "sold_out", status: "17" }).status, "17");
	assert.equal(queryParams.safeParse({ shop: "fixture", pageSize: 201 }).success, false);
	assert.equal(queryParams.safeParse({ shop: "fixture", status: "1 OR 1=1" }).success, false);
});
