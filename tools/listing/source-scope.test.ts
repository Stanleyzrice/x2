// 精确货源范围与make参数：保留源事实，只处理明确选择的SKU和图片。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Offer, OfferId, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import { listing } from "./index.ts";
import { sourceScope } from "./source-scope.ts";
import { specsFrom } from "./variants.ts";

const offer: Offer = {
	offerId: OfferId.parse("123"),
	url: "https://detail.1688.com/offer/123.html",
	title: "商品",
	image: "https://example.com/a.jpg",
	unit: "件",
	minQty: 1,
	props: [],
	skus: ["a", "b"].map((id) => ({
		skuId: SkuId.parse(id),
		specId: SpecId.parse(id),
		name: id,
		attrs: [],
		price: 10,
		stock: 5,
		image: `https://example.com/${id}.jpg`,
	})),
};

test("显式来源范围只保留指定SKU，不改货源快照，重做仍排除其他规格", () => {
	const before = structuredClone(offer);
	const removed = sourceScope(offer, ["b"], ["LT123-b"]);
	assert.deepEqual(
		specsFrom(offer, removed).specs.variants.map((v) => v.skuId),
		["b"],
	);
	assert.deepEqual(offer, before);
	assert.deepEqual(sourceScope(offer, undefined, removed), removed);
	assert.throws(() => sourceScope(offer, ["missing"], []), /不存在/);
	assert.throws(() => sourceScope({ ...offer, skus: offer.skus.map((s) => ({ ...s, stock: 0 })) }, ["b"], []), /无库存/);
});

test("单稿make接受精确SKU和显式图片；不允许把同一范围套给多稿", () => {
	const p = listing.tools.make!.params;
	const input = { ids: "1", sourceSkuIds: ["b"], mainImages: ["https://example.com/b.jpg"], detailImages: [] };
	const parsed = p.safeParse(input);
	assert.ok(parsed.success);
	if (parsed.success) assert.deepEqual(parsed.data, { ...input, ids: ["1"], jobs: 3 });
	assert.equal(p.safeParse({ ...input, ids: "1,2" }).success, false);
	assert.equal(p.safeParse({ ...input, ids: undefined }).success, false);
	assert.equal(p.safeParse({ ...input, sourceSkuIds: [] }).success, false);
	assert.equal(p.safeParse({ ...input, sourceSkuIds: '["b"]', mainImages: '["https://example.com/b.jpg"]', detailImages: "[]" }).success, true);
});
