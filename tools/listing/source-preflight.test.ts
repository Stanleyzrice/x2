import assert from "node:assert/strict";
import { test } from "node:test";
import { OfferId } from "../../connectors/sites/1688/api.ts";
import type { Settings } from "./pricing.ts";
import { ListingId } from "./row.ts";
import type { SourceProduct } from "./source-data.ts";
import { checkSourcePreflight, sourcePreflightParams } from "./source-preflight.ts";

const template = { fx: 4.8, feeRate: 0.16, freightPerKgRmb: 10, labelFeeRmb: 1.5, minMargin: 0.2, maxMargin: 0.3 };
const policy = { requireOnePieceSale: true, requireShip48h: true, maxMinQty: 1, maxSkuCount: 50, minSinglePriceTwd: 120 };
const settings: Settings = {
	shop: "test",
	shopId: "1",
	template,
	minPurchase: 1,
	stockCap: 50,
	mark: null,
	paused: null,
	preOrder: true,
	channels: [],
	categories: null,
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
};
const snapshot: SourceProduct = {
	platform: "1688",
	sourceId: "123",
	url: "https://detail.1688.com/offer/123.html",
	title: "收納袋",
	images: [],
	props: [],
	description: { text: "", blocks: [], images: [] },
	skus: [{ id: "sku", specId: "", name: "單款", attrs: [], price: 14, stock: 10, weightKg: 0.2, image: null }],
	minQty: 1,
	freightRmb: 2,
	freeShipping: false,
	tags: { onePsale: true, ship48h: true, deliveryDays: 2, freeShipping: false },
	errors: [],
};
const check = (changes: Partial<SourceProduct> = {}, discount: number | null = 0) =>
	checkSourcePreflight(
		{ id: "1", offerId: "123", deleted: false, snapshot: { ...snapshot, ...changes } },
		undefined,
		undefined,
		settings,
		policy,
		template,
		discount,
	);

test("预检要求指定范围，链接只接收真实1688域名，空优惠不当作零", () => {
	assert.equal(sourcePreflightParams.safeParse({ shop: "test" }).success, false);
	assert.equal(sourcePreflightParams.safeParse({ shop: "test", links: "https://example.com/offer/123.html" }).success, false);
	assert.equal(sourcePreflightParams.safeParse({ shop: "test", sourceIds: "1", sellerDiscountTwd: "" }).success, false);
	assert.equal(sourcePreflightParams.parse({ shop: "test", links: snapshot.url, sellerDiscountTwd: "0" }).sellerDiscountTwd, 0);
});

test("预检从采集快照一次返回供货与成本问题，并且保留缺促销数据", () => {
	assert.equal(check().status, "can-prepare");
	assert.ok(check({}, null).issues.some(({ area, message }) => area === "cost" && message.includes("卖家承担的优惠")));
	const result = check({ tags: undefined, minQty: 2, freightRmb: null, skus: [{ ...snapshot.skus[0]!, weightKg: 0.001 }] });
	assert.equal(result.status, "needs-input");
	assert.equal(result.issues.filter(({ area }) => area === "supply").length, 3);
	for (const field of ["计费重量", "国内运费"]) assert.ok(result.issues.some(({ message, skuIds }) => message.includes(field) && skuIds?.includes("sku")));
});

test("预检根据原始规格上限、库存和现行定价结果阻止不适合成稿的货源", () => {
	const overLimit = Array.from({ length: 51 }, (_, i) => ({ ...snapshot.skus[0]!, id: String(i), stock: 0 }));
	assert.match(check({ skus: overLimit }).issues[0]!.message, /来源规格51个/);
	assert.match(check({ skus: [{ ...snapshot.skus[0]!, stock: 0 }] }).issues[0]!.message, /无有货的规格/);
	assert.ok(check({ skus: [{ ...snapshot.skus[0]!, price: 2 }] }).issues.some(({ message }) => message.includes("低于 NT$120")));
});

test("预检复用人工计费成本，并保留较高的源批发起订量", () => {
	const draft = {
		id: ListingId.parse("2"),
		shop: "test",
		offer_id: OfferId.parse("123"),
		product_id: null,
		listed_at: null,
		cancelled: false,
		source_fields: { minQty: 1 },
		removed_variants: [],
		variants: null,
		weight_kg: "0.2",
		freight_rmb: "2",
		min_purchase: null,
		pending: false,
	};
	const source = { ...snapshot, freightRmb: null, skus: [{ ...snapshot.skus[0]!, weightKg: null }] };
	const run = (minQty: number | null) =>
		checkSourcePreflight({ id: "1", offerId: "123", deleted: false, snapshot: { ...source, minQty } }, draft, undefined, settings, policy, template, 0);
	assert.equal(run(null).status, "can-prepare");
	assert.deepEqual(run(3).issues, [{ area: "supply", message: "起订量3不符合当前要求" }]);
});
