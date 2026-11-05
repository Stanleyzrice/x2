// Shopee 采购只认完整的待出货列表与现读身份，列表缺页、取消、跨店和数量变化都不能加购。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Order } from "../../connectors/sites/shopee/orders.ts";
import { shopeeItems, shopeeOrderRow, shopeeState, validateCards, validateCartOrder, validateIndexPage } from "./shopee.ts";

const order = (changes: Partial<Order> = {}): Order => ({
	orderId: "1",
	orderSn: "SN1",
	shopId: "S1",
	status: "待出貨",
	shipBy: null,
	total: 99,
	items: [{ itemId: "I1", modelId: "M1", name: "商品", spec: "红", qty: 2, image: "https://image.test/1" }],
	packages: [],
	...changes,
});
const refs = [{ order_id: "1", shop_id: "S1" }];

test("Shopee 待出货行保留主来源、原始状态、商品图和真实下单时间，不伪装 Chanboss 状态", () => {
	const createdAt = new Date("2026-11-04T01:00:00Z");
	const row = shopeeOrderRow({ ...order(), createdAt }, "cheeroutdoor");
	assert.equal(row.order_source, "shopee");
	assert.equal(row.shopee_status, "待出貨");
	assert.equal(row.shopee_order_id, "1");
	assert.equal(row.created_at, createdAt);
	assert.equal(row.procurement_eligible, true);
	assert.equal(row.items[0]!.image, "https://image.test/1");
	assert.equal("chanboss_status" in row, false);
	for (const status of ["Unpaid", "已取消", "Completed", "已出貨"]) assert.equal(shopeeState(status).eligible, false);
	assert.throws(() => shopeeState("未知状态"), /尚未识别/);
});

test("列表缺页、总数变化、重复 id、跨店或详情不全不能当作完整读取", () => {
	const seen = new Set<string>();
	validateIndexPage(2, refs, "S1", seen, null);
	assert.throws(() => validateIndexPage(2, [], "S1", seen, 2), /数量不完整/);
	assert.throws(() => validateIndexPage(3, [], "S1", seen, 2), /总数变化/);
	assert.throws(() => validateIndexPage(2, refs, "S1", seen, 2), /重复/);
	assert.throws(() => validateIndexPage(1, refs, "OTHER", new Set(), null), /另一家/);
	assert.throws(() => validateCards([], refs, "S1"), /详情缺失/);
	assert.throws(() => validateCards([order({ shopId: "OTHER" })], refs, "S1"), /身份不符/);
});

test("加购前现读 Shopee 校验订单、店铺、规格和数量，取消或变更立即停止", () => {
	const stored = { sn: "SN1", shopee_order_id: "1", shop_id: "S1" },
		lines = [{ modelId: "M1", qty: 2 }];
	validateCartOrder(order(), stored, lines);
	assert.throws(() => validateCartOrder(order({ status: "已取消" }), stored, lines), /不是待出货/);
	assert.throws(() => validateCartOrder(order({ shopId: "OTHER" }), stored, lines), /身份变化/);
	assert.throws(() => validateCartOrder(order({ orderSn: "OTHER" }), stored, lines), /身份变化/);
	assert.throws(() => validateCartOrder(order(), stored, [{ modelId: "M1", qty: 3 }]), /数量已变化/);
	assert.throws(() => validateCartOrder(order(), stored, [{ modelId: "M2", qty: 2 }]), /规格或数量已变化/);
	assert.throws(() => validateCartOrder(undefined, stored, lines), /身份变化/);
});

test("分包裹的同一规格先合并数量；单规格的 model 0 使用商品 id 防止两个商品混淆", () => {
	const o = order();
	o.items.push({ ...o.items[0]!, qty: 1 });
	assert.equal(shopeeItems(o)[0]!.qty, 3);
	o.items = [
		{ ...o.items[0]!, modelId: "0" },
		{ ...o.items[0]!, itemId: "I2", modelId: "0" },
	];
	assert.deepEqual(
		shopeeItems(o).map((i) => i.modelId),
		["I1", "I2"],
	);
});

test("混有已出货或取消包裹的订单不按整单数量采购", () => {
	const mixed = order({ packageStatuses: ["待出貨", "已出貨"] });
	assert.throws(() => validateCards([mixed], refs, "S1"), /非待出货包裹/);
	assert.equal(shopeeOrderRow({ ...mixed, createdAt: new Date() }, "cheeroutdoor").procurement_eligible, false);
	assert.throws(() => validateCartOrder(mixed, { sn: "SN1", shopee_order_id: "1", shop_id: "S1" }, [{ modelId: "M1", qty: 2 }]), /不是待出货/);
});
