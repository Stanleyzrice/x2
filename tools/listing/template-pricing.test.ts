// 用用户模板的缓存答案及毛利率边界验算；缺失成本不能补零，尾 9 不能把建议推出目标区间。
import assert from "node:assert/strict";
import { test } from "node:test";
import { listing } from "./index.ts";
import { roundUpNine, templateItem, templateParams, templatePrice } from "./template-pricing.ts";

const sample = { fx: 4.8, feeRate: 0.16, freightPerKgRmb: 10, labelFeeRmb: 1.5, minMargin: 0.15, maxMargin: 0.2 };
const parameters = (changes = {}) => templateParams.parse({ ...sample, ...changes });

test("启用模板必须明确成本参数，不能把 Excel 示例值默认当作整店实际费用", () => {
	const params = listing.tools["pricing-set"]!.params;
	assert.equal(params.safeParse({ shop: "ni1206", template: {} }).success, false);
	assert.equal(params.safeParse({ shop: "ni1206", template: { minMargin: 0.15, maxMargin: 0.2 } }).success, false);
	assert.equal(params.safeParse({ shop: "ni1206", template: sample }).success, true);
});

test("定价模板：原表单件 259、两件组 499；组只共用一次贴单费", () => {
	const params = parameters({ minMargin: 0.3, maxMargin: 0.3 });
	const one = templatePrice(templateItem.parse({ key: "one", costRmb: 28, weightKg: 0.15, freightRmb: 0, currentTwd: 259 }), params);
	const two = templatePrice(templateItem.parse({ key: "two", costRmb: 28, weightKg: 0.15, freightRmb: 0, units: 2 }), params);
	assert.equal(one.totalCostRmb, 31);
	assert.equal(two.totalCostRmb, 60.5);
	assert.equal(roundUpNine(one.theoretical!.min), 259);
	assert.equal(roundUpNine(two.theoretical!.min), 499);
	assert.ok(Math.abs(one.current!.margin - 0.316050744622173) < 1e-12);
});

test("15–20%：整数建议 209–221，尾 9 只给 209–219，229 会超过 20%", () => {
	const p = parameters({});
	const r = templatePrice(templateItem.parse({ key: "range", costRmb: 28, weightKg: 0.15, freightRmb: 0 }), p);
	assert.deepEqual(r.range, { min: 209, max: 221 });
	assert.deepEqual(r.tailNine, { min: 209, max: 219 });
	const margin = (price: number) => 1 - 31 / ((price * 0.84) / 4.8);
	assert.ok(margin(209) >= 0.15 && margin(221) <= 0.2);
	assert.ok(margin(208) < 0.15 && margin(222) > 0.2);
});

test("缺成本不算价格与实际毛利；现价只倒算含运费的成本预算，明确 0 运费照算", () => {
	const p = parameters({});
	const unknown = templatePrice(templateItem.parse({ key: "missing", currentTwd: 100 }), p);
	assert.equal(unknown.status, "待补数据");
	assert.equal(unknown.range, null);
	assert.equal(unknown.current, null);
	assert.deepEqual(unknown.missing, ["进货成本", "计费重量", "国内运费"]);
	assert.deepEqual(unknown.budgetRmb, { min: 14, max: 14.875 });
	const known = templatePrice(templateItem.parse({ key: "known", costRmb: 5, weightKg: 0.1, freightRmb: 0 }), p);
	assert.equal(known.status, "条件试算");
});

test("拒绝无效费率和毛利目标；窄区间没有整数或尾 9 时保持空，不擅自扩到区间外", () => {
	assert.equal(templateParams.safeParse({ ...sample, feeRate: 1 }).success, false);
	assert.equal(templateParams.safeParse({ ...sample, minMargin: 0.2, maxMargin: 0.15 }).success, false);
	const r = templatePrice(templateItem.parse({ key: "narrow", costRmb: 5.13, weightKg: 0.1, freightRmb: 0 }), parameters({}));
	assert.deepEqual(r.range, { min: 52, max: 54 });
	assert.equal(r.tailNine, null);
});
