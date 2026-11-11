// 显式代发成本、计费重与售价和来源事实分开；重核、重做保留输入，超目标只报问题。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Offer, OfferId, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import { estimateNeeds, pricingProblems, reprice, settingsOf, variantTemplatePrice } from "./pricing.ts";
import { applyPricingInputs, pricingInputsParams } from "./pricing-input.ts";
import { templateParams, templatePrice } from "./template-pricing.ts";
import { specsFrom, specsOf } from "./variants.ts";

const params = templateParams.parse({ fx: 4.8, feeRate: 0.16, freightPerKgRmb: 10, labelFeeRmb: 1.5, minMargin: 0.2, maxMargin: 0.3 });
const input = { costRmb: 16, chargeableWeightKg: 0.6, priceTwd: 219, sourceEvidence: "单件代发栏16元；计费重保守估计" };

function settings() {
	return settingsOf({
		shop: "ni1206",
		shop_id: "348425",
		pricing_template: params,
		fx: "4.8",
		price_per_kg_rmb: "10",
		label_fee_rmb: "1.5",
		weight_rounding_kg: "0.01",
		return_loss_rate: "0",
		min_margin_rate: "0.2",
		min_margin_rmb: "0",
		commission_rate: "0.16",
		pre_order_rate: "0",
		payment_rate: "0",
		coin_rate: "0",
		free_shipping_rate: "0",
		free_shipping_min_twd: "0",
		shipping_net_twd: "0",
		pre_order: true,
		min_purchase: 1,
		stock_cap: 50,
		channels: "30005",
		categories: null,
		watermark_text: "shop",
		watermark_size: 20,
		watermark_opacity: "0.2",
		watermark_position: "bottom-right",
		paused: null,
	});
}
function offer(): Offer {
	return {
		offerId: OfferId.parse("1038501266685"),
		url: "https://detail.1688.com/offer/1038501266685.html",
		title: "710ml吸管杯",
		image: "",
		unit: "个",
		minQty: 1,
		freight: { costRmb: 5, to: "东莞" },
		props: [
			{
				name: "颜色",
				values: [
					{ name: "玉桂狗", image: "cinnamoroll.jpg" },
					{ name: "库洛米", image: "kuromi.jpg" },
				],
			},
		],
		skus: ["玉桂狗", "库洛米"].map((name, i) => ({
			skuId: SkuId.parse(String(i + 1)),
			specId: SpecId.parse(`spec-${i}`),
			name,
			attrs: [name],
			price: 15.84,
			stock: 50,
			image: `${i}.jpg`,
			weightKg: 0.4,
		})),
	};
}
function explicitSpecs() {
	const base = specsFrom(offer()).specs;
	return specsOf({ ...base, variants: base.variants.map((v) => ({ ...v, pricingInput: input, costRmb: 16, weightKg: 0.6, priceTwd: 219 })) })!;
}
const snapshot = { model: "template" as const, params, freightRmb: 5 };

test("显式代发输入不覆盖采购来源，重核保留0.6kg与219元，不退回报重和最低价", () => {
	const source = offer(),
		before = structuredClone(source),
		specs = explicitSpecs();
	const result = reprice({ offer: source, variants: specs, pricing: snapshot }, settings())!;
	assert.deepEqual(source, before);
	assert.equal(source.skus[0]!.price, 15.84);
	assert.equal(source.skus[0]!.weightKg, 0.4);
	assert.equal(result.specs.variants[0]!.costRmb, 16);
	assert.equal(result.specs.variants[0]!.weightKg, 0.6);
	assert.equal(result.specs.variants[0]!.priceTwd, 219);
	assert.equal(result.changed, false);
	assert.deepEqual(pricingProblems(result.specs, []), []);
	const calculated = templatePrice({ key: "cup", costRmb: 16, weightKg: 0.6, freightRmb: 5, currentTwd: 219, units: 1 }, params);
	assert.ok(Math.abs(calculated.current!.margin - 0.2563600782778864) < 1e-12);
});

test("重新做规格按来源skuId继承核价输入，新读取的采购价与报重仍保留原值", () => {
	const previous = explicitSpecs(),
		source = offer();
	source.skus.reverse();
	const built = specsFrom(source, [], previous).specs;
	for (const v of built.variants) assert.deepEqual(v.pricingInput, input);
	const next = reprice({ offer: source, variants: built, pricing: snapshot }, settings())!;
	assert.deepEqual(
		next.specs.variants.map((v) => [v.costRmb, v.weightKg, v.priceTwd]),
		[
			[16, 0.6, 219],
			[16, 0.6, 219],
		],
	);
	assert.deepEqual(
		source.skus.map((s) => [s.price, s.weightKg]),
		[
			[15.84, 0.4],
			[15.84, 0.4],
		],
	);
});

test("超出当前输入区间时保留指定售价并返回待核问题，参数变化后重新验证", () => {
	const s = settings(),
		specs = explicitSpecs();
	s.template = { ...params, minMargin: 0.26 };
	const next = reprice({ offer: offer(), variants: specs, pricing: snapshot }, s)!;
	assert.equal(next.specs.variants[0]!.priceTwd, 219);
	assert.deepEqual(next.specs.variants[0]!.pricingInput, input);
	assert.ok(pricingProblems(next.specs, []).every((p) => p.includes("不在输入区间26.00%–30.00%")));
	assert.equal(next.changed, true);
	const fixed = reprice({ offer: offer(), variants: next.specs, pricing: { ...snapshot, params: s.template! } }, settings())!;
	assert.equal(fixed.specs.variants[0]!.priceTwd, 219);
	assert.deepEqual(pricingProblems(fixed.specs, []), []);
	assert.equal(fixed.changed, true);
});

test("只设置指定skuId的输入，未给的SKU、库存、图片和规格名保持原样", () => {
	const specs = specsFrom(offer()).specs,
		before = structuredClone(specs);
	const items = [{ skuId: specs.variants[0]!.skuId, ...input }];
	const next = applyPricingInputs(specs, items);
	assert.deepEqual(specs, before);
	assert.deepEqual(next.variants[1], before.variants[1]);
	assert.deepEqual(next.tiers, before.tiers);
	assert.equal(next.variants[0]!.stock, before.variants[0]!.stock);
	assert.deepEqual(next.variants[0]!.pricingInput, input);
	assert.throws(() => applyPricingInputs(specs, [...items, ...items]), /重复/);
	assert.throws(() => applyPricingInputs(specs, [{ ...input, skuId: SkuId.parse("unknown") }]), /没有 SKU/);
	assert.equal(pricingInputsParams.safeParse({ id: "1", items: [{ ...items[0], costRmb: null }] }).success, false);
	assert.equal(pricingInputsParams.safeParse({ id: "1", items: [{ ...items[0], chargeableWeightKg: 0 }] }).success, false);
	assert.equal(pricingInputsParams.safeParse({ id: "1", items: [{ ...items[0], priceTwd: 219.9 }] }).success, false);
});

test("缺国内运费不补零；显式计费重量不再被来源缺重误判为未知", () => {
	const source = offer();
	delete source.freight;
	for (const s of source.skus) s.weightKg = null;
	const specs = explicitSpecs();
	const next = reprice({ offer: source, variants: specs, pricing: { ...snapshot, freightRmb: null } }, settings())!;
	assert.equal(next.freightRmb, null);
	assert.deepEqual(estimateNeeds({ offer: source, variants: next.specs }), ["国内运费"]);
	assert.equal(next.specs.variants[0]!.weightKg, 0.6);
	assert.equal(next.specs.variants[0]!.priceTwd, 219);
	assert.match(next.specs.variants[0]!.pricingProblem!, /缺国内运费/);
});

test("没有显式输入时仍沿用原来的报重与自动最低尾9价", () => {
	const source = offer(),
		specs = specsFrom(source).specs;
	const next = reprice({ offer: source, variants: specs, pricing: snapshot }, settings())!;
	assert.deepEqual(
		next.specs.variants.map((v) => [v.costRmb, v.weightKg, v.priceTwd]),
		[
			[15.84, 0.4, 189],
			[15.84, 0.4, 189],
		],
	);
	assert.deepEqual(pricingProblems(next.specs, []), []);
});

test("真实两件起购按订单数量核价，每单位国内运费须显式提供，改单件立即重核", () => {
	const source = offer();
	source.freight = { costRmb: 3, to: "东莞" };
	for (const sku of source.skus) sku.weightKg = 0.003;
	const items = source.skus.map((sku) => ({ skuId: sku.skuId, costRmb: 6.26, chargeableWeightKg: 0.4, priceTwd: 105, freightRmbPerUnit: 3 }));
	const parsed = pricingInputsParams.parse({ id: "1", items });
	assert.equal(parsed.items[0]!.freightRmbPerUnit, 3);
	const specs = applyPricingInputs(specsFrom(source).specs, parsed.items);
	const draft = { offer: source, variants: specs, min_purchase: 2, pricing: { ...snapshot, freightRmb: 3, minimumPurchase: 2 } };
	const two = reprice(draft, settings())!;
	assert.deepEqual(pricingProblems(two.specs, []), []);
	assert.equal(two.specs.variants[0]!.priceTwd, 105);
	assert.equal(two.specs.variants[0]!.weightKg, 0.4, "不能被来源3g报重覆盖显式计费估重");
	assert.equal(two.changed, true, "首次显式核价输入须写回实际成本、计费重和售价");
	assert.equal(reprice({ ...draft, variants: two.specs }, settings())!.changed, false);
	const calculation = variantTemplatePrice(two.specs.variants[0]!, two.freightRmb, params, two.minimumPurchase);
	assert.equal(calculation.units, 2);
	assert.equal(calculation.orderPaidTwd, 210);
	assert.equal(calculation.orderFreightRmb, 6);
	assert.equal(calculation.totalCostRmb, 28.02);
	assert.ok(Math.abs(calculation.current!.margin - 0.23755102040816328) < 1e-12);
	assert.ok(Math.abs(calculation.current!.profitRmb - 8.73) < 1e-12);
	const one = reprice({ ...draft, min_purchase: 1 }, settings())!;
	assert.match(pricingProblems(one.specs, []).join(), /19\.67%/);
	assert.equal(one.changed, true, "不能复用最低两件订单的通过状态");
	const remade = specsFrom(source, [], two.specs).specs;
	assert.equal(remade.variants[0]!.pricingInput?.freightRmbPerUnit, 3);
	delete source.freight;
	assert.deepEqual(estimateNeeds({ offer: source, variants: specs }), [], "每SKU显式国内运费已知，不补造源整单运费");
});

test("未声明每单位国内运费时保留旧整单一次性口径，不默默改变运费假设", () => {
	const source = offer();
	source.freight = { costRmb: 3, to: "东莞" };
	const specs = applyPricingInputs(
		specsFrom(source).specs,
		source.skus.map((sku) => ({ skuId: sku.skuId, costRmb: 6.26, chargeableWeightKg: 0.4, priceTwd: 105 })),
	);
	const two = reprice({ offer: source, variants: specs, min_purchase: 2 }, settings())!;
	assert.match(pricingProblems(two.specs, []).join(), /31\.92%/);
	for (const freightRmbPerUnit of [-1, Number.NaN, Number.POSITIVE_INFINITY])
		assert.equal(pricingInputsParams.safeParse({ id: "1", items: [{ ...input, skuId: "1", freightRmbPerUnit }] }).success, false);
});
