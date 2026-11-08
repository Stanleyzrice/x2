// 单件商品现读完整详情，规格扩展和层下标变化不沿用旧快照；读取失败明确回退且不写库。
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
	models: [{ modelId: "11", sku: "SKU-A", name: "默认规格", tierIndex: [0], price: 99, stock: 0, image: null }],
	priceMin: 99,
	priceMax: 99,
	stockTotal: 0,
	stockState: "sold_out",
	detailError: null,
};
function reader() {
	let reads = 0;
	const value = productInfoOf({
		data: {
			product_info: {
				id: "42",
				name: "当前商品资料",
				parent_sku: "PARENT",
				status: 8,
				is_unlisted: true,
				images: ["product-cover"],
				model_list: [
					{ id: "12", sku: "SKU-B", tier_index: [0, 0], sku_image: "", price_info: { normal_price: 129 }, stock_detail: { total_seller_stock: 50 } },
					{ id: "11", sku: "SKU-A", tier_index: [1, 0], sku_image: "", price_info: { normal_price: 159 }, stock_detail: { total_seller_stock: 10 } },
				],
				std_tier_variation_list: [
					{
						value_list: [
							{ custom_value: "杏粉色", image_id: "pink" },
							{ custom_value: "灰色", image_id: "grey" },
						],
					},
					{ value_list: [{ custom_value: "34×47×10cm" }] },
				],
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
test("详情现读全部 SKU，包括新规格和移动的 tierIndex；价格库存状态与 Shopee 同次详情一致", async () => {
	const f = reader();
	const before = structuredClone(cached);
	const result = await enrichProductImages(target, cached, f.driver);
	assert.equal(f.reads(), 1);
	assert.deepEqual(
		result.models?.map(({ modelId, name, tierIndex, image, price, stock }) => ({ modelId, name, tierIndex, image, price, stock })),
		[
			{ modelId: "12", name: "杏粉色 / 34×47×10cm", tierIndex: [0, 0], image: "https://down-tw.img.susercontent.com/file/pink", price: 129, stock: 50 },
			{ modelId: "11", name: "灰色 / 34×47×10cm", tierIndex: [1, 0], image: "https://down-tw.img.susercontent.com/file/grey", price: 159, stock: 10 },
		],
	);
	assert.equal(result.name, "当前商品资料");
	assert.equal(result.status, 8);
	assert.equal(result.priceMin, 129);
	assert.equal(result.priceMax, 159);
	assert.equal(result.stockTotal, 60);
	assert.equal(result.imageError, null);
	assert.ok(result.detailReadAt);
	assert.deepEqual(cached, before);
});
test("null 缺图、旧有图片和无规格缓存都只读一次真实详情", async () => {
	for (const fact of [
		cached,
		{ ...cached, models: cached.models!.map((m) => ({ ...m, image: "https://img.example/old.jpg" })) },
		{ ...cached, models: null },
	]) {
		const f = reader();
		const result = await enrichProductImages(target, fact, f.driver);
		assert.equal(f.reads(), 1);
		assert.equal(result.models?.[0]?.image, "https://down-tw.img.susercontent.com/file/pink");
	}
});
test("经详情确认的单 SKU 无变体可展示商品主图，多个 SKU 绝不借用主图", async () => {
	for (const single of [true, false]) {
		const f = reader();
		f.value.images = ["product-image"];
		f.value.std_tier_variation_list = [];
		f.value.model_list = productInfoOf({
			data: {
				product_info: {
					model_list: single
						? [{ id: "11", tier_index: [] }]
						: [
								{ id: "11", tier_index: [] },
								{ id: "12", tier_index: [] },
							],
				},
			},
		}).model_list;
		const result = await enrichProductImages(target, cached, f.driver);
		assert.equal(result.models?.[0]?.image, single ? "https://down-tw.img.susercontent.com/file/product-image" : null);
		assert.equal(result.models?.[0]?.imageSource, single ? "product" : undefined);
	}
});
test("单 SKU 仍有实际变体时不借用商品主图，原生 SKU 图保留来源", async () => {
	const f = reader();
	f.value.model_list = [f.value.model_list![0]!];
	f.value.std_tier_variation_list![0]!.value_list![0]!.image_id = null;
	const result = await enrichProductImages(target, cached, f.driver);
	assert.equal(result.models?.[0]?.image, null);
	assert.equal(result.models?.[0]?.imageSource, undefined);
	f.value.model_list![0]!.sku_image = "direct-sku-image";
	const direct = await enrichProductImages(target, cached, f.driver);
	assert.equal(direct.models?.[0]?.image, "https://down-tw.img.susercontent.com/file/direct-sku-image");
	assert.equal(direct.models?.[0]?.imageSource, "sku");
});
test("未返回变体列表不等于确认无变体，不借用主图或推定默认规格", async () => {
	for (const tierIndex of [[], [0]]) {
		const f = reader();
		f.value.model_list = productInfoOf({ data: { product_info: { model_list: [{ id: "11", tier_index: tierIndex }] } } }).model_list;
		f.value.std_tier_variation_list = undefined;
		const result = await enrichProductImages(target, cached, f.driver);
		assert.equal(result.models?.[0]?.image, null);
		assert.equal(result.models?.[0]?.imageSource, undefined);
		assert.equal(result.models?.[0]?.name, "规格名未知");
	}
});
test("详情失败、店铺不符、商品编号不符及重复/缺失规格编号均回退原快照并说明", async () => {
	for (const failure of ["read", "identity", "product", "duplicate", "model", "missing"] as const) {
		const f = reader();
		if (failure === "read")
			f.driver.detail = async () => {
				throw new Error("登录已失效");
			};
		if (failure === "identity") f.driver.identity = async () => ({ username: "other", shopId: "other" });
		if (failure === "product") f.value.id = "other";
		if (failure === "duplicate") f.value.model_list!.push(f.value.model_list![0]!);
		if (failure === "model") f.value.model_list![0]!.id = undefined;
		if (failure === "missing") f.value.model_list = [];
		const result = await enrichProductImages(target, cached, f.driver);
		assert.match(result.imageError ?? "", /读取失败.*快照/);
		assert.equal(result.detailReadAt, null);
		assert.deepEqual(
			{ ...result, imageError: undefined, detailReadAt: undefined, productImages: undefined, description: undefined, sizeChartImage: undefined },
			{ ...cached, imageError: undefined, detailReadAt: undefined, productImages: undefined, description: undefined, sizeChartImage: undefined },
		);
		assert.equal(Boolean(result.productImages?.length), ["duplicate", "model", "missing"].includes(failure));
	}
});

test("SKU 未返回时仍展示同次读取的商品描述和详情图，身份错误时不展示其他店内容", async () => {
	const f = reader();
	f.value.model_list = [];
	f.value.description_info = {
		description_type: "json",
		description: JSON.stringify({
			field_list: [
				{ type: 0, value: "尺寸以规格选择为准" },
				{ type: 1, value: "detail-size" },
			],
		}),
	};
	const result = await enrichProductImages(target, cached, f.driver);
	assert.deepEqual(result.description, {
		blocks: [
			{ type: "text", text: "尺寸以规格选择为准" },
			{ type: "image", src: "https://down-tw.img.susercontent.com/file/detail-size" },
		],
		error: null,
	});
	assert.deepEqual(result.models, cached.models);
	assert.match(result.imageError ?? "", /规格.*快照/);
	f.driver.identity = async () => ({ username: "other", shopId: "other" });
	assert.equal((await enrichProductImages(target, cached, f.driver)).description, undefined);
});
test("单件 product 的 DB 路径只允许 select，现读的多个 SKU 不写回旧快照", async () => {
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
	assert.equal(result.product.models?.length, 2);
	assert.equal(result.product.models?.[0]?.image, "https://down-tw.img.susercontent.com/file/pink");
	assert.equal(result.product.status, 8);
	assert.deepEqual(result.product.suppliers, []);
	assert.equal(result.product.imageError, null);
	assert.equal(cached.models?.length, 1);
	const cacheOnly = await readProduct(
		run as unknown as Sql,
		target.shop,
		cached.productId,
		{
			...f.driver,
			detail: async () => {
				throw new Error("缓存单件禁止读取外站");
			},
		},
		true,
	);
	assert.equal(cacheOnly.product.models?.length, 1);
	assert.equal(cacheOnly.product.imageError, null);
	assert.equal(cacheOnly.product.detailReadAt, null);
});
