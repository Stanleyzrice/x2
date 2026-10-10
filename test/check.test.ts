import assert from "node:assert/strict";
import { test } from "node:test";
import { type CartParams, checkOrders, type ForecastParams, type Order, type Snapshot, type Source } from "../src/check/orders.ts";
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

const sku = (skuId: string, name: string) => ({ skuId, specId: `sp${skuId}`, name, price: 10, stock: 99, image: "" });
const source = (o: Partial<Source> = {}): Source => ({ itemId: "I1", offerId: "O1", title: "红T 货源", skus: [sku("S1", "红色 L"), sku("S2", "白色 L")], chosen: false, sure: false, broken: null, ...o });

const snap = (s: Partial<Snapshot> = {}): Snapshot => ({
	now: hours(2), settings: { lateDays: 6, channel: "海快", buyAccount: "A" }, accounts: new Map([["A", "采购员"]]),
	orders: [order("1", 1), order("2", 2)],
	sources: [source({ chosen: true })], writes: [], purchases: [], cart: [], issues: [], ...s,
});

test("采购单分给订单：采购单的件数按加购的先后分给订单，差的看购物车，都没有是不见了", () => {
	const w = { id: "1", account: "A", offerId: "O1", skuId: "S1", at: T0, lines: [{ sn: "1", modelId: "M1", qty: 1 }, { sn: "2", modelId: "M1", qty: 2 }] };
	const all = reconcile([w], [purchase(3, { signed: true })], []);
	assert.deepEqual(all.map((l) => [l.sn, l.state]), [["1", "已付款"], ["2", "已付款"]]);
	const part = reconcile([w], [purchase(2)], [{ account: "A", offerId: "O1", skuId: "S1", qty: 1 }]);
	assert.deepEqual(part.map((l) => [l.sn, l.state, l.paidQty, l.cartQty]), [["1", "已付款", 1, 0], ["2", "在购物车", 1, 1]]);
	assert.deepEqual(reconcile([w], [], []).map((l) => l.state), ["不见了", "不见了"]);
	// 加购以前就有的采购单不算
	assert.deepEqual(reconcile([w], [{ ...purchase(3), createdAt: hours(-48) }], []).map((l) => l.state), ["不见了", "不见了"]);
});

test("货源齐了、待加购：agent 准备一行加购，同一个货源的规格的两张订单合在一起", () => {
	const r = checkOrders(snap());
	const t = r.todo.find((x) => x.kind === "加购");
	assert.ok(t && t.kind === "加购");
	const p = t.propose.writes[0]!.params as CartParams;
	assert.equal(p.qty, 3);
	assert.deepEqual(p.lines.map((l) => l.sn), ["1", "2"]);
	assert.equal(r.orders.get("1")!.step, "待加购");
	assert.equal(r.inbox.length, 0);
});

test("加购了在购物车里：收件箱「付款」，订单停在待付款", () => {
	const r = checkOrders(snap({ writes: [cartWrite()], cart: [{ account: "A", offerId: "O1", skuId: "S1", qty: 3 }] }));
	const pay = r.inbox.find((i) => i.key === "pay:A");
	assert.ok(pay);
	assert.match(pay.title, /「采购员」的购物车里 2 张订单的货 ¥30\.00/);
	assert.equal(r.orders.get("2")!.step, "待付款");
	assert.equal(r.todo.find((x) => x.kind === "加购"), undefined);
});

test("加购待批准：不再准备，订单停在加购待批准", () => {
	const r = checkOrders(snap({ writes: [cartWrite("待批准")] }));
	assert.equal(r.todo.find((x) => x.kind === "加购"), undefined);
	assert.equal(r.orders.get("1")!.step, "加购待批准");
});

test("付了款寄到我们这里：预报无单号；报过、到齐了：收件箱「打包」", () => {
	const paid = checkOrders(snap({ writes: [cartWrite()], purchases: [purchase(3)] }));
	const f = paid.todo.find((x) => x.kind === "预报");
	assert.ok(f && f.kind === "预报");
	assert.deepEqual((f.propose.writes as { params: ForecastParams }[]).map((w) => [w.params.sn, w.params.lines[0]!.trackingNo]), [["1", null], ["2", null]]);
	assert.equal(paid.orders.get("1")!.step, "待预报");

	const reported = [order("1", 1, { chanbossStatus: "已预报" }), order("2", 2, { chanbossStatus: "已预报" })];
	const waiting = checkOrders(snap({ orders: reported, writes: [cartWrite()], purchases: [purchase(3)] }));
	assert.match(waiting.orders.get("2")!.step, /待到齐/);
	const arrived = checkOrders(snap({ orders: reported, writes: [cartWrite()], purchases: [purchase(3, { signed: true })] }));
	assert.deepEqual(arrived.inbox.filter((i) => i.kind === "打包").map((i) => i.key), ["pack:1", "pack:2"]);
	assert.equal(arrived.orders.get("1")!.step, "待打包");
});

test("寄到 chanboss：有了快递单号才预报，填快递单号", () => {
	const none = checkOrders(snap({ writes: [cartWrite()], purchases: [purchase(3, { toChanboss: true })] }));
	assert.equal(none.todo.find((x) => x.kind === "预报"), undefined);
	const shipped = checkOrders(snap({ writes: [cartWrite()], purchases: [purchase(3, { toChanboss: true, trackingNo: "YT123" })] }));
	const f = shipped.todo.find((x) => x.kind === "预报");
	assert.ok(f && f.kind === "预报");
	assert.equal((f.propose.writes[0]!.params as ForecastParams).lines[0]!.trackingNo, "YT123");
});

test("快到期：写出当前步骤", () => {
	const r = checkOrders(snap({ orders: [order("1", 1, { shipBy: hours(24) })] }));
	const late = r.inbox.find((i) => i.key === "late:1");
	assert.ok(late);
	assert.match(late.title, /剩余 0 天，未打包（当前步骤：待加购/);
});

test("取消的订单：货还在购物车里，收件箱「取消」，购物车那一行不该买", () => {
	const r = checkOrders(snap({
		orders: [order("1", 1, { platformStatus: "不成立", cancelledAt: hours(1) }), order("2", 2)],
		writes: [cartWrite()], cart: [{ account: "A", offerId: "O1", skuId: "S1", qty: 3 }],
	}));
	const c = r.inbox.find((i) => i.key === "cancel:1");
	assert.ok(c);
	assert.match(c.title, /订单 1 已取消，购物车里还有 1 件待删除/);
	assert.match(r.cart.get("A|O1|S1")!.shouldBuy, /不该买：订单 1 已取消/);
	// 订单 2 还该买：付款那一行提醒先删掉不该买的
	assert.match(r.inbox.find((i) => i.key === "pay:A")!.detail, /付款前先删除/);
});

test("选货源：只有一个明显匹配的随加购一起批准；几个候选拿不准的进收件箱", () => {
	const sure = checkOrders(snap({ sources: [source({ sure: true })] }));
	const t = sure.todo.find((x) => x.kind === "加购");
	assert.ok(t && t.kind === "加购");
	assert.deepEqual((t.propose.writes[0]!.params as CartParams).newSources, ["I1"]);

	const unsure = checkOrders(snap({ sources: [source(), source({ offerId: "O2" })] }));
	assert.ok(unsure.inbox.find((i) => i.key === "source:I1"));
	assert.equal(unsure.todo.find((x) => x.kind === "加购"), undefined);
	assert.match(unsure.orders.get("1")!.step, /缺货源/);

	const none = checkOrders(snap({ sources: [] }));
	assert.ok(none.todo.find((x) => x.kind === "找货源"));

	// 选用的货源不可用（加购前现读发现下架）：当成缺货源，agent 重新找
	const broken = checkOrders(snap({ sources: [source({ chosen: true, broken: "货源已在 1688 下架" })] }));
	assert.match(broken.todo.find((x) => x.kind === "找货源")!.why, /缺货源或货源不可用/);
	assert.equal(broken.todo.find((x) => x.kind === "加购"), undefined);
});

test("不是经 x2 加购、chanboss 上已经预报、采购单也对不上的订单：不准备加购，写出 chanboss 状态", () => {
	const r = checkOrders(snap({ orders: [order("1", 1, { chanbossStatus: "已预报" })] }));
	assert.equal(r.todo.length, 0);
	assert.equal(r.orders.get("1")!.step, "外部采购");
	assert.match(r.orders.get("1")!.stepDetail!, /chanboss：已预报/);
});

test("外部采购：采购单按货源的规格分给订单（先下单的先分），不再加购，接着预报", () => {
	// 只买了 1 件：分给先下单的订单 1；订单 2 要 2 件，分不到，照常加购
	const o1 = order("1", 1, { createdAt: hours(-48) }), o2 = order("2", 2, { createdAt: hours(-24) });
	const r = checkOrders(snap({ orders: [o1, o2], purchases: [purchase(1)] }));
	assert.match(r.orders.get("1")!.stepDetail ?? "", /外部采购/);
	assert.equal(r.orders.get("1")!.step, "待预报");
	const cart = r.todo.find((x) => x.kind === "加购");
	assert.ok(cart && cart.kind === "加购");
	assert.deepEqual((cart.propose.writes[0]!.params as CartParams).lines.map((l) => l.sn), ["2"]);
	assert.ok(r.covered.has("1:M1"));
	assert.ok(!r.covered.has("2:M1"));
});

test("x2 加了购、人又外部采购了：购物车那一行不该买", () => {
	const early = { ...purchase(3), createdAt: hours(-20) };
	const r = checkOrders(snap({ writes: [cartWrite()], cart: [{ account: "A", offerId: "O1", skuId: "S1", qty: 3 }], purchases: [early] }));
	assert.match(r.cart.get("A|O1|S1")!.shouldBuy, /已有外部采购/);
	assert.equal(r.inbox.find((i) => i.kind === "付款"), undefined);
});

test("买家取消：看货走到哪", () => {
	const cancelled = (o: Partial<Order>) => order("1", 1, { platformStatus: "不成立", cancelledAt: hours(1), ...o });
	const goods = (r: ReturnType<typeof checkOrders>) => r.inbox.find((i) => i.key === "cancel-goods:1")?.title ?? "";
	assert.equal(goods(checkOrders(snap({ orders: [cancelled({})] }))), "", "还没买：不用做");
	assert.match(goods(checkOrders(snap({ orders: [cancelled({})], purchases: [{ ...purchase(1), status: "waitsellersend" }] }))), /申请退款/);
	assert.match(goods(checkOrders(snap({ orders: [cancelled({})], purchases: [{ ...purchase(1), status: "success" }] }))), /退回 1688 卖家/);
	assert.match(goods(checkOrders(snap({ orders: [cancelled({ chanbossStatus: "已到齐" })] }))), /chanboss 仓库/);
	assert.match(goods(checkOrders(snap({ orders: [cancelled({ chanbossStatus: "已打包" })] }))), /货已到台湾/);
	// 只挂着预报：不进收件箱，agent 去取消预报
	const r = checkOrders(snap({ orders: [cancelled({ chanbossStatus: "已预报" })] }));
	assert.equal(r.inbox.length, 0);
	assert.ok(r.todo.find((t) => t.kind === "取消预报"));
});

test("快到期：不到 6 天、还没打包就给人", () => {
	const r = checkOrders(snap({ orders: [order("1", 1, { shipBy: hours(24 * 5.9) }), order("2", 1, { shipBy: hours(24 * 6.5) })] }));
	assert.deepEqual(r.inbox.filter((i) => i.kind === "快到期").map((i) => i.key), ["late:1"]);
});

test("到货问题：人上报以后订单停在有到货问题，不提醒打包；收件箱一个问题一行", () => {
	const reported = [order("1", 1, { chanbossStatus: "已预报" }), order("2", 2, { chanbossStatus: "已预报" })];
	const r = checkOrders(snap({ orders: reported, writes: [cartWrite()], purchases: [purchase(3, { signed: true })], issues: [{ id: "9", sn: "1", item: "红T", kind: "损坏", qty: 1, note: null, resolution: null }] }));
	assert.equal(r.orders.get("1")!.step, "有到货问题");
	assert.deepEqual(r.inbox.filter((i) => i.kind === "打包").map((i) => i.key), ["pack:2"]);
	assert.match(r.inbox.find((i) => i.key === "issue:9")!.title, /订单 1 红T 损坏 1 件/);
});

test("取消的货到了台湾：过了 30 天就不再提醒", () => {
	const o = order("1", 1, { platformStatus: "不成立", chanbossStatus: "已打包", cancelledAt: hours(-24 * 31) });
	assert.equal(checkOrders(snap({ orders: [o] })).inbox.find((i) => i.key === "cancel-goods:1"), undefined);
	const fresh = { ...o, cancelledAt: hours(-24 * 3) };
	assert.ok(checkOrders(snap({ orders: [fresh] })).inbox.find((i) => i.key === "cancel-goods:1"));
});

test("买家取消、货已经买了：退款进度 x2 读得到，退成了就不再提醒", () => {
	const o = order("1", 1, { platformStatus: "不成立", cancelledAt: hours(1) });
	const bought = (refund: any) => checkOrders(snap({ orders: [o], purchases: [{ ...purchase(1), status: "waitbuyerreceive", refund }] })).inbox.find((i) => i.key === "cancel-goods:1")?.title ?? "";
	assert.match(bought(null), /退回 1688 卖家/);
	assert.match(bought({ status: "waitbuyersend", label: "退款协议达成，等待买家退货", kind: "退货退款" }), /退货退款进行中，退款协议达成，等待买家退货/);
	assert.match(bought({ status: "refundclose", label: "退款关闭", kind: "退货退款" }), /退款已关闭（未退成）/);
	assert.equal(bought({ status: "refundsuccess", label: "退款成功", kind: "退货退款" }), "");
});

test("1688 付了款，过了 48 小时还没发货：给人催", () => {
	const waiting = { ...purchase(3), status: "waitsellersend", paidAt: hours(-50) };
	const r = checkOrders(snap({ writes: [cartWrite()], purchases: [waiting] }));
	assert.match(r.inbox.find((i) => i.key === "unshipped:P1")!.title, /未发货：1688 采购单 P1 付款已 52 小时仍未发货（订单 1、2）/);
	assert.equal(checkOrders(snap({ purchases: [{ ...waiting, paidAt: hours(-10) }] })).inbox.find((i) => i.kind === "未发货"), undefined);
});

test("一个商品一个货源：店里的规格按名字在货源的规格里配；配不上进收件箱「规格不匹配」，不加购", () => {
	const r = checkOrders(snap({ sources: [source({ chosen: true, skus: [sku("S9", "蓝色 XL")] })] }));
	assert.equal(r.orders.get("1")!.step, "规格不匹配");
	assert.ok(r.inbox.find((i) => i.key === "sku:M1"));
	assert.equal(r.todo.find((x) => x.kind === "加购"), undefined);
	// 配上了：加购用配上的货源规格
	const ok = checkOrders(snap());
	const t = ok.todo.find((x) => x.kind === "加购");
	assert.ok(t && t.kind === "加购");
	assert.equal((t.propose.writes[0]!.params as CartParams).skuId, "S1");
});

test("取消的订单只分到取消以前下的采购单", () => {
	const o = order("1", 1, { platformStatus: "不成立", createdAt: hours(-48), cancelledAt: hours(-24) });
	const after = { ...purchase(1), createdAt: hours(-10), status: "waitbuyerreceive" };
	assert.equal(checkOrders(snap({ orders: [o], purchases: [after] })).inbox.find((i) => i.key === "cancel-goods:1"), undefined);
	const before = { ...after, createdAt: hours(-30) };
	assert.ok(checkOrders(snap({ orders: [o], purchases: [before] })).inbox.find((i) => i.key === "cancel-goods:1"));
});

test("规格不匹配：收件箱写出照抄的一行和最像的几个；人写了规格例外就照它加购", () => {
	const skus = [sku("S8", "大红 L 加长"), sku("S9", "蓝色 XL")];
	const r = checkOrders(snap({ sources: [source({ chosen: true, skus })] }));
	const detail = r.inbox.find((i) => i.key === "sku:M1")!.detail;
	assert.match(detail, /\n红色 L = .+\n/);
	assert.match(detail, /· 大红 L 加长/);
	const ok = checkOrders(snap({ sources: [source({ chosen: true, skus, exceptions: "红色 L = 大红 L 加长" })] }));
	assert.equal(ok.inbox.find((i) => i.kind === "规格不匹配"), undefined);
	const t = ok.todo.find((x) => x.kind === "加购");
	assert.ok(t && t.kind === "加购");
	assert.equal((t.propose.writes[0]!.params as CartParams).skuId, "S8");
	// 写的那个货源里没有了（卖家改了规格名）：还是规格不匹配，写出原因
	const gone = checkOrders(snap({ sources: [source({ chosen: true, skus, exceptions: "红色 L = 粉色 L" })] }));
	assert.match(gone.inbox.find((i) => i.key === "sku:M1")!.detail, /规格例外中的「粉色 L」在货源「红T 货源」里已不存在/);
});
