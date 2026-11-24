// 采购按钮只取明确选中的订单，冻结数量、货源和账号；缺少人工选用的货源或不完整订单一律停下。
import assert from "node:assert/strict";
import { test } from "node:test";
import { OfferId, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import { ChanbossOrderId, OrderSn } from "../../connectors/sites/chanboss/api.ts";
import { checkOrders, type Snapshot } from "./check.ts";
import { purchaseState, samePurchase, selectPurchase } from "./purchase.ts";
import { cartParams } from "./writes.ts";

const sn = (v: string) => OrderSn.parse(v);
const order = (id: string, shop = "cheeroutdoor") => ({
	sn: sn(id),
	shop,
	source: "shopee" as const,
	shopeeOrderId: id,
	procurementEligible: true,
	createdAt: new Date(),
	shipBy: null,
	platformStatus: "待出货",
	chanbossStatus: "待处理",
	chanbossId: ChanbossOrderId.parse(id),
	chanbossTime: 1,
	problem: null,
	cancelledAt: null,
	items: [{ itemId: "i", modelId: "m", chanbossModelId: "cm", name: "商品", spec: "红", qty: 2, image: "" }],
});
const snapshot = (): Snapshot => ({
	now: new Date(),
	settings: { lateDays: 6, channel: "海快", buyAccount: "a" },
	accounts: new Map([["a", "采购账号"]]),
	orders: [order("1"), order("2")],
	writes: [],
	purchases: [],
	cart: [],
	issues: [],
	sources: [
		{
			itemId: "i",
			offerId: OfferId.parse("o"),
			title: "货源",
			chosen: true,
			sure: true,
			broken: null,
			skus: [{ skuId: SkuId.parse("s"), specId: SpecId.parse("sp"), name: "红", price: 3, stock: 100, image: "" }],
		},
	],
});

test("选一个订单时从合并加购行中扣掉其他订单的数量", () => {
	const s = snapshot();
	const rows = selectPurchase(s, checkOrders(s), [sn("1")], ["cheeroutdoor"]);
	assert.equal(rows.length, 1);
	assert.equal(rows[0]!.qty, 2);
	assert.deepEqual(
		rows[0]!.lines.map((l) => l.sn),
		["1"],
	);
	assert.equal(rows[0]!.account, "a");
});

test("不替人选择 sure 但未 chosen 的货源", () => {
	const s = snapshot();
	s.sources[0]!.chosen = false;
	assert.throws(() => selectPurchase(s, checkOrders(s), [sn("1")], ["cheeroutdoor"]), /人工选用/);
});

test("跨店、取消、缺少规格、加购已在途中或数量不完整时都拒绝整张订单", () => {
	const s = snapshot();
	assert.throws(() => selectPurchase(s, checkOrders(s), [sn("1")], ["ni1206"]), /店铺范围/);
	s.orders[0]!.platformStatus = "取消中";
	assert.throws(() => selectPurchase(s, checkOrders(s), [sn("1")], ["cheeroutdoor"]), /待出货/);
	s.orders[0]!.platformStatus = "待出货";
	s.sources[0]!.skus = [];
	assert.throws(() => selectPurchase(s, checkOrders(s), [sn("1")], ["cheeroutdoor"]), /不能完整加购/);
});

test("冻结后的数量、货源或账号变动不能用旧预览确认", () => {
	const s = snapshot();
	const rows = selectPurchase(s, checkOrders(s), [sn("1")], ["cheeroutdoor"]);
	assert.equal(samePurchase(rows, [...rows].reverse()), true);
	assert.equal(
		samePurchase(
			rows,
			rows.map((row) => cartParams.parse(row)),
		),
		true,
	);
	assert.equal(
		samePurchase(
			rows,
			rows.map((r) => ({ ...r, qty: 3 })),
		),
		false,
	);
	assert.equal(
		samePurchase(
			rows,
			rows.map((r) => ({ ...r, account: "other" })),
		),
		false,
	);
});

test("原确认在执行中断后，只有全部精确写入均已核清才解除等待", () => {
	assert.equal(purchaseState("executing", ["已核对", "成功"]), "completed");
	assert.equal(purchaseState("executing", ["已核对", undefined]), "executing");
	assert.equal(purchaseState("executing", ["已核对", "已提交"]), "executing");
	assert.equal(purchaseState("executing", ["结果未知"]), "executing");
	assert.equal(purchaseState("unknown", ["结果未知"]), "unknown");
	assert.equal(purchaseState("unknown", [undefined]), "completed");
});

test("跨单同规格预览数量等于逐单需求，仅用所选订单的货源并核对同一 1688 规格", () => {
	const s = snapshot();
	s.orders[1]!.items[0]!.qty = 3;
	const source = s.sources[0]!,
		sku = source.skus[0]!;
	const target = { offerId: source.offerId, skuId: sku.skuId, specId: sku.specId };
	const targets = new Map([
		["1:m", { target, qty: 2 }],
		["2:m", { target, qty: 3 }],
	]);
	const result = checkOrders(s);
	const [row] = selectPurchase(s, result, [sn("1"), sn("2")], ["cheeroutdoor"], targets);
	assert.equal(row?.qty, 5);
	assert.deepEqual(
		row?.lines.map((l) => l.qty),
		[2, 3],
	);
	const different = new Map([["2:m", { target: { ...target, skuId: SkuId.parse("another") }, qty: 3 }]]);
	assert.throws(() => selectPurchase(s, result, [sn("2")], ["cheeroutdoor"], different), /规格或数量不一致/);
	assert.throws(() => selectPurchase(s, result, [sn("2")], ["cheeroutdoor"], new Map([["2:m", { target, qty: 2 }]])), /数量不一致/);
	s.orders[0]!.items[0]!.itemId = "unselected";
	s.sources.push({ ...source, itemId: "unselected", chosen: false });
	assert.equal(selectPurchase(s, checkOrders(s), [sn("2")], ["cheeroutdoor"], targets)[0]?.qty, 3);
});
