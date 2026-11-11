// 规格图覆盖按SKU定位、拒绝共享选项冲突，并保留货源与核价事实。
import assert from "node:assert/strict";
import test from "node:test";
import { type Offer, OfferId, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import { skuImagesSchema, withSkuImages } from "./sku-images.ts";
import { type Specs, specsFrom } from "./variants.ts";

const offer: Offer = {
	offerId: OfferId.parse("1094968351184"),
	url: "https://detail.1688.com/offer/1094968351184.html",
	title: "带盖餐碗套装",
	image: "https://example.com/source-main.jpg",
	unit: "套",
	minQty: 1,
	props: [
		{
			name: "规格",
			values: [
				{ name: "1100ml含袋", image: "https://example.com/source-1100.jpg" },
				{ name: "1550ml含袋", image: "https://example.com/source-1550.jpg" },
			],
		},
	],
	skus: [
		{
			skuId: SkuId.parse("1100"),
			specId: SpecId.parse("s1100"),
			name: "1100ml含袋",
			attrs: ["1100ml含袋"],
			price: 17.5,
			stock: 10,
			image: "https://example.com/source-1100.jpg",
			weightKg: 0.43,
		},
		{
			skuId: SkuId.parse("1550"),
			specId: SpecId.parse("s1550"),
			name: "1550ml含袋",
			attrs: ["1550ml含袋"],
			price: 18,
			stock: 20,
			image: "https://example.com/source-1550.jpg",
			weightKg: 0.46,
		},
	],
};

test("按SKU替换对应规格图，来源事实、规格名、定价与库存保持不变", () => {
	const beforeOffer = structuredClone(offer);
	const specs = specsFrom(offer).specs;
	const beforeSpecs = structuredClone(specs);
	const result = withSkuImages(specs, skuImagesSchema.parse([{ skuId: "1550", url: "http://127.0.0.1:8768/1550-trad.png" }]));
	assert.equal(result.tiers[0]!.options[0]!.image, "https://example.com/source-1100.jpg");
	assert.equal(result.tiers[0]!.options[1]!.image, "http://127.0.0.1:8768/1550-trad.png");
	assert.deepEqual(result.variants, beforeSpecs.variants);
	assert.deepEqual(
		result.tiers[0]!.options.map(({ source, name }) => ({ source, name })),
		beforeSpecs.tiers[0]!.options.map(({ source, name }) => ({ source, name })),
	);
	assert.deepEqual(specs, beforeSpecs);
	assert.deepEqual(offer, beforeOffer);
});

test("未知或已从本稿排除的SKU不能写入规格图", () => {
	const specs = specsFrom(offer).specs;
	assert.throws(() => withSkuImages(specs, skuImagesSchema.parse([{ skuId: "unknown", url: "https://example.com/image.jpg" }])), /未选用.*unknown/);
	const selected = { ...specs, variants: specs.variants.filter((v) => v.skuId !== "1550") };
	assert.throws(() => withSkuImages(selected, skuImagesSchema.parse([{ skuId: "1550", url: "https://example.com/image.jpg" }])), /未选用.*1550/);
});

const shared = (): Specs => ({
	tiers: [
		{ source: "颜色", name: "顏色", options: [{ source: "黑", name: "黑", image: "https://example.com/black.jpg" }] },
		{
			source: "尺寸",
			name: "尺寸",
			options: [
				{ source: "小", name: "小" },
				{ source: "大", name: "大" },
			],
		},
	],
	variants: specsFrom(offer).specs.variants.map((v, i) => ({ ...v, options: [0, i] })),
});

test("同一第一层选项不能按不同SKU指定冲突的图片", () => {
	assert.throws(
		() =>
			withSkuImages(
				shared(),
				skuImagesSchema.parse([
					{ skuId: "1100", url: "https://example.com/small.jpg" },
					{ skuId: "1550", url: "https://example.com/large.jpg" },
				]),
			),
		/同一第一层.*不同图片/,
	);
});

test("共用第一层选项的多个SKU可指定同一张审核图", () => {
	const result = withSkuImages(
		shared(),
		skuImagesSchema.parse([
			{ skuId: "1100", url: "https://example.com/black-trad.png" },
			{ skuId: "1550", url: "https://example.com/black-trad.png" },
		]),
	);
	assert.equal(result.tiers[0]!.options[0]!.image, "https://example.com/black-trad.png");
	assert.deepEqual(
		result.variants.map((v) => v.options),
		[
			[0, 0],
			[0, 1],
		],
	);
});

test("重复SKU输入拒绝，不传覆盖时保留原行为", () => {
	const specs = specsFrom(offer).specs;
	assert.equal(withSkuImages(specs), specs);
	assert.throws(
		() =>
			withSkuImages(
				specs,
				skuImagesSchema.parse([
					{ skuId: "1100", url: "https://example.com/a.jpg" },
					{ skuId: "1100", url: "https://example.com/a.jpg" },
				]),
			),
		/重复.*1100/,
	);
	assert.equal(skuImagesSchema.safeParse([{ skuId: "1100", url: "file:///tmp/private.png" }]).success, false);
});
