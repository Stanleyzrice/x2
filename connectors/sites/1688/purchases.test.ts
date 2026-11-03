// 精确采购事实用合成 fixture 验证；旧履约解析保持不变，不以样本测试代替真实账号可用性。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { minorOf, purchaseFactsOf, purchaseImageUrl } from "./purchases.ts";

const sample = () => JSON.parse(readFileSync(new URL("./fixtures/buyer-order-facts.json", import.meta.url), "utf8")) as { data: { result: string } };

test("采购金额保存精确整数分和长订单号；退款字段不冲减原实付", () => {
	const { rows, total, pages } = purchaseFactsOf(sample());
	assert.deepEqual([total, pages], [2, 1]);
	assert.equal(rows[0]!.orderId, "3012345678901234567");
	assert.equal(rows[0]!.paidMinor, "3230");
	assert.equal(rows[0]!.goodsMinor, "12345678901234567890");
	assert.equal(rows[0]!.supplier, "测试供应商");
	assert.equal(rows[0]!.paymentEvidence, "gmtPayment");
	assert.equal(rows[0]!.items[0]!.unitPriceMinor, "810");
});

test("完成状态不替代付款时间证据，缺失金额、数量和供应商保持null", () => {
	const row = purchaseFactsOf(sample()).rows[1]!;
	assert.equal(row.status, "success");
	assert.equal(row.paymentEvidence, null);
	assert.equal(row.paidAt, null);
	assert.equal(row.paidMinor, null);
	assert.equal(row.supplier, null);
	assert.equal(row.items[0]!.quantity, null);
	assert.equal(row.items[0]!.unitPriceMinor, null);
	assert.equal(row.items[0]!.image, null);
});

test("真实零分与未知分开；不安全的number或非整数分拒绝解析", () => {
	assert.equal(minorOf(0), "0");
	assert.equal(minorOf(null), null);
	assert.equal(minorOf("0001"), "1");
	assert.throws(() => minorOf(Number.MAX_SAFE_INTEGER + 1), /不能|准确/);
	assert.throws(() => minorOf("1.1"), /整数分/);
});

test("分页元数据缺失或null时不把空回包当完整历史", () => {
	assert.throws(() => purchaseFactsOf({ data: { result: '{"data":{"total":null,"pages":null,"data":[]}}' } }), /回包变了/);
	assert.throws(() => purchaseFactsOf({ data: {} }), /回包变了/);
});

test("采购行只取各自 mainSummImageUrl，不挪用其他行、订单封面或未经确认的快照图片", () => {
	const raw: unknown = JSON.parse(readFileSync(new URL("./fixtures/buyer-order-images.json", import.meta.url), "utf8"));
	const row = purchaseFactsOf(raw).rows[0]!;
	assert.equal(row.orderId, "3012345678901234567");
	assert.deepEqual(
		row.items.map((i) => i.image),
		["http://cbu01.alicdn.com/img/ibank/fixture-one.jpg", "https://cbu01.alicdn.com/img/ibank/fixture-two.jpg", null],
	);
	assert.equal(row.items[0]!.skuId, "9007199254740993123");
	assert.equal(row.items[1]!.offerId, "9007199254740993124");
});

test("采购图片只接受明确 HTTP(S) URL；空值、图片ID和其他协议保留null", () => {
	assert.equal(purchaseImageUrl(" //cbu01.alicdn.com/a.jpg "), "https://cbu01.alicdn.com/a.jpg");
	assert.equal(purchaseImageUrl("https://cbu01.alicdn.com/a.jpg?width=200"), "https://cbu01.alicdn.com/a.jpg?width=200");
	for (const value of [undefined, null, "", " ", "O1CN01-image-id", "javascript:alert(1)", "https://"]) assert.equal(purchaseImageUrl(value), null);
});

test("逐商品 sourceId 和 skuId 不接受不安全数字，图片不能掩盖ID关联丢精度", () => {
	for (const field of ["sourceId", "skuId"]) {
		const raw = sample();
		const body = JSON.parse(raw.data.result) as { data: { data: { orderEntries: Record<string, unknown>[] }[] } };
		body.data.data[0]!.orderEntries[0]![field] = Number.MAX_SAFE_INTEGER + 1;
		raw.data.result = JSON.stringify(body);
		assert.throws(() => purchaseFactsOf(raw), /ID.*不安全/);
	}
});
