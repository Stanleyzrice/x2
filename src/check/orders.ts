// 检查订单：拿 docs/orders.md「每一步怎样算做完」对一遍库，算出收件箱、agent 要做的，和订单上「卡在哪一步」等列。
// 纯函数：输入是从库里读出来的一份快照，输出要写回库的东西；读写库在 index.ts
import { type CartLine, type CartWrite, type Line, type Purchase, reconcile } from "./reconcile.ts";

export type Item = { itemId: string; modelId: string; chanbossModelId: string; name: string; spec: string; qty: number; image: string };
export type Order = {
	sn: string; shop: string | null; shipBy: Date | null; platformStatus: string; chanbossStatus: string; chanbossId: string; chanbossTime: number;
	items: Item[]; problem: string | null; cancelledAt: Date | null;
};
export type Sku = { modelId: string; itemId: string | null; offerId: string | null; skuId: string | null };
export type OfferSku = { skuId: string; specId: string; name: string; price: number; stock: number; image: string };
export type Offer = { offerId: string; title: string | null; live: boolean; skus: OfferSku[] };
export type Option = { modelId: string; offerId: string; skuId: string; sure: boolean; chosen: boolean };
export type Write = { id: string; batch: string; op: string; status: string; params: any; finishedAt: Date | null };
export type Settings = { lateDays: number; chanbossAddress: string | null; channel: string };

export type Snapshot = {
	now: Date; settings: Settings; orders: Order[]; skus: Map<string, Sku>; offers: Map<string, Offer>; options: Option[];
	writes: Write[]; purchases: Purchase[]; cart: CartLine[];
};

export type InboxItem = { key: string; kind: string; title: string; detail: string; shop: string | null; due: Date | null; link: string | null };
export type Computed = { daysLeft: number | null; sourced: boolean; carted: boolean; paid: boolean; arrived: boolean; destination: string | null; step: string };
/** 加购这个写操作的参数：同一个 1688 规格的几张订单合成一行。newSources：随这次加购一起批准的新货源 */
export type CartParams = {
	offerId: string; skuId: string; qty: number; title: string; sku: string; price: number | null;
	lines: { sn: string; modelId: string; qty: number }[]; newSources: string[]; account?: string;
};
export type ForecastParams = { sn: string; chanbossId: string; chanbossTime: number; lines: { modelId: string; chanbossModelId: string; qty: number; trackingNo: string | null }[] };
export type Todo =
	| { kind: "找货源"; why: string; models: { modelId: string; name: string; why: string }[]; command: string }
	| { kind: "加购" | "预报"; why: string; propose: { title: string; writes: { op: string; params: CartParams | ForecastParams }[] } }
	| { kind: "核清"; why: string; writes: string[]; command: string };

export type Result = { inbox: InboxItem[]; orders: Map<string, Computed>; cart: Map<string, { orders: string; shouldBuy: string }>; todo: Todo[]; chosenSources: Option[] };

/** 写入还没有结果、或结果要人看：同一个对象不再准备新的 */
const IN_FLIGHT = new Set(["待批准", "已批准", "已提交", "结果未知", "不一致"]);
const DONE = new Set(["成功", "已核对"]);
const CART_URL = "https://cart.1688.com/cart.htm";
const CHANBOSS_ORDERS = "https://c.chanboss.com/order/orderList";

const short = (s: string, n = 14) => (s.length > n ? `${s.slice(0, n)}…` : s);
export const label = (i: { name: string; spec: string }) => `${short(i.name)} / ${i.spec || "（单规格）"}`;
const DAY = 86_400_000;

export const isCancelled = (o: Order) => o.platformStatus === "不成立" || o.platformStatus === "取消中";
/** 已经过了「已打包」：剩下是 chanboss 和 Shopee 的事 */
export const isPacked = (o: Order) => o.chanbossStatus === "已打包" || o.chanbossStatus === "已出库" || ["已出货", "已完成", "退货退款"].includes(o.platformStatus);
export const isOpen = (o: Order) => o.platformStatus === "待出货" && !isPacked(o);

export function checkOrders(s: Snapshot): Result {
	const inbox: InboxItem[] = [];
	const todo: Todo[] = [];
	const computed = new Map<string, Computed>();
	const chosenSources = new Map<string, Option>();

	// ── 加购记录 → 对采购单 ──
	const cartWrites: CartWrite[] = s.writes
		.filter((w) => w.op === "加购" && DONE.has(w.status) && w.params.account)
		.map((w) => ({ id: w.id, account: w.params.account, offerId: w.params.offerId, skuId: w.params.skuId, at: w.finishedAt ?? s.now, lines: w.params.lines }));
	const lines = reconcile(cartWrites, s.purchases, s.cart);
	const rank = { 已付款: 0, 在购物车: 1, 不见了: 2 } as const;
	const lineOf = new Map<string, Line>();
	for (const l of lines) {
		const k = `${l.sn}:${l.modelId}`;
		const had = lineOf.get(k);
		if (!had || rank[l.state] < rank[had.state]) lineOf.set(k, l);
	}
	// 正在路上的加购（待批准……结果未知）：这些订单行不再准备
	const flying = new Set(s.writes.filter((w) => w.op === "加购" && IN_FLIGHT.has(w.status)).flatMap((w) => (w.params.lines as CartParams["lines"]).map((l) => `${l.sn}:${l.modelId}`)));
	const forecastFlying = new Set(s.writes.filter((w) => w.op === "预报" && IN_FLIGHT.has(w.status)).map((w) => w.params.sn as string));
	const viaX2 = new Set(s.writes.filter((w) => w.op === "加购").flatMap((w) => (w.params.lines as CartParams["lines"]).map((l) => l.sn)));

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
	const paySet = new Map<string, { lines: Line[]; due: Date | null }>();
	let needAddress = false;

	for (const o of s.orders) {
		const daysLeft = o.shipBy ? Math.round(((o.shipBy.getTime() - s.now.getTime()) / DAY) * 10) / 10 : null;
		if (isCancelled(o)) { checkCancelled(o); continue; }
		if (!isOpen(o)) {
			computed.set(o.sn, { daysLeft, sourced: true, carted: true, paid: true, arrived: true, destination: null, step: o.chanbossStatus || o.platformStatus });
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
		if (paid && ps.some((p) => p.toChanboss === null)) needAddress = true;
		const toChanboss = ps.map((p) => p.toChanboss === true);
		const destination = !paid ? null : toChanboss.every(Boolean) ? "寄到 chanboss" : toChanboss.some(Boolean) ? "两边都有" : "寄到我们这里";

		// 卡在哪一步
		let step: string;
		if (!needsBuy && !viaX2.has(o.sn)) step = `chanboss：${o.chanbossStatus}（不是经 x2 加购的）`;
		else if (!sourced) step = `没货源：${sources.filter((x) => x.src.state !== "有" && x.src.state !== "新").map((x) => label(x.i)).join("、")}`;
		else if (!carted) step = sources.some((x) => flying.has(`${o.sn}:${x.i.modelId}`)) ? "加购等批准" : "没加购";
		else if (!paid) step = "没付款";
		else if (needsBuy) step = forecastFlying.has(o.sn) ? "预报等批准" : "没预报";
		else if (destination === "寄到我们这里") {
			const missing = sources.filter((x) => !(x.line?.purchases ?? []).every((p) => p.signed)).map((x) => label(x.i));
			step = missing.length ? `货没到齐（还差 ${missing.join("、")}）` : "到齐了没打包";
		} else step = o.chanbossStatus === "已到齐" ? "等 chanboss 打包" : "等 chanboss 收货";
		computed.set(o.sn, { daysLeft, sourced, carted, paid, arrived, destination, step });

		// 选货源、找货源：只看还要买的订单
		if (needsBuy) for (const { i, src } of sources) {
			if (src.state === "没有" || src.state === "失效") toFind.set(i.modelId, { modelId: i.modelId, name: label(i), why: src.why ?? "没有货源" });
			if (src.state === "待选") {
				const had = toChoose.get(i.modelId);
				toChoose.set(i.modelId, { item: i, shop: o.shop, n: (had?.n ?? 0) + i.qty, due: had?.due && o.shipBy && had.due < o.shipBy ? had.due : o.shipBy });
			}
		}
		// 加购：还要买、货源齐了的订单，没加过（或加的不见了）、也没有在路上的
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
		if (destination === "寄到我们这里" && arrived && !needsBuy) inbox.push({
			key: `pack:${o.sn}`, kind: "打包", shop: o.shop, due: o.shipBy, link: CHANBOSS_ORDERS,
			title: `打包：订单 ${o.sn} 的货到齐了`,
			detail: `${o.items.map((i) => `${label(i)} × ${i.qty}`).join("\n")}\n按这张订单装好，在 chanboss 上打印 SKU 拣货单贴上，寄给 chanboss`,
		});
		// 快到期
		if (daysLeft !== null && daysLeft <= s.settings.lateDays) inbox.push({
			key: `late:${o.sn}`, kind: "快到期", shop: o.shop, due: o.shipBy, link: CHANBOSS_ORDERS,
			title: `快到期：${o.sn} 出货期限还剩 ${Math.max(0, Math.floor(daysLeft))} 天，还没打包（卡在：${step}）`, detail: o.items.map((i) => `${label(i)} × ${i.qty}`).join("\n"),
		});
		if (o.problem) inbox.push(problem(o));
	}

	function problem(o: Order): InboxItem {
		return { key: `problem:${o.sn}`, kind: "问题单", shop: o.shop, due: o.shipBy, link: CHANBOSS_ORDERS, title: `问题单：订单 ${o.sn} 在 chanboss 标了问题`, detail: o.problem ?? "" };
	}

	// 取消的订单：购物车里没有它的货；预报取消了；已经买了的货有去处（只看最近 14 天取消的）
	function checkCancelled(o: Order) {
		const mine = o.items.map((i) => ({ i, line: lineOf.get(`${o.sn}:${i.modelId}`) }));
		const inCart = mine.filter((x) => x.line?.state === "在购物车");
		const recent = o.cancelledAt && s.now.getTime() - o.cancelledAt.getTime() < 14 * DAY;
		const bought = recent ? mine.filter((x) => x.line?.state === "已付款") : [];
		const reported = o.chanbossStatus === "已预报" || o.chanbossStatus === "已到齐";
		const todoLines = [
			...inCart.map((x) => `${label(x.i)} × ${x.line!.cartQty} 在 1688 购物车里：删掉`),
			...(reported ? [`chanboss 上是「${o.chanbossStatus}」：取消预报${o.chanbossStatus === "已到齐" ? "，到了的货定去处" : ""}`] : []),
			...bought.map((x) => `${label(x.i)} × ${x.line!.paidQty} 已经买了：定去处（留着下次用、退货）`),
		];
		if (todoLines.length) inbox.push({
			key: `cancel:${o.sn}`, kind: "取消", shop: o.shop, due: null, link: inCart.length ? CART_URL : CHANBOSS_ORDERS,
			title: `取消：订单 ${o.sn} 取消了，${[
				inCart.length ? `${inCart.reduce((n, x) => n + x.line!.cartQty, 0)} 件在购物车里要删` : "",
				reported ? "chanboss 上要取消预报" : "",
				bought.length ? "买了的货要定去处" : "",
			].filter(Boolean).join("，")}`,
			detail: todoLines.join("\n"),
		});
		computed.set(o.sn, { daysLeft: null, sourced: false, carted: mine.some((x) => x.line), paid: false, arrived: false, destination: null, step: "取消了" });
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
		const why = !o ? "订单不在库里" : isCancelled(o) ? `不该买：订单 ${o.sn} 取消了` : isPacked(o) ? `不该买：订单 ${o.sn} 已经打包了` : "该买";
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
			title: `付款：1688 购物车里 ${sns.size} 张订单的货${Number.isNaN(total) ? "" : ` ¥${total.toFixed(2)}`}（账号 ${account}）`,
			detail: [
				...p.lines.map((l) => `${offerName(l).name} × ${l.cartQty}（订单 ${l.sn}）`),
				...(not.length ? ["", "付款前先删掉这些（不该买）：", ...not.map(([k, r]) => `${k.split("|").slice(1).join(" / ")}：${r.shouldBuy}`)] : []),
				"", "付完在 agent 里说「我付好了」",
			].join("\n"),
		});
	}
	if (needAddress && !s.settings.chanbossAddress) inbox.push({
		key: "setting:chanboss_address", kind: "设置", shop: null, due: null, link: null,
		title: "设置：在「订单设置」里填 chanboss 的收货地址", detail: "x2 用它认出哪些采购单是寄到 chanboss 的；没填时都当成寄到我们这里",
	});

	// ── agent 要做的 ──
	if (toFind.size) todo.push({ kind: "找货源", why: `${toFind.size} 个规格没有货源或货源失效`, models: [...toFind.values()], command: `x2 source ${[...toFind.keys()].join(" ")}` });
	if (cartPlan.size) {
		const plan = [...cartPlan.values()];
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
	const unknown = s.writes.filter((w) => w.status === "结果未知" || w.status === "已提交");
	if (unknown.length) todo.push({ kind: "核清", why: `${unknown.length} 个写入结果未知：先读回来`, writes: unknown.map((w) => w.id), command: "x2 run" });

	return { inbox, orders: computed, cart: new Map([...cartRows].map(([k, r]) => [k, { orders: r.orders.join("、"), shouldBuy: r.shouldBuy }])), todo, chosenSources: [...chosenSources.values()] };
}
