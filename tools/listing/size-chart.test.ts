// 尺码图的归属、源规格与人工覆盖保护；组装原生提交字段和发布指纹，不连库、不传图。
import assert from "node:assert/strict";
import { test } from "node:test";
import { OfferId, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import type { Settings } from "./pricing.ts";
import { productOf } from "./ready.ts";
import { ListingId, type ListingRow } from "./row.ts";
import { listingSizeChartParams, type SizeChart, sizeChartEditable, sizeChartOf, sizeChartScope } from "./size-chart.ts";
import { specsOf } from "./variants.ts";

function draft(): ListingRow {
	return {
		id: ListingId.parse("190"),
		shop: "cheeroutdoor",
		offer_id: OfferId.parse("123"),
		strategy: "人选",
		cancelled: false,
		weight_kg: null,
		freight_rmb: null,
		title: "居家保暖毛絨拖鞋",
		description: "尺碼照貨源標示，單雙販售。",
		note: null,
		noted: null,
		nickname: "毛绒拖鞋",
		offer: {
			offerId: OfferId.parse("123"),
			url: "https://detail.1688.com/offer/123.html",
			title: "毛绒拖鞋",
			image: "https://source/slippers.jpg",
			unit: "双",
			minQty: 1,
			props: [],
			skus: [
				{
					skuId: SkuId.parse("sku36"),
					specId: SpecId.parse("spec36"),
					name: "36-37建议35-36",
					attrs: ["36-37建议35-36"],
					price: 10,
					stock: 20,
					weightKg: 0.3,
					image: "",
				},
				{
					skuId: SkuId.parse("sku38"),
					specId: SpecId.parse("spec38"),
					name: "38-39建议37-38",
					attrs: ["38-39建议37-38"],
					price: 10,
					stock: 20,
					weightKg: 0.3,
					image: "",
				},
			],
			tags: { onePsale: true, ship48h: true, freeShipping: true, deliveryDays: 2 },
		},
		offer_read_at: new Date(0),
		category_id: "100596",
		category_path: [100532, 100561, 100596],
		category_name: "拖鞋",
		attributes: [],
		attributes_text: null,
		days_to_ship: 10,
		variants: {
			tiers: [{ source: "尺码", name: "尺碼", options: [{ source: "36-37建议35-36", name: "36-37 建議35-36", image: null }] }],
			variants: [{ sku: "LT123-spec36", skuId: "sku36", specId: "spec36", options: [0], costRmb: 10, weightKg: 0.3, priceTwd: 299, stock: 20 }],
		},
		images: { main: [{ from: "https://source/slippers.jpg", imageId: "slippers", width: 800, height: 800 }], detail: [], options: [] },
		pricing: null,
		audit: null,
		problems: null,
		step: null,
		step_detail: null,
		product_id: null,
		listed_at: null,
		removed_images: [],
		removed_variants: [],
		kept_images: [],
		pick_why: null,
		pick_evidence: null,
		pick_snapshot: null,
		created_at: new Date(0),
		updated_at: new Date(0),
	};
}

function chart(row: ListingRow): SizeChart {
	return {
		shop: row.shop,
		offerId: row.offer_id,
		source: "/tmp/reviewed-slipper-sizes.png",
		sha256: "a".repeat(64),
		imageId: "tw-11134207-sizechart",
		width: 800,
		height: 800,
		evidence: "https://detail.1688.com/offer/123.html：36-37建议35-36；未提供内长，不推断cm",
		scope: sizeChartScope(row),
		at: "2026-11-11T00:00:00.000Z",
	};
}

const settings: Settings = {
	shop: "cheeroutdoor",
	shopId: "1554182542",
	params: {
		fx: 4.8,
		pricePerKgRmb: 10,
		labelFeeRmb: 1.5,
		weightRoundingKg: 0.01,
		returnLossRate: 0,
		minMarginRate: 0.2,
		minMarginRmb: 0,
		commissionRate: 0.16,
		preOrderRate: 0,
		paymentRate: 0,
		coinRate: 0,
		freeShippingRate: 0,
		freeShippingMinTwd: 0,
		shippingNetTwd: 0,
	},
	template: null,
	mark: null,
	paused: null,
	preOrder: true,
	minPurchase: 1,
	stockCap: 50,
	channels: ["30020"],
	categories: null,
};

test("尺码图命令接受HTTP(S)或本地绝对路径，必须给真实来源证据与显式替换标志", () => {
	const input = { id: "190", source: "/tmp/size-chart.png", evidence: "1688真实规格标码" };
	assert.deepEqual(listingSizeChartParams.parse(input), { ...input, replace: false });
	assert.equal(listingSizeChartParams.parse({ ...input, replace: "true" }).replace, true);
	assert.equal(listingSizeChartParams.parse({ ...input, source: "https://cbu01.alicdn.com/size-chart.png" }).source, "https://cbu01.alicdn.com/size-chart.png");
	for (const source of ["", "relative.png", "file:///tmp/size-chart.png", "ftp://source/chart.png", "data:image/png;base64,AA=="])
		assert.equal(listingSizeChartParams.safeParse({ ...input, source }).success, false);
	for (const evidence of [undefined, null, " "]) assert.equal(listingSizeChartParams.safeParse({ ...input, evidence }).success, false);
});

test("已建或已上架稿绝不改尺码图；人工图仅显式替换", () => {
	const row = draft();
	assert.doesNotThrow(() => sizeChartEditable(row));
	row.size_chart = chart(row);
	assert.throws(() => sizeChartEditable(row), /--replace/);
	assert.doesNotThrow(() => sizeChartEditable(row, true));
	for (const changed of [{ product_id: "123" }, { product_id: "" }, { listed_at: new Date(0) }])
		assert.throws(() => sizeChartEditable({ ...row, ...changed }, true), /已经建成或上架/);
});

test("尺码图归属及源规格绑定不受价格、库存和译名影响，源尺寸变化须重新审核", () => {
	const row = draft();
	row.size_chart = chart(row);
	const original = structuredClone(row);
	assert.equal(sizeChartOf(row), row.size_chart.imageId);
	assert.equal(sizeChartOf({ ...row, size_chart: null }), null);
	assert.equal(sizeChartOf({ ...row, size_chart: undefined }), null);
	const translated = structuredClone(row),
		specs = specsOf(translated.variants)!;
	specs.tiers[0]!.name = "鞋碼";
	specs.tiers[0]!.options[0]!.name = "36-37";
	specs.variants[0]!.priceTwd = 309;
	specs.variants[0]!.stock = 1;
	translated.variants = specs;
	translated.offer!.skus[0]!.price = 12;
	assert.equal(sizeChartOf(translated), row.size_chart.imageId);
	for (const change of [{ shop: "ni1206" }, { offer_id: OfferId.parse("456") }]) assert.throws(() => sizeChartOf({ ...row, ...change }), /已变/);
	const altered = structuredClone(row);
	altered.offer!.skus[0]!.attrs = ["36-37内长23cm"];
	assert.throws(() => sizeChartOf(altered), /已变/);
	const swapped = structuredClone(row),
		swappedSpecs = specsOf(swapped.variants)!;
	swappedSpecs.variants[0]!.skuId = SkuId.parse("sku38");
	swapped.variants = swappedSpecs;
	assert.throws(() => sizeChartOf(swapped), /已变/);
	assert.throws(() => sizeChartOf({ ...row, size_chart: { ...row.size_chart!, imageId: "" } }), /元数据不完整/);
	assert.deepEqual(row, original);
});

test("尺码图进入原生提交与发布指纹；旧稿仍为空，失配图不能进入提交", () => {
	const row = draft(),
		without = productOf(row, settings);
	assert.deepEqual(without.problems, []);
	assert.deepEqual(without.info?.size_chart_info, { size_chart: "" });
	row.size_chart = chart(row);
	const result = productOf(row, settings);
	assert.deepEqual(result.problems, []);
	assert.equal(result.product?.sizeChart, row.size_chart.imageId);
	assert.deepEqual(result.info?.size_chart_info, { size_chart: row.size_chart.imageId });
	assert.notEqual(result.hash, without.hash);
	assert.equal(productOf({ ...row, size_chart: { ...row.size_chart, shop: "ni1206" } }, settings).info, undefined);
	assert.match(productOf({ ...row, size_chart: { ...row.size_chart, scope: "b".repeat(64) } }, settings).problems.join(), /已选源规格已变/);
});
