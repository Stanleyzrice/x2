// 采购页精确匹配与统一数量分配测试：付款证据、手工采购、退款、历史占量及缺失事实均独立核对。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Coverage, type MatchNeed, type MatchRecord, matchProcurement } from "./procurement-matches.ts";

const coverage: Coverage = { account: "4067517207", capturedAt: "2026-11-06T04:00:00Z", complete: true, error: null };
const need = (sn = "1", overrides: Partial<MatchNeed> = {}): MatchNeed => ({
	sn,
	modelId: "model",
	qty: 1,
	createdAt: "2026-11-06T01:00:00Z",
	target: { offerId: "101", skuId: "201", specId: "spec" },
	...overrides,
});
const record = (overrides: Partial<MatchRecord> = {}): MatchRecord => ({
	account: "4067517207",
	orderId: "3012345678901234567",
	lineId: "line",
	offerId: "101",
	skuId: "201",
	quantity: "1",
	createdAt: "2026-11-06 10:00:00",
	paidAt: "2026-11-06T02:01:00Z",
	status: "waitsellersend",
	fulfillment: { specId: "spec", status: "waitsellersend", statusLabel: "待发货", refund: null },
	...overrides,
});
const one = (records = [record()], n = need(), c = coverage) => matchProcurement([n], records, c).get(`${n.sn}:${n.modelId}`)!;

test("外部手工采购无需加购写入；精确规格和付款时间齐全才计已采购，并保留原单与推断依据", () => {
	const matched = one();
	assert.equal(matched.state, "paid");
	assert.equal(matched.paidQty, 1);
	assert.equal(matched.canPurchase, false);
	assert.equal(matched.matches[0]?.orderId, "3012345678901234567");
	assert.match(matched.matches[0]!.url, /orderId=3012345678901234567$/);
	assert.match(matched.reason!, /推断匹配/);
});

test("有记录但待付款不能算已采购；已发货但无付款时间仍未知", () => {
	const unpaid = record({ paidAt: null, status: "waitbuyerpay", fulfillment: { specId: "spec", status: "waitbuyerpay", statusLabel: "待付款", refund: null } });
	assert.equal(one([unpaid]).state, "unpaid");
	assert.equal(one([unpaid]).paidQty, 0);
	assert.equal(one([unpaid]).unpaidQty, 1);
	assert.equal(one([unpaid]).canPurchase, false);
	assert.equal(one([record({ paidAt: null })]).state, "unknown");
	assert.equal(one([{ ...unpaid, paidAt: record().paidAt }]).state, "unknown");
});

test("不同账号、商品、SKU或明确specId不相同均不据名称匹配", () => {
	for (const different of [
		record({ account: "other" }),
		record({ offerId: "102" }),
		record({ skuId: "202" }),
		record({ fulfillment: { ...record().fulfillment!, specId: "other" } }),
	]) {
		assert.equal(one([different]).state, "unmatched");
		assert.equal(one([different]).canPurchase, true);
	}
});

test("全局FIFO数量池同时保留历史已出货需求；同一采购不能反复分给新订单", () => {
	const old = need("old", { qty: 2, createdAt: "2026-11-05T12:00:00Z" });
	const current = need("new");
	const matched = matchProcurement([current, old], [record({ quantity: "2" })], coverage);
	assert.equal(matched.get("old:model")?.paidQty, 2);
	assert.equal(matched.get("new:model")?.state, "unmatched");
});

test("有效已付优先于未付；数量不足及混合付款显示部分而非整单完成", () => {
	const unpaid = record({
		orderId: "3012345678901234568",
		lineId: "unpaid",
		paidAt: null,
		status: "waitbuyerpay",
		fulfillment: { specId: "spec", status: "waitbuyerpay", statusLabel: null, refund: null },
	});
	const mixed = one([unpaid, record()], need("1", { qty: 3 }));
	assert.equal(mixed.state, "partial");
	assert.equal(mixed.paidQty, 1);
	assert.equal(mixed.unpaidQty, 1);
	assert.equal(mixed.requiredQty, 3);
	assert.equal(mixed.canPurchase, false);
	assert.equal(one([record()], need("1", { qty: 2 })).state, "partial");
});

test("先前取消或退款不会抢掉后来的有效采购，历史付款不使取消/退款变已采购", () => {
	const closed = record({ lineId: "closed", status: "cancel", fulfillment: { specId: "spec", status: "cancel", statusLabel: "已关闭", refund: null } });
	const refunded = record({ lineId: "refunded", fulfillment: { ...record().fulfillment!, refund: { id: "r", stage: "售中", status: "refundsuccess" } } });
	assert.equal(one([closed]).state, "closed");
	assert.equal(one([closed]).paidQty, 0);
	assert.equal(one([refunded]).state, "refund");
	assert.equal(one([refunded]).canPurchase, false);
	assert.equal(one([closed, refunded, record({ lineId: "valid" })]).state, "paid");
});

test("退款进行中不能重购，退款关闭未退成则仍按有效付款证据核对", () => {
	const refund = (status: string | null) => record({ fulfillment: { ...record().fulfillment!, refund: { id: "r", stage: "售后", status } } });
	assert.equal(one([refund("waitselleragree")]).state, "refund");
	assert.equal(one([refund("waitselleragree")]).canPurchase, false);
	assert.equal(one([refund("refundclose")]).state, "paid");
	assert.equal(one([refund(null)]).state, "unknown");
});

test("沿用一小时时差容差，旧采购及快照之后的日期不能冒充本次采购", () => {
	assert.equal(one([record({ createdAt: "2026-11-06T00:00:00Z" })]).state, "paid");
	assert.equal(one([record({ createdAt: "2026-11-05T23:59:59Z" })]).state, "unmatched");
	assert.equal(one([record({ createdAt: "2026-11-06T05:00:00Z" })]).state, "unknown");
	assert.equal(one([record({ paidAt: "2026-11-06T05:00:00Z" })]).state, "unknown");
	assert.equal(one([record({ paidAt: "2026-11-05T05:00:00Z" })]).state, "unknown");
});

test("缺字段、旧缓存、日期未知或数量异常只给未知，不把缺失当未采购", () => {
	for (const incomplete of [
		record({ fulfillment: undefined }),
		record({ createdAt: null }),
		record({ quantity: null }),
		record({ quantity: "9007199254740993" }),
		record({ skuId: null }),
		record({ offerId: null }),
		record({ fulfillment: { ...record().fulfillment!, status: null } }),
		record({ fulfillment: { ...record().fulfillment!, status: "unrecognized" } }),
	]) {
		assert.equal(one([incomplete]).state, "unknown");
		assert.equal(one([incomplete]).canPurchase, false);
	}
	assert.equal(one([], need("1", { target: null })).state, "unknown");
	assert.equal(one([], need("1", { createdAt: null })).state, "unknown");
});

test("读取未完整、未确认账号、采集时间未知或刷新失败均不能宣称未采购", () => {
	for (const c of [
		{ ...coverage, complete: false },
		{ ...coverage, account: null },
		{ ...coverage, capturedAt: null },
		{ ...coverage, error: "读取失败" },
	]) {
		assert.equal(one([], need(), c).state, "unknown");
		assert.equal(one([], need(), c).canPurchase, false);
	}
	assert.equal(one([record()], need(), { ...coverage, complete: false }).state, "unknown");
	assert.equal(one([], need("1", { createdAt: "2026-11-06T05:00:00Z" })).state, "unknown");
});

test("同一采购行重复出现不重复计数，冲突或缺行号的重复记录标未知", () => {
	assert.equal(one([record(), record()], need("1", { qty: 2 })).paidQty, 1);
	assert.equal(one([record(), record({ quantity: "2" })]).state, "unknown");
	assert.equal(one([record({ lineId: null }), record({ lineId: null })]).state, "unknown");
});

test("重复需求不重复占量，冲突需求及同规格未知历史需求阻止肯定分配", () => {
	const current = need("new");
	const matched = matchProcurement([need(), need(), current], [record({ quantity: "2" })], coverage);
	assert.equal(matched.get("1:model")?.state, "paid");
	assert.equal(matched.get("new:model")?.state, "paid");
	assert.equal(matchProcurement([need(), need("1", { qty: 2 })], [record()], coverage).get("1:model")?.state, "unknown");
	assert.equal(matchProcurement([need("old", { createdAt: null }), current], [record()], coverage).get("new:model")?.state, "unknown");
});

test("未映射历史需求不能让旧采购变成新订单已采购，已知候选货源与时间共同限定疑义", () => {
	const current = need("new");
	const historical = need("old", { target: null, offerIds: ["101"], createdAt: "2026-11-05T00:00:00Z", reason: "历史规格没有对应 source" });
	const get = (old: MatchNeed, records = [record()]) => matchProcurement([old, current], records, coverage).get("new:model")!;
	assert.equal(get(historical).state, "unknown");
	assert.equal(get(historical).canPurchase, false);
	assert.match(get(historical).reason!, /已被占用/);
	assert.equal(get({ ...historical, offerIds: undefined }).state, "unknown");
	assert.equal(get({ ...historical, offerIds: [] }).state, "unknown");
	assert.equal(get({ ...historical, createdAt: null }).state, "unknown");
	assert.equal(get({ ...historical, offerIds: ["different-offer"] }).state, "paid");
	assert.equal(get({ ...historical, createdAt: "2026-11-06T03:30:00Z" }).state, "paid");
});

test("未映射历史只阻塞实际相关已付或待付候选，无采购证据的未匹配需求仍可正常核对采购", () => {
	const historical = need("old", { target: null, createdAt: null, reason: "历史来源不明" });
	const current = need("new");
	const without = matchProcurement([historical, current], [], coverage).get("new:model")!;
	assert.equal(without.state, "unmatched");
	assert.equal(without.canPurchase, true);
	const unpaid = record({ paidAt: null, status: "waitbuyerpay", fulfillment: { ...record().fulfillment!, status: "waitbuyerpay" } });
	assert.equal(matchProcurement([historical, current], [unpaid], coverage).get("new:model")?.state, "unknown");
});

test("取消中的同规格不制造补货需求；只有可能共用一笔实际采购时才需人工核对", () => {
	const held = need("held", { heldStatus: "取消中" });
	const current = need("active");
	const check = (old: MatchNeed, records: MatchRecord[]) => matchProcurement([old, current], records, coverage).get("active:model")!;
	assert.equal(check(held, []).state, "unmatched");
	assert.equal(check(held, [record()]).state, "unknown");
	assert.equal(check({ ...held, target: { ...held.target!, skuId: "another" } }, [record()]).state, "paid");
	assert.equal(check({ ...held, createdAt: "2026-11-06T03:30:00Z" }, [record()]).state, "paid");
});

test("跨日采集不把可能由未读订单占用的同一采购行分配给任何一张订单", () => {
	const since = Date.parse("2026-11-05T00:00:00Z");
	const matches = matchProcurement([need("1"), need("2")], [record()], coverage, since);
	for (const match of matches.values()) assert.deepEqual([match.state, match.paidQty, match.canPurchase], ["unknown", 0, false]);
	assert.equal(matchProcurement([need()], [record()], coverage, Date.parse("2026-11-07T00:00:00Z")).get("1:model")?.state, "paid");
	assert.equal(matchProcurement([need()], [record({ skuId: "other" })], coverage, since).get("1:model")?.state, "unmatched");
});
