// 采购报账图片只透传采购行来源，旧缓存缺字段为 null；刷新补图不能重算原付款事实。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { purchaseFactsOf } from "../../connectors/sites/1688/purchases.ts";
import { present, preservePayment } from "./facts.ts";

test("报账逐行图片与长offerId原样透传，缺图null，金额保持精确", () => {
	const raw: unknown = JSON.parse(readFileSync(new URL("../../connectors/sites/1688/fixtures/buyer-order-images.json", import.meta.url), "utf8"));
	const row = purchaseFactsOf(raw).rows[0]!;
	const shown = present(row);
	assert.equal(shown.items[0]?.image, "http://cbu01.alicdn.com/img/ibank/fixture-one.jpg");
	assert.equal(shown.items[1]?.offerId, "9007199254740993124");
	assert.equal(shown.items[2]?.image, null);
	assert.equal(shown.items[0]?.unitPriceDisplay, "¥1.00");
	const old = structuredClone(row);
	Reflect.deleteProperty(old.items[0]!, "image");
	assert.equal(present(old).items[0]?.image, null);
	assert.equal(old.items[0]?.image, undefined, "旧缓存只在返回时补空字段，不改变原事实");
});
test("同一订单刷新图片保留原receipt，不改原付款或原金额", () => {
	const raw: unknown = JSON.parse(readFileSync(new URL("../../connectors/sites/1688/fixtures/buyer-order-images.json", import.meta.url), "utf8"));
	const row = purchaseFactsOf(raw).rows[0]!;
	const previous = preservePayment(undefined, row, "first");
	const next = {
		...row,
		paidMinor: "0",
		paidAt: null,
		paymentEvidence: null,
		items: row.items.map((i) => ({ ...i, image: "https://cbu01.alicdn.com/new-image.jpg" })),
	};
	const updated = preservePayment(previous, next, "images");
	assert.deepEqual(updated.receipt, previous.receipt);
	assert.equal(updated.items[0]?.image, "https://cbu01.alicdn.com/new-image.jpg");
});
