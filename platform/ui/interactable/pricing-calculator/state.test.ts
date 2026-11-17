// 定价输入的边界：未知与零分开，拒绝无效数字、件数及倒置的目标区间。
import assert from "node:assert/strict";
import { test } from "node:test";
import { calculationInput, emptyDraft, templateDraft } from "./state.ts";

const parameters = templateDraft({ fx: 4.8, feeRate: 0.16, freightPerKgRmb: 10, labelFeeRmb: 1.5, minMargin: 0.2, maxMargin: 0.3 });

test("空的进价、重量和运费保留未知，明确填零的包邮仍为零", () => {
	const blank = calculationInput(emptyDraft(), parameters);
	assert.deepEqual(blank.errors, []);
	assert.equal(blank.input?.costRmb, null);
	assert.equal(blank.input?.weightKg, null);
	assert.equal(blank.input?.freightRmb, null);
	assert.equal(blank.input?.priceTwd, null);
	assert.equal(blank.input?.sellerDiscountTwd, 0);
	assert.equal(calculationInput({ ...emptyDraft(), freightRmb: "0" }, parameters).input?.freightRmb, 0);
	assert.equal(calculationInput({ ...emptyDraft(), sellerDiscountTwd: "" }, parameters).input?.sellerDiscountTwd, null);
});

test("参数以百分数输入，传给业务计算时使用小数费率", () => {
	assert.deepEqual(calculationInput(emptyDraft(), parameters).input?.template, {
		fx: 4.8,
		feeRate: 0.16,
		freightPerKgRmb: 10,
		labelFeeRmb: 1.5,
		minMargin: 0.2,
		maxMargin: 0.3,
	});
});

test("非数字、负价、零重量和小数件数不发出计算请求", () => {
	for (const values of [{ costRmb: "abc" }, { costRmb: "-1" }, { costRmb: "Infinity" }, { weightKg: "0" }, { units: "1.5" }, { units: "" }, { priceTwd: "0" }])
		assert.equal(calculationInput({ ...emptyDraft(), ...values }, parameters).input, null);
});

test("模板参数缺失、费率达100%或目标倒置时显示校验错误", () => {
	for (const values of [{ fx: "" }, { feeRate: "100" }, { maxMargin: "100" }, { minMargin: "40", maxMargin: "30" }])
		assert.equal(calculationInput(emptyDraft(), { ...parameters, ...values }).input, null);
});
