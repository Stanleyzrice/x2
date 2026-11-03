// 计算参数由调用方明确给出；计算结果不代替上架、发货等经营决定。
import assert from "node:assert/strict";
import { test } from "node:test";
import { listing } from "./index.ts";
import { orderPrice, orderPricingInput } from "./order-pricing.ts";
import { templateParams } from "./template-pricing.ts";

test("计算器不内置店铺费率和目标毛利率", () => {
	assert.equal(templateParams.safeParse({}).success, false);
	assert.equal(templateParams.safeParse({ fx: 4.8, feeRate: 0.16, freightPerKgRmb: 10, labelFeeRmb: 1.5 }).success, false);
});

test("报价不自行选择店铺或估算输入", () => {
	const params = listing.tools.quote!.params;
	assert.equal(params.safeParse({ link: "1", weight: 1, freight: 0 }).success, false);
	assert.equal(params.safeParse({ link: "1", shop: "ni1206" }).success, false);
});

test("整单计算只返回数值和比较结果，不返回发货许可", () => {
	const p = templateParams.parse({ fx: 4.8, feeRate: 0.16, freightPerKgRmb: 10, labelFeeRmb: 1.5, minMargin: 0.15, maxMargin: 0.2 });
	const r = orderPrice(
		orderPricingInput.parse({ items: [{ key: "A", priceTwd: 199, units: 1, costRmb: 10, weightKg: 0.1 }], freightRmb: 0, sellerDiscountTwd: 0 }),
		p,
	);
	assert.equal("canFulfil" in r, false);
	assert.equal(typeof r.profitRmb, "number");
});
