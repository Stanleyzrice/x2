// SKU 图片按需补读只改变响应的图片，fixture 验证身份、精确对应、失败和已有缓存兼容；不接触真实站点或DB。
import assert from "node:assert/strict";
import { test } from "node:test";
import { productInfoOf } from "../../connectors/sites/shopee/products.ts";
import type { Sql } from "../../platform/db/index.ts";
import type { ProductFact } from "./facts.ts";
import { enrichProductImages, type ImageReader } from "./images.ts";
import { readProduct } from "./store.ts";

const target = { shop: "fixture", shopId: "10" };
const cached: ProductFact = {
	productId: "42",
	name: "旧商品资料",
	parentSku: "PARENT",
	cover: "https://img.example/cover.jpg",
	status: 1,
	reportedStatus: 1,
	statusLabel: "在售",
	unlisted: false,
	models: [
		{ modelId: "11", sku: "SKU-A", name: "同名", tierIndex: [0, 1], price: 99, stock: 0 },
		{ modelId: "12", sku: "SKU-B", name: "同名", tierIndex: [1, 0], price: null, stock: null },
	],
	priceMin: null,
	priceMax: null,
	stockTotal: null,
	stockState: "unknown",
	detailError: "已有缺项证据",
};
function reader() {
	let reads = 0;
	const value = productInfoOf({
		data: {
			product_info: {
				id: "42",
				name: "更新的名称不覆盖缓存",
				status: 8,
				is_unlisted: true,
				model_list: [
					{ id: "12", tier_index: [1, 0], sku_image: "", price_info: { normal_price: 999 } },
					{ id: "11", tier_index: [0, 1], sku_image: "", stock_detail: { total_seller_stock: 100 } },
				],
				std_tier_variation_list: [{ value_list: [{ image_id: "style-zero" }, { image_id: "style-one" }] }],
			},
		},
	});
	const driver: ImageReader = {
		where: (_shopId, fn) => fn(),
		identity: async () => ({ username: target.shop, shopId: target.shopId }),
		detail: async () => {
			reads++;
			return value;
		},
	};
	return { driver, reads: () => reads, value };
}
test("老快照按 exact modelId 和 tierIndex 补图，网站返回顺序和同名不影响对应，不覆盖价格库存状态", async () => {
	const f = reader();
	const before = structuredClone(cached);
	const result = await enrichProductImages(target, cached, f.driver);
	assert.equal(f.reads(), 1);
	assert.deepEqual(
		result.models?.map((m) => m.image),
		["https://down-tw.img.susercontent.com/file/style-zero", "https://down-tw.img.susercontent.com/file/style-one"],
	);
	assert.deepEqual({ ...result, models: cached.models, imageError: undefined }, { ...cached, imageError: undefined });
	assert.deepEqual(cached, before);
	assert.equal(result.imageError, null);
});
test("已知缺图 null 不触发补读；部分旧记录只补缺字段，保留已有图片", async () => {
	const f = reader();
	const known = { ...cached, models: cached.models!.map((m) => ({ ...m, image: null })) };
	await enrichProductImages(target, known, f.driver);
	assert.equal(f.reads(), 0);
	const partial = { ...cached, models: [{ ...cached.models![0]!, image: "https://img.example/known.jpg" }, cached.models![1]!] };
	const result = await enrichProductImages(target, partial, f.driver);
	assert.equal(f.reads(), 1);
	assert.equal(result.models?.[0]?.image, "https://img.example/known.jpg");
});
test("相同名字不能代替 modelId/tierIndex；规格变化、重复 id 或缺详情时保留 null 并说明", async () => {
	for (const change of ["tier", "duplicate", "missing"] as const) {
		const f = reader();
		if (change === "tier") f.value.model_list![1]!.tier_index = [1, 1];
		if (change === "duplicate") f.value.model_list!.push(f.value.model_list![1]!);
		if (change === "missing") f.value.model_list = [];
		const result = await enrichProductImages(target, cached, f.driver);
		assert.equal(result.models?.[0]?.image, null);
		assert.match(result.imageError ?? "", /未能.*对应/);
	}
});
test("图片 GET/登录/店铺身份失败保留缓存，详情不整页报错，缺图明确为 null", async () => {
	for (const failure of ["read", "identity", "product"] as const) {
		const f = reader();
		if (failure === "read")
			f.driver.detail = async () => {
				throw new Error("登录已失效");
			};
		if (failure === "identity") f.driver.identity = async () => ({ username: "other", shopId: "other" });
		if (failure === "product") f.value.id = "other";
		const result = await enrichProductImages(target, cached, f.driver);
		assert.match(result.imageError ?? "", /读取失败/);
		assert.deepEqual(
			result.models?.map((m) => m.image),
			[null, null],
		);
		assert.equal(result.status, cached.status);
		assert.equal(result.stockTotal, cached.stockTotal);
	}
});
test("单件 product 读取可按需补图，整个DB路径只允许select，旧事实不写回", async () => {
	const f = reader();
	const run = async (strings: TemplateStringsArray): Promise<unknown[]> => {
		if (!("raw" in strings)) return [];
		const q = strings.join("?").replace(/\s+/g, " ").trim();
		if (q.startsWith("select shop, shop_id from shop_settings")) return [{ shop: target.shop, shop_id: target.shopId }];
		if (q.startsWith("select p.facts from catalog_products")) return [{ facts: cached }];
		if (
			q.startsWith("select l.shop") ||
			q.startsWith("select item_id") ||
			q.startsWith("select distinct i->>") ||
			q.startsWith("select distinct on (i.product_id)")
		)
			return [];
		throw new Error(`不允许的fixture查询：${q}`);
	};
	const result = await readProduct(run as unknown as Sql, target.shop, cached.productId, f.driver);
	assert.equal(result.product.models?.[0]?.image, "https://down-tw.img.susercontent.com/file/style-zero");
	assert.equal(result.product.status, 1);
	assert.deepEqual(result.product.suppliers, []);
	assert.equal(result.product.imageError, null);
	assert.equal(cached.models?.[0]?.image, undefined);
});
