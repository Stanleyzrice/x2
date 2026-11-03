// 整单计算：验证成本汇总、金额比较和未知值的传播。
import assert from "node:assert/strict";
import { test } from "node:test";
import { listing } from "./index.ts";
import { orderPrice, orderPricingInput } from "./order-pricing.ts";
import { templateParams } from "./template-pricing.ts";

const p = templateParams.parse({ fx: 4.8, feeRate: 0.16, freightPerKgRmb: 10, labelFeeRmb: 1.5, minMargin: 0.15, maxMargin: 0.2 });

test("组合报价工具保留未知优惠，不把未提供的优惠当零", () => {
	const tool = listing.tools["order-preview"];
	assert.ok(tool);
	const parsed = tool.params.parse({ shop: "ni1206", items: [{ key: "A", priceTwd: 199, units: 1, costRmb: 10, weightKg: 0.1 }] });
	assert.equal(parsed.sellerDiscountTwd, null);
	assert.equal(parsed.freightRmb, null);
});
const input = (changes: Partial<ReturnType<typeof orderPricingInput.parse>> = {}) =>
	orderPricingInput.parse({
		items: [
			{ key: "A", priceTwd: 59, units: 2, costRmb: 6, weightKg: 0.15 },
			{ key: "B", priceTwd: 99, units: 1, costRmb: 10.2, weightKg: 0.2 },
		],
		freightRmb: 3.3,
		sellerDiscountTwd: 0,
		minimumTwd: 199,
		...changes,
	});

test("整单成本汇总与输入区间比较", () => {
	const r = orderPrice(input(), p);
	assert.equal(r.paidTwd, 217);
	assert.equal(r.totalCostRmb, 32);
	assert.ok(Math.abs(r.profitRmb! - 5.975) < 1e-9);
	assert.equal(r.nonLoss, true);
	assert.equal(r.withinTarget, true);
});

test("金额下限比较与利润正负独立，卖家优惠从商品金额扣除", () => {
	const loss = orderPrice(input({ items: [{ key: "A", priceTwd: 199, units: 1, costRmb: 35, weightKg: 0.1 }] }), p);
	assert.equal(loss.minimumMet, true);
	assert.equal(loss.nonLoss, false);
	const discounted = orderPrice(input({ sellerDiscountTwd: 40 }), p);
	assert.equal(discounted.paidTwd, 177);
	assert.equal(discounted.nonLoss, false);
	const under = orderPrice(input({ items: [{ key: "A", priceTwd: 59, units: 3, costRmb: 6, weightKg: 0.15 }] }), p);
	assert.equal(under.nonLoss, true);
	assert.equal(under.minimumMet, false);
});

test("缺少成本、重量、国内运费或优惠数据时保留未知", () => {
	for (const changed of [
		{ freightRmb: null },
		{ sellerDiscountTwd: null },
		{ items: [{ key: "A", priceTwd: 199, units: 1, costRmb: null, weightKg: 0.1 }] },
		{ items: [{ key: "A", priceTwd: 199, units: 1, costRmb: 10, weightKg: null }] },
	]) {
		const r = orderPrice(input(changed), p);
		assert.equal(r.status, "DATA_INSUFFICIENT");
		assert.equal(r.withinTarget, null);
	}
});
