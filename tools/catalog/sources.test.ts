// 已有 SKU 对照是唯一关联依据；不把商品稿待发布的规格、图片或供应商库存当成 Shopee 事实。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductFact } from "./facts.ts";
import { type CatalogSourceRow, enrichProductSources } from "./sources.ts";

const target = { shop: "fixture", shopId: "10" };
const fact: ProductFact = {
	productId: "42",
	name: "商品",
	parentSku: "LT100",
	cover: null,
	status: 1,
	reportedStatus: 1,
	statusLabel: "在售",
	unlisted: false,
	models: [{ modelId: "11", sku: "SHOP-SKU", name: "Shopee 規格", tierIndex: [0], image: "https://shop.example/sku.jpg", price: 129, stock: 50 }],
	priceMin: 129,
	priceMax: 129,
	stockTotal: 50,
	stockState: "in_stock",
	detailError: null,
};
function row(): CatalogSourceRow {
	return {
		...target,
		productId: "42",
		offerId: "100",
		readAt: new Date("2026-11-04T06:00:28.908Z"),
		variants: {
			variants: [
				{ sku: "SHOP-SKU", skuId: "200", specId: "abc", options: [3] },
				{ sku: "NOT-LIVE", skuId: "201", specId: "def", options: [0] },
			],
		},
		offer: {
			offerId: "100",
			skus: [
				{ skuId: "201", specId: "def", name: "另一规格", attrs: ["蓝"], image: "https://supplier.example/other.jpg", stock: 999 },
				{ skuId: "200", specId: "abc", name: "无盖款-杏粉色24格（34x47x10cm)", attrs: ["杏粉色"], image: "https://supplier.example/sku.jpg", stock: 888 },
			],
		},
	};
}

test("按店铺、商品、精确 SKU 及 skuId+specId 展示 1688 原规格，不改变 Shopee 资料或加入草稿 SKU", () => {
	const before = structuredClone(fact);
	const result = enrichProductSources(target, fact, [row()]);
	assert.equal(result.models?.length, 1);
	assert.deepEqual(result.models?.[0]?.source, {
		offerId: "100",
		skuId: "200",
		specId: "abc",
		name: "无盖款-杏粉色24格（34x47x10cm)",
		image: "https://supplier.example/sku.jpg",
		url: "https://detail.1688.com/offer/100.html",
		readAt: "2026-11-04T06:00:28.908Z",
		basis: "listing_sku",
	});
	assert.equal(result.models?.[0]?.sourceWarning, null);
	assert.deepEqual({ ...result.models![0], source: undefined, sourceWarning: undefined }, { ...fact.models![0], source: undefined, sourceWarning: undefined });
	assert.deepEqual(fact, before);
	assert.equal(result.stockTotal, 50);
});

test("其他店铺、账号或商品的同名同 SKU 不能成为对应", () => {
	for (const replacement of [{ shop: "other" }, { shopId: "20" }, { productId: "43" }]) {
		const result = enrichProductSources(target, fact, [{ ...row(), ...replacement }]);
		assert.equal(result.models?.[0]?.source, null);
		assert.match(result.models?.[0]?.sourceWarning ?? "", /未保存/);
	}
});

test("不从 LT 货号、名称或 tierIndex 推测；缺 SKU、旧格式和源编号冲突明确待核对", () => {
	const missingSku = structuredClone(fact);
	missingSku.models![0]!.sku = null;
	assert.equal(enrichProductSources(target, missingSku, [row()]).models?.[0]?.source, null);
	const wrongSku = row();
	wrongSku.variants = { variants: [{ sku: "LT100-abc", skuId: "200", specId: "abc" }] };
	assert.match(enrichProductSources(target, fact, [wrongSku]).models?.[0]?.sourceWarning ?? "", /没有此 SKU/);
	assert.match(enrichProductSources(target, fact, [{ ...row(), variants: [] }]).models?.[0]?.sourceWarning ?? "", /资料不完整/);
	assert.match(enrichProductSources(target, fact, [{ ...row(), offerId: "101" }]).models?.[0]?.sourceWarning ?? "", /编号.*不一致/);
});

test("多映射、重复源规格或 specId 不一致时不接受看似相同的 skuId", () => {
	assert.match(enrichProductSources(target, fact, [row(), row()]).models?.[0]?.sourceWarning ?? "", /多个货源对应/);
	const duplicated = row();
	duplicated.offer = { offerId: "100", skus: [0, 1].map(() => ({ skuId: "200", specId: "abc", name: "同名" })) };
	assert.match(enrichProductSources(target, fact, [duplicated]).models?.[0]?.sourceWarning ?? "", /重复规格/);
	const mismatch = row();
	mismatch.offer = { offerId: "100", skus: [{ skuId: "200", specId: "other", name: "同名" }] };
	assert.match(enrichProductSources(target, fact, [mismatch]).models?.[0]?.sourceWarning ?? "", /同时匹配 skuId 和 specId/);
});

test("Shopee 多个 modelId 共用一个 SKU 时不把唯一商品稿对应套到多行", () => {
	const duplicated = structuredClone(fact);
	duplicated.models!.push({ ...duplicated.models![0]!, modelId: "12", name: "另一 Shopee 規格", tierIndex: [1] });
	const result = enrichProductSources(target, duplicated, [row()]);
	assert.equal(result.models?.length, 2);
	for (const model of result.models!) {
		assert.equal(model.source, null);
		assert.match(model.sourceWarning ?? "", /同一 SKU 对应多个规格/);
	}
});

test("1688 无 specId 的原生单 SKU 可按完整对应展示，非法图片 URL 保留缺图", () => {
	const single = row();
	single.variants = { variants: [{ sku: "SHOP-SKU", skuId: "100", specId: "" }] };
	single.offer = { offerId: "100", skus: [{ skuId: "100", specId: "", name: "", attrs: [], image: "javascript:bad()" }] };
	single.readAt = null;
	const source = enrichProductSources(target, fact, [single]).models?.[0]?.source;
	assert.equal(source?.name, "规格名未提供");
	assert.equal(source?.image, null);
	assert.equal(source?.readAt, null);
	assert.equal(enrichProductSources(target, { ...fact, models: null }, [single]).models, null);
});
