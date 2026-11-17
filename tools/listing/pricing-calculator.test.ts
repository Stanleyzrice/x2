// 定价工作区复用既有核价函数，覆盖优惠、数量、缺失输入和当前规则读取。
import assert from "node:assert/strict";
import { test } from "node:test";
import { calculatePricing, calculatorInput, pricingTemplateFromPolicy } from "./pricing-calculator.ts";

const template = { fx: 4.8, feeRate: 0.16, freightPerKgRmb: 10, labelFeeRmb: 1.5, minMargin: 0.2, maxMargin: 0.3 };
const input = (changes = {}) =>
	calculatorInput.parse({ template, costRmb: 28, weightKg: 0.15, freightRmb: 0, units: 1, priceTwd: null, sellerDiscountTwd: 0, ...changes });

test("完整成本自动建议区间内售价；覆盖售价后重新算实际利润", () => {
	const result = calculatePricing(input());
	assert.deepEqual(result.rangeTwd, { min: 222, max: 253 });
	assert.equal(result.suggestedPriceTwd, 229);
	assert.equal(result.priceSource, "suggested");
	assert.equal(result.priceTwd, 229);
	assert.equal(result.totalCostRmb, 31);
	assert.ok(Math.abs(result.netRmb! - 40.075) < 1e-9);
	assert.ok(Math.abs(result.profitRmb! - 9.075) < 1e-9);
	assert.equal(result.withinTarget, true);
	const loss = calculatePricing(input({ priceTwd: 100 }));
	assert.equal(loss.priceSource, "input");
	assert.equal(loss.priceTwd, 100);
	assert.equal(loss.profitRmb, -13.5);
	assert.equal(loss.withinTarget, false);
});

test("优惠先加回建议标价再按件数分摊；国内运费和贴单只收一次", () => {
	const result = calculatePricing(input({ costRmb: 6.26, weightKg: 0.4, freightRmb: 6, units: 2, sellerDiscountTwd: 20 }));
	assert.deepEqual(result.rangeTwd, { min: 111, max: 124 });
	assert.equal(result.suggestedPriceTwd, 119);
	assert.equal(result.breakdown.goodsRmb, 12.52);
	assert.equal(result.breakdown.firstLegRmb, 8);
	assert.equal(result.breakdown.domesticFreightRmb, 6);
	assert.equal(result.breakdown.labelFeeRmb, 1.5);
	assert.equal(result.totalCostRmb, 28.02);
	assert.equal(result.breakdown.grossTwd, 238);
	assert.equal(result.breakdown.paidTwd, 218);
	assert.equal(result.withinTarget, true);
	for (const priceTwd of [result.rangeTwd!.min, result.rangeTwd!.max])
		assert.equal(calculatePricing(input({ costRmb: 6.26, weightKg: 0.4, freightRmb: 6, units: 2, sellerDiscountTwd: 20, priceTwd })).withinTarget, true);
});

test("缺重量、运费和优惠不当成零；已知费用仍独立展示", () => {
	const blank = input({ costRmb: "", weightKg: " ", freightRmb: "", sellerDiscountTwd: "", priceTwd: "" });
	assert.equal(blank.costRmb, null);
	assert.equal(blank.weightKg, null);
	assert.equal(blank.freightRmb, null);
	assert.equal(blank.sellerDiscountTwd, null);
	assert.equal(blank.priceTwd, null);
	const result = calculatePricing(input({ weightKg: null, freightRmb: null, sellerDiscountTwd: null, priceTwd: 199 }));
	assert.equal(result.status, "DATA_INSUFFICIENT");
	assert.deepEqual(result.missing, ["计费重量", "国内运费", "卖家承担的优惠"]);
	assert.equal(result.profitRmb, null);
	assert.equal(result.totalCostRmb, null);
	assert.equal(result.rangeTwd, null);
	assert.equal(result.suggestedPriceTwd, null);
	assert.equal(result.breakdown.goodsRmb, 28);
	assert.equal(result.breakdown.firstLegRmb, null);
	assert.equal(result.breakdown.domesticFreightRmb, null);
	assert.equal(result.breakdown.paidTwd, null);
});

test("卖家优惠不能超过售价总额；全额优惠亏掉全部成本，毛利率未知", () => {
	const invalid = calculatePricing(input({ priceTwd: 100, sellerDiscountTwd: 101 }));
	assert.equal(invalid.status, "INVALID_INPUT");
	assert.equal(invalid.profitRmb, null);
	assert.equal(invalid.margin, null);
	assert.deepEqual(invalid.problems, ["卖家优惠超过商品总额"]);
	const free = calculatePricing(input({ priceTwd: 100, sellerDiscountTwd: 100 }));
	assert.equal(free.status, "CALCULATED");
	assert.equal(free.netRmb, 0);
	assert.equal(free.profitRmb, -31);
	assert.equal(free.margin, null);
});

test("目标无整数售价就保持空；不能沿用上次建议或强行尾9", () => {
	const result = calculatePricing(input({ template: { ...template, minMargin: 0.25, maxMargin: 0.25 } }));
	assert.equal(result.status, "NO_PRICE");
	assert.equal(result.rangeTwd, null);
	assert.equal(result.priceTwd, null);
	assert.equal(result.profitRmb, null);
});

test("模板参数从规则的参数段解析，坏规则或非法区间显式失败", () => {
	const markdown = `# 定价\n\n## 参数与口径\n\n\u0060\u0060\u0060json\n${JSON.stringify(template)}\n\u0060\u0060\u0060\n\n## 其他\n`;
	assert.deepEqual(pricingTemplateFromPolicy(markdown), template);
	assert.throws(() => pricingTemplateFromPolicy(markdown.replace('"fx":4.8', '"fx":0')), /定价模板参数/);
	assert.throws(() => pricingTemplateFromPolicy("# 没有参数"), /定价模板参数/);
	assert.equal(calculatorInput.safeParse({ ...input(), units: 0 }).success, false);
	assert.equal(calculatorInput.safeParse({ ...input(), template: { ...template, maxMargin: 0.1 } }).success, false);
});
