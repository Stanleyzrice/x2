// 市场试算按相同销售单位统计，成本和优惠口径仍由现有计算器负责，不推断可比性或发布许可。
import assert from "node:assert/strict";
import { test } from "node:test";
import { marketPricePreview, marketPricingInput, marketPricingTools } from "./market-pricing.ts";
import { calculatePricing, calculatorInput } from "./pricing-calculator.ts";

const template = { fx: 4.8, feeRate: 0.16, freightPerKgRmb: 10, labelFeeRmb: 1.5, minMargin: 0.2, maxMargin: 0.3 };
const sample = (sampleId: string, paidTwd: number | null, units = 1, excludeReason?: string) => ({
	sampleId,
	sourceUrl: `https://shopee.tw/product/1/${sampleId}`,
	observedAt: "2026-11-17T08:00:00Z",
	paidTwd,
	units,
	...(excludeReason ? { excludeReason } : {}),
});
const input = (changes = {}) =>
	marketPricingInput.parse({
		template,
		costRmb: 28,
		weightKg: 0.15,
		freightRmb: 0,
		units: 1,
		priceTwd: null,
		sellerDiscountTwd: 0,
		comparisonKey: "已核同材质尺寸，每套",
		marketSamples: [sample("A", 440, 2), sample("B", 240), sample("C", 900, 3)],
		referenceSampleIds: ["A", "B"],
		referenceReason: "已逐项核对的本次主流样本组",
		...changes,
	});

test("市场单价按件数归一后逐样本等权统计，主流范围只来自明确指定的组", () => {
	const result = marketPricePreview(input());
	assert.equal(result.market.rawCount, 3);
	assert.equal(result.market.validCount, 3);
	assert.equal(result.market.unknownCount, 0);
	assert.equal(result.market.excludedCount, 0);
	assert.equal(result.market.deduplicatedCount, 0);
	assert.ok(Math.abs(result.market.meanTwd! - (220 + 240 + 300) / 3) < 1e-9);
	assert.equal(result.market.medianTwd, 240);
	assert.equal(result.market.minTwd, 220);
	assert.equal(result.market.maxTwd, 300);
	assert.deepEqual(result.reference?.paidUnitBandTwd, { min: 220, max: 240 });
	assert.deepEqual(result.intersectionTwd, { min: 222, max: 240 });
	assert.equal(result.referencePosition, "OVERLAP");
	assert.equal(result.status, "CALCULATED");
	assert.ok(result.candidates.some((candidate) => candidate.priceTwd === 229));
	assert.equal(new Set(result.candidates.map((candidate) => candidate.priceTwd)).size, result.candidates.length);
	assert.ok(result.candidates.every((candidate) => candidate.priceTwd >= 222 && candidate.priceTwd <= 240 && candidate.withinTarget));
});

test("市场券后单价先加回本店每件优惠，再与标价区间取交集并复用成本函数", () => {
	const value = input({
		costRmb: 6.26,
		weightKg: 0.4,
		freightRmb: 6,
		units: 2,
		sellerDiscountTwd: 20,
		marketSamples: [sample("A", 202, 2), sample("B", 228, 2)],
	});
	const result = marketPricePreview(value);
	assert.deepEqual(result.pricing.rangeTwd, { min: 111, max: 124 });
	assert.deepEqual(result.reference?.paidUnitBandTwd, { min: 101, max: 114 });
	assert.equal(result.discountPerUnitTwd, 10);
	assert.deepEqual(result.marketListedBandTwd, { min: 111, max: 124 });
	assert.deepEqual(result.intersectionTwd, { min: 111, max: 124 });
	assert.equal(result.marketPriceCases.mean?.priceTwd, 117.5);
	for (const candidate of result.candidates) {
		const expected = calculatePricing(calculatorInput.parse({ ...value, priceTwd: candidate.priceTwd }));
		assert.equal(candidate.paidUnitTwd, candidate.priceTwd - 10);
		assert.equal(candidate.profitRmb, expected.profitRmb);
		assert.equal(candidate.margin, expected.margin);
		assert.equal(candidate.withinTarget, true);
	}
});

test("成本最低价高于主流最高价时不抬市场价或放宽目标，也不给候选", () => {
	const result = marketPricePreview(input({ marketSamples: [sample("A", 100), sample("B", 150)] }));
	assert.equal(result.referencePosition, "ABOVE_REFERENCE");
	assert.equal(result.status, "ABOVE_REFERENCE");
	assert.equal(result.intersectionTwd, null);
	assert.equal(result.candidateBasis, null);
	assert.deepEqual(result.candidates, []);
});

test("成本毛利上限价格低于主流最低价是潜在成本优势，候选保留在自身区间", () => {
	const result = marketPricePreview(input({ marketSamples: [sample("A", 300), sample("B", 400)] }));
	assert.equal(result.referencePosition, "BELOW_REFERENCE");
	assert.equal(result.status, "BELOW_REFERENCE");
	assert.equal(result.intersectionTwd, null);
	assert.equal(result.candidateBasis, "cost-range-below-reference");
	assert.ok(result.candidates.length > 0);
	assert.ok(result.candidates.every((candidate) => candidate.priceTwd >= 222 && candidate.priceTwd <= 253 && candidate.withinTarget));
	assert.ok(result.candidates.every((candidate) => candidate.basis === "cost-range-below-reference"));
});

test("连续区间相交但没有整数标价时明确说明，不强行尾9或越界取整", () => {
	const result = marketPricePreview(input({ marketSamples: [sample("A", 222.1), sample("B", 222.9)] }));
	assert.equal(result.referencePosition, "OVERLAP");
	assert.equal(result.intersectionTwd, null);
	assert.equal(result.status, "NO_INTEGER_INTERSECTION");
	assert.deepEqual(result.candidates, []);
});

test("缺成本、优惠、市场或主流组分别保持未知，不补零也不擅用全体极值作主流", () => {
	for (const changes of [{ weightKg: null }, { costRmb: null }, { freightRmb: null }, { sellerDiscountTwd: null }]) {
		const result = marketPricePreview(input(changes));
		assert.equal(result.status, "COST_DATA_INSUFFICIENT");
		assert.equal(result.pricing.profitRmb, null);
		assert.equal(result.referencePosition, null);
		assert.deepEqual(result.candidates, []);
	}
	const absent = marketPricePreview(input({ marketSamples: [], referenceSampleIds: [] }));
	assert.equal(absent.status, "NO_MARKET_DATA");
	assert.equal(absent.market.meanTwd, null);
	assert.equal(absent.market.medianTwd, null);
	assert.equal(absent.market.minTwd, null);
	assert.equal(absent.market.maxTwd, null);
	const unknown = marketPricePreview(input({ marketSamples: [sample("A", null)], referenceSampleIds: [] }));
	assert.equal(unknown.market.unknownCount, 1);
	assert.equal(unknown.market.meanTwd, null);
	assert.equal(unknown.status, "NO_MARKET_DATA");
	const noGroup = marketPricePreview(input({ referenceSampleIds: undefined, referenceReason: undefined }));
	assert.equal(noGroup.market.validCount, 3);
	assert.equal(noGroup.status, "REFERENCE_GROUP_REQUIRED");
	assert.equal(noGroup.reference, null);
	assert.equal(noGroup.marketListedBandTwd, null);
	assert.deepEqual(noGroup.candidates, []);
});

test("重复样本不增加权重；排除理由不会被同ID无理由副本覆盖，计数可对账", () => {
	const result = marketPricePreview(
		input({
			marketSamples: [sample("A", 220), sample("A", 220), sample("B", 240, 1, "材质不同"), sample("B", 240), sample("U", null)],
			referenceSampleIds: ["A", "A"],
		}),
	);
	assert.equal(result.market.rawCount, 5);
	assert.equal(result.market.validCount, 1);
	assert.equal(result.market.unknownCount, 1);
	assert.equal(result.market.excludedCount, 1);
	assert.equal(result.market.deduplicatedCount, 2);
	assert.equal(result.market.meanTwd, 220);
	assert.deepEqual(result.reference?.sampleIds, ["A"]);
	assert.deepEqual(
		result.market.excludedSamples.map((value) => ({ id: value.sampleId, reasons: value.excludeReasons })),
		[{ id: "B", reasons: ["材质不同"] }],
	);
	assert.equal(result.market.unknownSamples[0]?.sampleId, "U");
	for (const conflicting of [sample("A", 221), sample("A", 220, 2), sample("A", null)])
		assert.throws(() => marketPricePreview(input({ marketSamples: [sample("A", 220), conflicting], referenceSampleIds: ["A"] })), /样本.*冲突/);
});

test("主流组只能引用已知有效样本，未知或排除项不能绕过，JSON和来源边界严格解析", () => {
	for (const rows of [[sample("A", null)], [sample("A", 220, 1, "规格不同")], [sample("B", 220)]])
		assert.throws(() => marketPricePreview(input({ marketSamples: rows, referenceSampleIds: ["A"] })), /主流样本.*有效/);
	assert.equal(marketPricingInput.safeParse({ ...input(), referenceReason: undefined }).success, false);
	assert.equal(marketPricingInput.safeParse({ ...input(), comparisonKey: " " }).success, false);
	for (const changed of [{ paidTwd: 0 }, { units: 0 }, { observedAt: "昨天" }, { sourceUrl: "file:///secret" }])
		assert.equal(marketPricingInput.safeParse({ ...input(), marketSamples: [{ ...sample("A", 220), ...changed }] }).success, false);
	const parsed = marketPricingInput.parse({ ...input(), marketSamples: JSON.stringify([sample("A", 220)]), referenceSampleIds: '["A"]' });
	assert.equal(parsed.marketSamples[0]?.paidTwd, 220);
	assert.deepEqual(parsed.referenceSampleIds, ["A"]);
	assert.equal(marketPricingTools["market-price-preview"].kind, "read");
});

test("非默认毛利目标完全复用旧成本计算器，输入售价不会被市场候选替换", () => {
	const value = input({
		template: { ...template, minMargin: 0.1, maxMargin: 0.15 },
		priceTwd: 100,
		marketSamples: [sample("A", 1), sample("B", 1000)],
	});
	const result = marketPricePreview(value);
	assert.deepEqual(result.pricing, calculatePricing(calculatorInput.parse(value)));
	assert.equal(result.pricing.priceTwd, 100);
	assert.equal(result.pricing.priceSource, "input");
	assert.equal(result.pricing.withinTarget, false);
	assert.ok(result.candidates.length > 0);
	assert.ok(result.candidates.every((candidate) => candidate.margin! >= 0.1 - 1e-9 && candidate.margin! <= 0.15 + 1e-9));
});
