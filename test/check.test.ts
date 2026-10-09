import assert from "node:assert/strict";
import { test } from "node:test";
import { type CartParams, checkOrders, type ForecastParams, type Order, type Snapshot } from "../src/check/orders.ts";
import { reconcile } from "../src/check/reconcile.ts";

// docs/orders.md 的例子：订单 1 买红T ×1，订单 2 买红T ×2；红T 的货源是 1688 的 O1 / S1
const T0 = new Date("2026-10-09T02:00:00Z");
const hours = (h: number) => new Date(T0.getTime() + h * 3600_000);
const item = (modelId: string, qty: number) => ({ itemId: "I1", modelId, chanbossModelId: `c${modelId}`, name: "红T", spec: modelId === "M1" ? "红色 L" : "白色 L", qty, image: "" });
const order = (sn: string, qty: number, o: Partial<Order> = {}): Order => ({
	sn, shop: "ni1206", createdAt: hours(-24), shipBy: hours(24 * 10), platformStatus: "待出货", chanbossStatus: "待处理", chanbossId: `cb${sn}`, chanbossTime: 1, items: [item("M1", qty)], problem: null, cancelledAt: null, ...o,
});
const cartWrite = (status = "已核对") => ({
	id: "1", batch: "1", op: "加购", status, finishedAt: T0,
	params: { account: "A", offerId: "O1", skuId: "S1", qty: 3, lines: [{ sn: "1", modelId: "M1", qty: 1 }, { sn: "2", modelId: "M1", qty: 2 }] },
});
const purchase = (qty: number, o: { signed?: boolean; toChanboss?: boolean; trackingNo?: string } = {}) => ({
	account: "A", orderId: "P1", offerId: "O1", offerSkuId: "S1", qty, createdAt: hours(1), status: "waitsellersend", toChanboss: o.toChanboss ?? false, trackingNo: o.trackingNo ?? null, signed: o.signed ?? false,
});

const snap = (s: Partial<Snapshot> = {}): Snapshot => ({
	now: hours(2), settings: { lateDays: 6, channel: "海快", buyAccount: "A" }, accounts: new Map([["A", "桥头等白马"]]),
	orders: [order("1", 1), order("2", 2)],
	skus: new Map([["M1", { modelId: "M1", itemId: "I1", offerId: "O1", skuId: "S1" }]]),
	offers: new Map([["O1", { offerId: "O1", title: "红T 货源", live: true, skus: [{ skuId: "S1", specId: "sp1", name: "红色 L", price: 10, stock: 99, image: "" }] }]]),
	options: [], writes: [], purchases: [], cart: [], issues: [], ...s,
});

test("对采购单：采购单的件数按加购的先后分给订单，差的看购物车，都没有是不见了", () => {
	const w = { id: "1", account: "A", offerId: "O1", skuId: "S1", at: T0, lines: [{ sn: "1", modelId: "M1", qty: 1 }, { sn: "2", modelId: "M1", qty: 2 }] };
	const all = reconcile([w], [purchase(3, { signed: true })], []);
	assert.deepEqual(all.map((l) => [l.sn, l.state]), [["1", "已付款"], ["2", "已付款"]]);
	const part = reconcile([w], [purchase(2)], [{ account: "A", offerId: "O1", skuId: "S1", qty: 1 }]);
	assert.deepEqual(part.map((l) => [l.sn, l.state, l.paidQty, l.cartQty]), [["1", "已付款", 1, 0], ["2", "在购物车", 1, 1]]);
	assert.deepEqual(reconcile([w], [], []).map((l) => l.state), ["不见了", "不见了"]);
	// 加购以前就有的采购单不算
	assert.deepEqual(reconcile([w], [{ ...purchase(3), createdAt: hours(-48) }], []).map((l) => l.state), ["不见了", "不见了"]);
});

test("货源齐了、没加购：agent 准备一行加购，同一个 1688 规格的两张订单合在一起", () => {
	const r = checkOrders(snap());
	const t = r.todo.find((x) => x.kind === "加购");
	assert.ok(t && t.kind === "加购");
	const p = t.propose.writes[0]!.params as CartParams;
	assert.equal(p.qty, 3);
	assert.deepEqual(p.lines.map((l) => l.sn), ["1", "2"]);
	assert.equal(r.orders.get("1")!.step, "没加购");
	assert.equal(r.inbox.length, 0);
});

test("加购了在购物车里：收件箱「付款」，订单卡在没付款", () => {
	const r = checkOrders(snap({ writes: [cartWrite()], cart: [{ account: "A", offerId: "O1", skuId: "S1", qty: 3 }] }));
	const pay = r.inbox.find((i) => i.key === "pay:A");
	assert.ok(pay);
	assert.match(pay.title, /「桥头等白马」的购物车里 2 张订单的货 ¥30\.00/);
	assert.equal(r.orders.get("2")!.step, "没付款");
	assert.equal(r.todo.find((x) => x.kind === "加购"), undefined);
});

test("加购在等批准：不再准备，订单卡在加购等批准", () => {
	const r = checkOrders(snap({ writes: [cartWrite("待批准")] }));
	assert.equal(r.todo.find((x) => x.kind === "加购"), undefined);
	assert.equal(r.orders.get("1")!.step, "加购等批准");
});

test("付了款寄到我们这里：预报无单号；报过、到齐了：收件箱「打包」", () => {
	const paid = checkOrders(snap({ writes: [cartWrite()], purchases: [purchase(3)] }));
	const f = paid.todo.find((x) => x.kind === "预报");
	assert.ok(f && f.kind === "预报");
	assert.deepEqual((f.propose.writes as { params: ForecastParams }[]).map((w) => [w.params.sn, w.params.lines[0]!.trackingNo]), [["1", null], ["2", null]]);
	assert.equal(paid.orders.get("1")!.step, "没预报");

	const reported = [order("1", 1, { chanbossStatus: "已预报" }), order("2", 2, { chanbossStatus: "已预报" })];
	const waiting = checkOrders(snap({ orders: reported, writes: [cartWrite()], purchases: [purchase(3)] }));
	assert.match(waiting.orders.get("2")!.step, /货没到齐/);
	const arrived = checkOrders(snap({ orders: reported, writes: [cartWrite()], purchases: [purchase(3, { signed: true })] }));
	assert.deepEqual(arrived.inbox.filter((i) => i.kind === "打包").map((i) => i.key), ["pack:1", "pack:2"]);
	assert.equal(arrived.orders.get("1")!.step, "到齐了没打包");
});

test("寄到 chanboss：有了快递单号才预报，填快递单号", () => {
	const none = checkOrders(snap({ writes: [cartWrite()], purchases: [purchase(3, { toChanboss: true })] }));
	assert.equal(none.todo.find((x) => x.kind === "预报"), undefined);
	const shipped = checkOrders(snap({ writes: [cartWrite()], purchases: [purchase(3, { toChanboss: true, trackingNo: "YT123" })] }));
	const f = shipped.todo.find((x) => x.kind === "预报");
	assert.ok(f && f.kind === "预报");
	assert.equal((f.propose.writes[0]!.params as ForecastParams).lines[0]!.trackingNo, "YT123");
});

test("快到期：写出卡在哪一步", () => {
	const r = checkOrders(snap({ orders: [order("1", 1, { shipBy: hours(24) })] }));
	const late = r.inbox.find((i) => i.key === "late:1");
	assert.ok(late);
	assert.match(late.title, /还剩 0 天.*卡在：没加购/);
});

test("取消的订单：货还在购物车里，收件箱「取消」，购物车那一行不该买", () => {
	const r = checkOrders(snap({
		orders: [order("1", 1, { platformStatus: "不成立", cancelledAt: hours(1) }), order("2", 2)],
		writes: [cartWrite()], cart: [{ account: "A", offerId: "O1", skuId: "S1", qty: 3 }],
	}));
	const c = r.inbox.find((i) => i.key === "cancel:1");
	assert.ok(c);
	assert.match(c.title, /购物车里还有 1 件，删掉/);
	assert.match(r.cart.get("A|O1|S1")!.shouldBuy, /不该买：订单 1 取消了/);
	// 订单 2 还该买：付款那一行提醒先删掉不该买的
	assert.match(r.inbox.find((i) => i.key === "pay:A")!.detail, /付款前先删掉/);
});

test("选货源：只有一个明显对得上的随加购一起批准；几个候选拿不准的进收件箱", () => {
	const noSku = new Map([["M1", { modelId: "M1", itemId: "I1", offerId: null, skuId: null }]]);
	const sure = checkOrders(snap({ skus: noSku, options: [{ modelId: "M1", offerId: "O1", skuId: "S1", sure: true, chosen: false }] }));
	const t = sure.todo.find((x) => x.kind === "加购");
	assert.ok(t && t.kind === "加购");
	assert.deepEqual((t.propose.writes[0]!.params as CartParams).newSources, ["M1"]);

	const unsure = checkOrders(snap({ skus: noSku, options: [{ modelId: "M1", offerId: "O1", skuId: "S1", sure: false, chosen: false }, { modelId: "M1", offerId: "O2", skuId: "S2", sure: false, chosen: false }] }));
	assert.ok(unsure.inbox.find((i) => i.key === "source:M1"));
	assert.equal(unsure.todo.find((x) => x.kind === "加购"), undefined);
	assert.match(unsure.orders.get("1")!.step, /没货源/);

	const none = checkOrders(snap({ skus: noSku }));
	assert.ok(none.todo.find((x) => x.kind === "找货源"));

	const chosen = checkOrders(snap({ skus: noSku, options: [{ modelId: "M1", offerId: "O1", skuId: "S1", sure: false, chosen: true }] }));
	assert.deepEqual(chosen.chosenSources.map((o) => o.modelId), ["M1"]);
	assert.ok(chosen.todo.find((x) => x.kind === "加购"));
});

test("不是经 x2 加购、chanboss 上已经预报、采购单也对不上的订单：不准备加购，写出 chanboss 状态", () => {
	const r = checkOrders(snap({ orders: [order("1", 1, { chanbossStatus: "已预报" })] }));
	assert.equal(r.todo.length, 0);
	assert.equal(r.orders.get("1")!.step, "不是经 x2 买的");
	assert.match(r.orders.get("1")!.stepDetail!, /chanboss：已预报/);
});

test("在 x2 外面买了：采购单按 1688 规格分给订单（先下单的先分），不再加购，接着预报", () => {
	// 只买了 1 件：分给先下单的订单 1；订单 2 要 2 件，分不到，照常加购
	const o1 = order("1", 1, { createdAt: hours(-48) }), o2 = order("2", 2, { createdAt: hours(-24) });
	const r = checkOrders(snap({ orders: [o1, o2], purchases: [purchase(1)] }));
	assert.match(r.orders.get("1")!.stepDetail ?? "", /在 x2 外面买的/);
	assert.equal(r.orders.get("1")!.step, "没预报");
	const cart = r.todo.find((x) => x.kind === "加购");
	assert.ok(cart && cart.kind === "加购");
	assert.deepEqual((cart.propose.writes[0]!.params as CartParams).lines.map((l) => l.sn), ["2"]);
	assert.ok(r.covered.has("1:M1"));
	assert.ok(!r.covered.has("2:M1"));
});

test("x2 加了购、人又在外面买了：购物车那一行不该买（衣帽架 260917A6PM8V15 的情况）", () => {
	const early = { ...purchase(3), createdAt: hours(-20) };
	const r = checkOrders(snap({ writes: [cartWrite()], cart: [{ account: "A", offerId: "O1", skuId: "S1", qty: 3 }], purchases: [early] }));
	assert.match(r.cart.get("A|O1|S1")!.shouldBuy, /已经在外面买了/);
	assert.equal(r.inbox.find((i) => i.kind === "付款"), undefined);
});

test("买家取消：看货走到哪", () => {
	const cancelled = (o: Partial<Order>) => order("1", 1, { platformStatus: "不成立", cancelledAt: hours(1), ...o });
	const goods = (r: ReturnType<typeof checkOrders>) => r.inbox.find((i) => i.key === "cancel-goods:1")?.title ?? "";
	assert.equal(goods(checkOrders(snap({ orders: [cancelled({})] }))), "", "还没买：不用做");
	assert.match(goods(checkOrders(snap({ orders: [cancelled({})], purchases: [{ ...purchase(1), status: "waitsellersend" }] }))), /申请退款/);
	assert.match(goods(checkOrders(snap({ orders: [cancelled({})], purchases: [{ ...purchase(1), status: "success" }] }))), /退回 1688 卖家/);
	assert.match(goods(checkOrders(snap({ orders: [cancelled({ chanbossStatus: "已到齐" })] }))), /chanboss 仓库/);
	assert.match(goods(checkOrders(snap({ orders: [cancelled({ chanbossStatus: "已打包" })] }))), /到了台湾/);
	// 只挂着预报：不进收件箱，agent 去取消预报
	const r = checkOrders(snap({ orders: [cancelled({ chanbossStatus: "已预报" })] }));
	assert.equal(r.inbox.length, 0);
	assert.ok(r.todo.find((t) => t.kind === "取消预报"));
});

test("快到期：不到 6 天、还没打包就给人", () => {
	const r = checkOrders(snap({ orders: [order("1", 1, { shipBy: hours(24 * 5.9) }), order("2", 1, { shipBy: hours(24 * 6.5) })] }));
	assert.deepEqual(r.inbox.filter((i) => i.kind === "快到期").map((i) => i.key), ["late:1"]);
});

test("到货问题：人报了以后订单卡在到货有问题，不提醒打包；收件箱一个问题一行", () => {
	const reported = [order("1", 1, { chanbossStatus: "已预报" }), order("2", 2, { chanbossStatus: "已预报" })];
	const r = checkOrders(snap({ orders: reported, writes: [cartWrite()], purchases: [purchase(3, { signed: true })], issues: [{ id: "9", sn: "1", item: "红T", kind: "坏了", qty: 1, note: null, resolution: null }] }));
	assert.equal(r.orders.get("1")!.step, "到货有问题");
	assert.deepEqual(r.inbox.filter((i) => i.kind === "打包").map((i) => i.key), ["pack:2"]);
	assert.match(r.inbox.find((i) => i.key === "issue:9")!.title, /订单 1 红T 坏了 1 件/);
});

test("取消的货到了台湾：过了 30 天就不再提醒", () => {
	const o = order("1", 1, { platformStatus: "不成立", chanbossStatus: "已打包", cancelledAt: hours(-24 * 31) });
	assert.equal(checkOrders(snap({ orders: [o] })).inbox.find((i) => i.key === "cancel-goods:1"), undefined);
	const fresh = { ...o, cancelledAt: hours(-24 * 3) };
	assert.ok(checkOrders(snap({ orders: [fresh] })).inbox.find((i) => i.key === "cancel-goods:1"));
});
