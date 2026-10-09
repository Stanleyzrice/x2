// 检查订单：拿 docs/orders.md「每一步怎样算做完」和「异常」对一遍库，算出收件箱、agent 要做的，和订单上「卡在哪一步」等列。
// 纯函数：输入是从库里读出来的一份快照，输出要写回库的东西；读写库在 index.ts
import { type CartLine, type CartWrite, type Line, type Need, type Purchase, reconcile } from "./reconcile.ts";

export type Item = { itemId: string; modelId: string; chanbossModelId: string; name: string; spec: string; qty: number; image: string };
export type Order = {
	sn: string; shop: string | null; createdAt: Date | null; shipBy: Date | null; platformStatus: string; chanbossStatus: string; chanbossId: string; chanbossTime: number;
	items: Item[]; problem: string | null; cancelledAt: Date | null;
};
export type Sku = { modelId: string; itemId: string | null; offerId: string | null; skuId: string | null };
export type OfferSku = { skuId: string; specId: string; name: string; price: number; stock: number; image: string };
export type Offer = { offerId: string; title: string | null; live: boolean; skus: OfferSku[] };
export type Option = { modelId: string; offerId: string; skuId: string; sure: boolean; chosen: boolean };
export type Write = { id: string; batch: string; op: string; status: string; params: any; finishedAt: Date | null };
/** 到货问题：人在 NocoDB 的表单里报的、还没处理好的（错货、少件、坏了……） */
export type Issue = { id: string; sn: string; item: string | null; kind: string; qty: number | null; note: string | null; resolution: string | null };
/** buyAccount：采购账号（1688 userId），x2 只往它加购 */
export type Settings = { lateDays: number; channel: string; buyAccount: string | null };

export type Snapshot = {
	now: Date; settings: Settings; orders: Order[]; skus: Map<string, Sku>; offers: Map<string, Offer>; options: Option[];
	writes: Write[]; purchases: Purchase[]; cart: CartLine[]; issues: Issue[];
	/** 1688 账号：userId → 会员名 */
	accounts: Map<string, string>;
};

export type InboxItem = { key: string; kind: string; title: string; detail: string; shop: string | null; due: Date | null; link: string | null };
/** step：卡在哪一步（下面 STEPS 里的一个，看板按它分列）；stepDetail：细节（还差哪件、哪个规格没货源……） */
export type Computed = { daysLeft: number | null; sourced: boolean; carted: boolean; paid: boolean; arrived: boolean; destination: string | null; step: string; stepDetail: string | null };
/** 加购这个写操作的参数：同一个 1688 规格的几张订单合成一行。newSources：随这次加购一起批准的新货源 */
export type CartParams = {
	offerId: string; skuId: string; qty: number; title: string; sku: string; price: number | null;
	lines: { sn: string; modelId: string; qty: number }[]; newSources: string[]; account?: string;
};
export type ForecastParams = { sn: string; chanbossId: string; chanbossTime: number; lines: { modelId: string; chanbossModelId: string; qty: number; trackingNo: string | null }[] };
export type Todo =
	| { kind: "找货源"; why: string; models: { modelId: string; name: string; why: string }[]; command: string }
	| { kind: "加购" | "预报"; why: string; propose: { title: string; writes: { op: string; params: CartParams | ForecastParams }[] } }
	| { kind: "取消预报"; why: string; orders: string[] }
	| { kind: "核清"; why: string; writes: string[]; command: string };

/** covered：已经买了或者在购物车里的订单行（订单号:规格 id），不管是不是经 x2 加购的 */
export type Result = { inbox: InboxItem[]; orders: Map<string, Computed>; cart: Map<string, { orders: string; shouldBuy: string }>; todo: Todo[]; chosenSources: Option[]; covered: Set<string> };

/** 卡在哪一步：按流程排（看板的列也是这个顺序） */
export const STEPS = [
	"没货源", "没加购", "加购等批准", "没付款", "没预报", "预报等批准", "货没到齐", "到货有问题", "到齐了没打包", "等 chanboss 收货", "等 chanboss 打包",
	"不是经 x2 买的", "已打包", "取消了",
] as const;

/** 写入还没有结果、或结果要人看：同一个对象不再准备新的 */
const IN_FLIGHT = new Set(["待批准", "已批准", "已提交", "结果未知", "不一致"]);
const DONE = new Set(["成功", "已核对"]);
const CART_URL = "https://cart.1688.com/cart.htm";
const CHANBOSS_ORDERS = "https://c.chanboss.com/order/orderList";
const BUYER_ORDERS = "https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html";

const short = (s: string, n = 14) => (s.length > n ? `${s.slice(0, n)}…` : s);
export const label = (i: { name: string; spec: string }) => `${short(i.name)} / ${i.spec || "（单规格）"}`;
const DAY = 86_400_000;

const issueText = (x: Issue) => `${x.item ? `${x.item} ` : ""}${x.kind}${x.qty ? ` ${x.qty} 件` : ""}`;

export const isCancelled = (o: Order) => o.platformStatus === "不成立" || o.platformStatus === "取消中";
/** 已经过了「已打包」：剩下是 chanboss 和 Shopee 的事。买家这时取消，货算到了台湾 */
export const isPacked = (o: Order) => o.chanbossStatus === "已打包" || o.chanbossStatus === "已出库" || ["已出货", "已完成", "退货退款"].includes(o.platformStatus);
export const isOpen = (o: Order) => o.platformStatus === "待出货" && !isPacked(o);

export function checkOrders(s: Snapshot): Result {
	const inbox: InboxItem[] = [];
	const todo: Todo[] = [];
	const computed = new Map<string, Computed>();
	const chosenSources = new Map<string, Option>();
	const who = (account: string) => s.accounts.get(account) ?? account;

	// ── 加购记录、采购单 → 对采购单 ──
	const cartWrites: CartWrite[] = s.writes
		.filter((w) => w.op === "加购" && DONE.has(w.status) && w.params.account)
		.map((w) => ({ id: w.id, account: w.params.account, offerId: w.params.offerId, skuId: w.params.skuId, at: w.finishedAt ?? s.now, lines: w.params.lines }));
	// 每个订单行（有货源的）都拿去对剩下的采购单：x2 外面买的也认得出来；x2 加了购、人又另外买了，也认得出来
	const needs: Need[] = s.orders.flatMap((o) => o.items.flatMap((i) => {
		const sku = s.skus.get(i.modelId);
		return sku?.offerId && sku.skuId && o.createdAt ? [{ sn: o.sn, modelId: i.modelId, qty: i.qty, offerId: sku.offerId, skuId: sku.skuId, createdAt: o.createdAt }] : [];
	}));
	const lines = reconcile(cartWrites, s.purchases, s.cart, needs);
	const rank = { 已付款: 0, 在购物车: 1, 不见了: 2 } as const;
	const lineOf = new Map<string, Line>();
	for (const l of lines) {
		const k = `${l.sn}:${l.modelId}`;
		const had = lineOf.get(k);
		if (!had || rank[l.state] < rank[had.state]) lineOf.set(k, l);
	}
	/** 在外面买了（采购单对上了，不是经 x2 加购的） */
	const boughtOutside = new Set(lines.filter((l) => l.outside).map((l) => `${l.sn}:${l.modelId}`));
	// 正在路上的加购（待批准……结果未知）：这些订单行不再准备
	const flying = new Set(s.writes.filter((w) => w.op === "加购" && IN_FLIGHT.has(w.status)).flatMap((w) => (w.params.lines as CartParams["lines"]).map((l) => `${l.sn}:${l.modelId}`)));
	const forecastFlying = new Set(s.writes.filter((w) => w.op === "预报" && IN_FLIGHT.has(w.status)).map((w) => w.params.sn as string));

	// ── 货源 ──
	const optionsOf = new Map<string, Option[]>();
	for (const o of s.options) optionsOf.set(o.modelId, [...(optionsOf.get(o.modelId) ?? []), o]);
	type Source = { state: "有" | "新" | "待选" | "没有" | "失效"; offerId?: string; skuId?: string; why?: string };
	const sourceOf = (modelId: string): Source => {
		const sku = s.skus.get(modelId);
		const chosen = optionsOf.get(modelId)?.find((o) => o.chosen);
		if (chosen && (sku?.offerId !== chosen.offerId || sku?.skuId !== chosen.skuId)) {
			chosenSources.set(modelId, chosen);
			return { state: "有", offerId: chosen.offerId, skuId: chosen.skuId };
		}
		if (sku?.offerId && sku.skuId) {
			const offer = s.offers.get(sku.offerId);
			if (offer && !offer.live) return { state: "失效", why: "货源在 1688 上下架了" };
			if (offer && offer.skus.length && !offer.skus.some((x) => x.skuId === sku.skuId)) return { state: "失效", why: "1688 上没有这个规格了" };
			return { state: "有", offerId: sku.offerId, skuId: sku.skuId };
		}
		const opts = optionsOf.get(modelId) ?? [];
		const sure = opts.filter((o) => o.sure);
		if (sure.length === 1) return { state: "新", offerId: sure[0]!.offerId, skuId: sure[0]!.skuId };
		return opts.length ? { state: "待选" } : { state: "没有" };
	};

	const toFind = new Map<string, { modelId: string; name: string; why: string }>();
	const toChoose = new Map<string, { item: Item; due: Date | null; shop: string | null; n: number }>();
	const cartPlan = new Map<string, CartParams>();
	const forecasts: ForecastParams[] = [];
	const unforecast: string[] = [];
	const paySet = new Map<string, { lines: Line[]; due: Date | null }>();

	for (const o of s.orders) {
		const daysLeft = o.shipBy ? Math.round(((o.shipBy.getTime() - s.now.getTime()) / DAY) * 10) / 10 : null;
		if (isCancelled(o)) { checkCancelled(o); continue; }
		if (!isOpen(o)) {
			computed.set(o.sn, { daysLeft, sourced: true, carted: true, paid: true, arrived: true, destination: null, step: isPacked(o) ? "已打包" : o.platformStatus, stepDetail: o.chanbossStatus || null });
			if (o.problem && !isPacked(o)) inbox.push(problem(o));
			continue;
		}
		const sources = o.items.map((i) => ({ i, src: sourceOf(i.modelId), line: lineOf.get(`${o.sn}:${i.modelId}`) }));
		const needsBuy = o.chanbossStatus === "待处理";
		const sourced = sources.every((x) => x.src.state === "有" || x.src.state === "新");
		const carted = sources.every((x) => x.line && x.line.state !== "不见了");
		const paid = sources.every((x) => x.line?.state === "已付款");
		const ps = sources.flatMap((x) => x.line?.purchases ?? []);
		const arrived = paid && ps.every((p) => p.signed);
		// 寄到哪：采购单列表里没有收货地址（2026-10-09），都寄到 1688 的默认地址，当成寄到我们这里；认得出寄到 chanboss 的（toChanboss）才算寄到 chanboss
		const toChanboss = ps.map((p) => p.toChanboss === true);
		const destination = !paid ? null : toChanboss.every(Boolean) ? "寄到 chanboss" : toChanboss.some(Boolean) ? "两边都有" : "寄到我们这里";

		// 卡在哪一步
		let step: (typeof STEPS)[number];
		let stepDetail: string | null = null;
		if (!needsBuy && !paid) { step = "不是经 x2 买的"; stepDetail = `chanboss：${o.chanbossStatus}；采购单对不上（规格没有货源，或者在别的账号买的）`; }
		else if (!sourced) { step = "没货源"; stepDetail = sources.filter((x) => x.src.state !== "有" && x.src.state !== "新").map((x) => label(x.i)).join("、"); }
		else if (!carted && !paid) step = sources.some((x) => flying.has(`${o.sn}:${x.i.modelId}`)) ? "加购等批准" : "没加购";
		else if (!paid) step = "没付款";
		else if (needsBuy) step = forecastFlying.has(o.sn) ? "预报等批准" : "没预报";
		else if (destination === "寄到我们这里") {
			const missing = sources.filter((x) => !(x.line?.purchases ?? []).every((p) => p.signed)).map((x) => label(x.i));
			step = missing.length ? "货没到齐" : "到齐了没打包";
			if (missing.length) stepDetail = `还差 ${missing.join("、")}`;
		} else step = o.chanbossStatus === "已到齐" ? "等 chanboss 打包" : "等 chanboss 收货";
		// 到货有问题（人报的）：没处理好之前不提醒打包
		const issues = s.issues.filter((x) => x.sn === o.sn);
		if (issues.length && (step === "货没到齐" || step === "到齐了没打包")) { step = "到货有问题"; stepDetail = issues.map(issueText).join("；"); }
		if (sources.some((x) => boughtOutside.has(`${o.sn}:${x.i.modelId}`))) stepDetail = [stepDetail, "在 x2 外面买的"].filter(Boolean).join("；");
		computed.set(o.sn, { daysLeft, sourced, carted, paid, arrived, destination, step, stepDetail });

		// 选货源、找货源：只看还要买、还没买的订单行
		if (needsBuy) for (const { i, src, line } of sources) {
			if (line?.state === "已付款") continue;
			if (src.state === "没有" || src.state === "失效") toFind.set(i.modelId, { modelId: i.modelId, name: label(i), why: src.why ?? "没有货源" });
			if (src.state === "待选") {
				const had = toChoose.get(i.modelId);
				toChoose.set(i.modelId, { item: i, shop: o.shop, n: (had?.n ?? 0) + i.qty, due: had?.due && o.shipBy && had.due < o.shipBy ? had.due : o.shipBy });
			}
		}
		// 加购：还要买、货源齐了的订单，没加过（或加的不见了）、没在外面买、也没有在路上的
		if (needsBuy && sourced) for (const { i, src, line } of sources) {
			if ((line && line.state !== "不见了") || flying.has(`${o.sn}:${i.modelId}`)) continue;
			const k = `${src.offerId}:${src.skuId}`;
			const offer = s.offers.get(src.offerId!);
			const sku = offer?.skus.find((x) => x.skuId === src.skuId);
			const c = cartPlan.get(k) ?? { offerId: src.offerId!, skuId: src.skuId!, qty: 0, title: offer?.title ?? src.offerId!, sku: sku?.name || "（单规格）", price: sku?.price ?? null, lines: [], newSources: [] };
			c.qty += i.qty;
			c.lines.push({ sn: o.sn, modelId: i.modelId, qty: i.qty });
			if (src.state === "新" && !c.newSources.includes(i.modelId)) c.newSources.push(i.modelId);
			cartPlan.set(k, c);
		}
		// 付款：加购了还在购物车里的
		for (const { line } of sources) if (line?.state === "在购物车") {
			const p = paySet.get(line.account) ?? { lines: [], due: null };
			p.lines.push(line);
			if (o.shipBy && (!p.due || o.shipBy < p.due)) p.due = o.shipBy;
			paySet.set(line.account, p);
		}
		// 预报：付了款还没报的。寄到我们这里报无单号；寄到 chanboss 的要每件都有快递单号
		if (needsBuy && paid && !forecastFlying.has(o.sn) && destination !== "两边都有") {
			const byChanboss = destination === "寄到 chanboss";
			const ready = !byChanboss || sources.every((x) => (x.line?.purchases ?? []).every((p) => p.trackingNo));
			if (ready) forecasts.push({
				sn: o.sn, chanbossId: o.chanbossId, chanbossTime: o.chanbossTime,
				lines: sources.map(({ i, line }) => ({ modelId: i.modelId, chanbossModelId: i.chanbossModelId, qty: i.qty, trackingNo: byChanboss ? line!.purchases[0]?.trackingNo ?? null : null })),
			});
		}
		// 打包：寄到我们这里、到齐了、报过了
		if (destination === "寄到我们这里" && arrived && !needsBuy && !issues.length) inbox.push({
			key: `pack:${o.sn}`, kind: "打包", shop: o.shop, due: o.shipBy, link: CHANBOSS_ORDERS,
			title: `打包：订单 ${o.sn} 的货到齐了`,
			detail: `${o.items.map((i) => `${label(i)} × ${i.qty}`).join("\n")}\n按这张订单装好，在 chanboss 上打印 SKU 拣货单贴上，寄给 chanboss`,
		});
		// 快到期：离出货期限不到 N 天还没打包，直接给人
		if (daysLeft !== null && daysLeft < s.settings.lateDays) inbox.push({
			key: `late:${o.sn}`, kind: "快到期", shop: o.shop, due: o.shipBy, link: CHANBOSS_ORDERS,
			title: `快到期：${o.sn} 出货期限还剩 ${Math.max(0, Math.floor(daysLeft))} 天，还没打包（卡在：${step}${stepDetail ? `，${stepDetail}` : ""}）`,
			detail: o.items.map((i) => `${label(i)} × ${i.qty}`).join("\n"),
		});
		if (o.problem) inbox.push(problem(o));
	}

	// 到货问题：一个问题一行，人在「到货问题」里勾「处理好了」就关
	for (const x of s.issues) {
		const o = s.orders.find((y) => y.sn === x.sn);
		inbox.push({
			key: `issue:${x.id}`, kind: "到货问题", shop: o?.shop ?? null, due: o?.shipBy ?? null, link: null,
			title: `到货问题：订单 ${x.sn} ${issueText(x)}`,
			detail: [
				...(o ? [] : ["库里没有这张订单：订单号对吗？"]),
				...(x.note ? [x.note] : []),
				`怎么处理：${x.resolution ?? "还没定（退换、重新买、不用管）"}`,
				"处理完在「到货问题」里勾「处理好了」",
			].join("\n"),
		});
	}

	function problem(o: Order): InboxItem {
		return { key: `problem:${o.sn}`, kind: "问题单", shop: o.shop, due: o.shipBy, link: CHANBOSS_ORDERS, title: `问题单：订单 ${o.sn} 在 chanboss 标了问题`, detail: o.problem ?? "" };
	}

	// 买家取消：看货走到了哪（docs/orders.md「买家取消」）。
	// 购物车里的：删掉（x2 看得到删没删）。货的去处（退款、退回卖家、合并给新订单、台湾仓）：x2 看不到结果，人做完在收件箱勾「处理好了」。
	// chanboss 上的预报：不重要了，agent 去取消
	function checkCancelled(o: Order) {
		const mine = o.items.map((i) => ({ i, line: lineOf.get(`${o.sn}:${i.modelId}`) }));
		computed.set(o.sn, { daysLeft: null, sourced: false, carted: mine.some((x) => x.line), paid: false, arrived: false, destination: null, step: "取消了", stepDetail: o.chanbossStatus || null });
		const inCart = lines.filter((l) => l.sn === o.sn && l.cartQty > 0);
		if (inCart.length) inbox.push({
			key: `cancel:${o.sn}`, kind: "取消", shop: o.shop, due: null, link: CART_URL,
			title: `取消：订单 ${o.sn} 取消了，购物车里还有 ${inCart.reduce((n, l) => n + l.cartQty, 0)} 件，删掉`,
			detail: inCart.map((l) => `${label(o.items.find((i) => i.modelId === l.modelId)!)} × ${l.cartQty}（账号 ${who(l.account)}）`).join("\n"),
		});
		if (o.chanbossStatus === "已预报") unforecast.push(o.sn);
		// 货的去处：where 货在哪，what 怎么办
		let where: string | null = null;
		let what = "";
		let due: Date | null = null;
		const bought = mine.filter((x) => x.line?.state === "已付款");
		if (isPacked(o)) {
			where = "货到了台湾"; what = "在 chanboss 台湾仓上架，30 天内给别的订单用（过了 30 天货代会处理掉）";
			// 30 天从上架算；还读不到上架时间，先按取消的时间算。过了期限货就没了：这件事也就结束了，不再提醒
			due = o.cancelledAt ? new Date(o.cancelledAt.getTime() + 30 * DAY) : null;
			if (due && due < s.now) where = null;
		} else if (o.chanbossStatus === "已到齐") { where = "货在 chanboss 仓库"; what = "给新订单用（合并发货），或者退回卖家"; }
		else if (bought.length) {
			const shipped = bought.some((x) => x.line!.purchases.some((p) => p.status !== "waitsellersend"));
			where = shipped ? "1688 已经发货" : "付了款，1688 还没发货";
			what = shipped ? "退回 1688 卖家" : "在 1688 申请退款";
		}
		if (where) inbox.push({
			key: `cancel-goods:${o.sn}`, kind: "取消", shop: o.shop, due, link: isPacked(o) || o.chanbossStatus === "已到齐" ? CHANBOSS_ORDERS : BUYER_ORDERS,
			title: `取消：订单 ${o.sn} 取消了，${where}，${what}`,
			detail: [
				...o.items.map((i) => `${label(i)} × ${i.qty}`),
				...bought.map((x) => `采购单 ${x.line!.purchases.map((p) => p.orderId).join("、")}：${label(x.i)} × ${x.line!.paidQty}${x.line!.outside ? "（在 x2 外面买的）" : ""}`),
				"", "做完在这一行勾「处理好了」",
			].join("\n"),
		});
	}

	// ── 收件箱：选货源、付款 ──
	for (const [modelId, c] of toChoose) inbox.push({
		key: `source:${modelId}`, kind: "选货源", shop: c.shop, due: c.due, link: null,
		title: `选货源：${label(c.item)} 拿不准用哪个 1688 规格（要买 ${c.n} 件）`, detail: `候选在「选货源」里，勾一个「用这个」`,
	});
	const offerName = (l: Line) => {
		const offer = s.offers.get(l.offerId);
		const sku = offer?.skus.find((x) => x.skuId === l.skuId);
		return { name: `${short(offer?.title ?? l.offerId)} / ${sku?.name || "（单规格）"}`, price: sku?.price ?? null };
	};
	const cartRows = new Map<string, { orders: string[]; shouldBuy: string }>();
	for (const l of lines) if (l.cartQty > 0) {
		const k = `${l.account}|${l.offerId}|${l.skuId}`;
		const o = s.orders.find((x) => x.sn === l.sn);
		const why = !o ? "订单不在库里" : isCancelled(o) ? `不该买：订单 ${o.sn} 取消了` : isPacked(o) ? `不该买：订单 ${o.sn} 已经打包了`
			: boughtOutside.has(`${l.sn}:${l.modelId}`) ? `不该买：订单 ${o.sn} 已经在外面买了` : "该买";
		const row = cartRows.get(k) ?? { orders: [], shouldBuy: "该买" };
		row.orders.push(`${l.sn} × ${l.cartQty}`);
		if (why !== "该买") row.shouldBuy = why;
		cartRows.set(k, row);
	}
	for (const c of s.cart) {
		const k = `${c.account}|${c.offerId}|${c.skuId}`;
		if (!cartRows.has(k)) cartRows.set(k, { orders: [], shouldBuy: "不是 x2 加的" });
	}
	for (const [account, p] of paySet) {
		const sns = new Set(p.lines.map((l) => l.sn));
		const total = p.lines.reduce((sum, l) => sum + (offerName(l).price ?? Number.NaN) * l.cartQty, 0);
		const not = [...cartRows.entries()].filter(([k, r]) => k.startsWith(`${account}|`) && r.shouldBuy.startsWith("不该买"));
		inbox.push({
			key: `pay:${account}`, kind: "付款", shop: null, due: p.due, link: CART_URL,
			title: `付款：1688 账号「${who(account)}」的购物车里 ${sns.size} 张订单的货${Number.isNaN(total) ? "" : ` ¥${total.toFixed(2)}`}`,
			detail: [
				...p.lines.map((l) => `${offerName(l).name} × ${l.cartQty}（订单 ${l.sn}）`),
				...(not.length ? ["", "付款前先删掉这些（不该买）：", ...not.map(([k, r]) => `${k.split("|").slice(1).join(" / ")}：${r.shouldBuy}`)] : []),
				"", "付完在 agent 里说「我付好了」",
			].join("\n"),
		});
	}

	// ── agent 要做的 ──
	if (toFind.size) todo.push({ kind: "找货源", why: `${toFind.size} 个规格没有货源或货源失效`, models: [...toFind.values()], command: `x2 source ${[...toFind.keys()].join(" ")}` });
	if (cartPlan.size) {
		const plan = [...cartPlan.values()].map((c) => (s.settings.buyAccount ? { ...c, account: s.settings.buyAccount } : c));
		const sns = new Set(plan.flatMap((c) => c.lines.map((l) => l.sn)));
		todo.push({
			kind: "加购", why: `${sns.size} 张订单货源齐了，还没加购`,
			propose: { title: `加购：${plan.map((c) => `${short(c.title, 10)} / ${c.sku} × ${c.qty}`).join("；")}（订单 ${[...sns].join("、")}）`, writes: plan.map((params) => ({ op: "加购", params })) },
		});
	}
	if (forecasts.length) todo.push({
		kind: "预报", why: `${forecasts.length} 张订单付了款，还没预报`,
		propose: {
			title: `预报 ${forecasts.length} 张订单（${s.settings.channel}、${forecasts.every((f) => f.lines.every((l) => !l.trackingNo)) ? "无单号" : "带快递单号"}）：${forecasts.map((f) => f.sn).join("、")}`,
			writes: forecasts.map((params) => ({ op: "预报", params })),
		},
	});
	if (unforecast.length) todo.push({ kind: "取消预报", why: `${unforecast.length} 张取消的订单在 chanboss 上还是已预报（不重要；x2 还不会取消预报，先不管）`, orders: unforecast });
	const unknown = s.writes.filter((w) => w.status === "结果未知" || w.status === "已提交");
	if (unknown.length) todo.push({ kind: "核清", why: `${unknown.length} 个写入结果未知：先读回来`, writes: unknown.map((w) => w.id), command: "x2 run" });

	return { inbox, orders: computed, cart: new Map([...cartRows].map(([k, r]) => [k, { orders: r.orders.join("、"), shouldBuy: r.shouldBuy }])), todo, chosenSources: [...chosenSources.values()],
		covered: new Set([...lineOf.values()].filter((l) => l.state !== "不见了").map((l) => `${l.sn}:${l.modelId}`)) };
}

/** 检查现在认为该做的：加购的订单行（订单号:规格 id）、该预报的订单号。x2 propose 只收这些；x2 run 加购前现读一遍再对一次 */
export function planned(r: Result): { cart: Set<string>; forecast: Set<string> } {
	const cart = new Set<string>(), forecast = new Set<string>();
	for (const t of r.todo) {
		if (t.kind === "加购") for (const w of t.propose.writes) for (const l of (w.params as CartParams).lines) cart.add(`${l.sn}:${l.modelId}`);
		if (t.kind === "预报") for (const w of t.propose.writes) forecast.add((w.params as ForecastParams).sn);
	}
	return { cart, forecast };
}
