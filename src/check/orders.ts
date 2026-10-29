// 检查订单：拿 docs/orders.md「每一步怎样算做完」和「异常」对一遍库，算出要提醒人的、agent 要做的，和订单上「当前步骤」等列。
// 纯函数：输入是从库里读出来的一份快照，输出要写回库的东西；读写库在 index.ts
import { exceptionFor, matchSku, rank as nearest } from "../similar.ts";
import { type CartLine, type CartWrite, type Line, type Need, type Purchase, reconcile } from "./reconcile.ts";

export type Item = { itemId: string; modelId: string; chanbossModelId: string; name: string; spec: string; qty: number; image: string };
export type Order = {
	sn: string;
	shop: string | null;
	createdAt: Date | null;
	shipBy: Date | null;
	platformStatus: string;
	chanbossStatus: string;
	chanbossId: string;
	chanbossTime: number;
	items: Item[];
	problem: string | null;
	cancelledAt: Date | null;
};
/** 货源的一个规格（快照里的） */
export type SourceSku = { skuId: string; specId: string; name: string; price: number; stock: number; image: string };
/** 货源（sources 表的一行）：店里一个商品 × 一个货源。chosen 的是这个商品现在的货源（一个商品只用一个）；没 chosen 的是还在挑的，sure 是 x2 认为明显匹配的。
 * title、skus 是快照（x2 现读这个货源时更新）：店里的规格按名字在 skus 里配；配不上的看 exceptions（规格例外，人定的） */
export type Source = {
	itemId: string;
	offerId: string;
	title: string | null;
	skus: SourceSku[];
	chosen: boolean;
	sure: boolean;
	broken: string | null;
	exceptions?: string | null;
};
export type Write = { id: string; batch: string; op: string; status: string; params: any; finishedAt: Date | null; error?: string | null };
/** 到货问题：人在网页的表单里上报的、未处理的（错货、少件、损坏……） */
export type Issue = { id: string; sn: string; item: string | null; kind: string; qty: number | null; note: string | null; resolution: string | null };
/** buyAccount：采购账号（1688 userId），x2 只往它加购 */
/** shipWaitHours：1688 付了款多久还没发货算异常 */
export type Settings = { lateDays: number; channel: string; buyAccount: string | null; shipWaitHours?: number };

export type Snapshot = {
	now: Date;
	settings: Settings;
	orders: Order[];
	sources: Source[];
	writes: Write[];
	purchases: Purchase[];
	cart: CartLine[];
	issues: Issue[];
	/** 1688 账号：userId → 会员名 */
	accounts: Map<string, string>;
};

/** 提醒人做的一件事。key 是「类别:对象」：x2 看不到结果的，人做完用 x2 handled <key> 记下，不再提醒 */
export type Reminder = { key: string; kind: string; title: string; detail: string; shop: string | null; due: Date | null; link: string | null };
/** step：当前步骤（下面 STEPS 里的一个，网页上订单按它分组）；stepDetail：说明（哪件未到、哪个规格缺货源……） */
export type Computed = { daysLeft: number | null; destination: string | null; step: string; stepDetail: string | null };
/** 加购这个写操作的参数：同一个货源规格的几张订单合成一行。newSources：随这次加购一起定下的新货源（店里的商品 id） */
export type CartParams = {
	offerId: string;
	skuId: string;
	qty: number;
	title: string;
	sku: string;
	price: number | null;
	lines: { sn: string; modelId: string; qty: number }[];
	newSources: string[];
	account?: string;
};
/** 一批写入：x2 do 从 stdin 读的 JSON */
export type Batch = { title: string; writes: { op: string; params: unknown }[] };
export type ForecastParams = {
	sn: string;
	chanbossId: string;
	chanbossTime: number;
	lines: { modelId: string; chanbossModelId: string; qty: number; trackingNo: string | null }[];
};
export type Todo =
	| { kind: "找货源"; why: string; items: { itemId: string; name: string; why: string }[]; command: string }
	// batch：现成的一批写入，给人看过、人同意了交给 x2 do
	| { kind: "加购" | "预报"; why: string; batch: Batch }
	| { kind: "取消预报"; why: string; orders: string[] }
	| { kind: "核清"; why: string; writes: string[]; command: string }
	// 上品（docs/listing.md）：做商品稿、写文案、Gemini 文字检查是 agent 跑命令；备注：照人写的备注做
	| { kind: "做商品稿" | "写文案" | "Gemini 文字检查"; why: string; ids: string[]; command: string }
	| { kind: "估重量、国内运费"; why: string; items: EstimateItem[]; command: string }
	| { kind: "备注"; why: string; items: { id: string; name: string; note: string }[]; command: string };

/** agent 估重量、国内运费的一份商品稿：缺什么（needs），和估要用的事实（1688 的标题、每个规格、运费） */
export type EstimateItem = {
	id: string;
	name: string;
	shop: string;
	needs: ("重量" | "国内运费")[];
	title: string;
	specs: { spec: string; priceRmb: number; weightKg: number | null }[];
	freight: unknown;
	freeShipping: boolean;
};

/** covered：已经买了或者在购物车里的订单行（订单号:规格 id），不管是不是经 x2 加购的 */
export type Result = {
	reminders: Reminder[];
	orders: Map<string, Computed>;
	cart: Map<string, { orders: string; shouldBuy: string }>;
	todo: Todo[];
	covered: Set<string>;
};

/** 当前步骤：按流程排（网页上订单按它分组，组也是这个顺序） */
export const STEPS = [
	"缺货源",
	"规格不匹配",
	"待加购",
	"待 1688 付款",
	"待预报",
	"待到齐",
	"有到货问题",
	"待打包",
	"待 chanboss 收货",
	"待 chanboss 打包",
	"外部采购",
	"已打包",
	"已取消",
] as const;

/** 写入还没有结果、或结果要人看：同一个对象不再准备新的 */
const IN_FLIGHT = new Set(["待执行", "已提交", "结果未知", "不一致"]);
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
export const isPacked = (o: Order) =>
	o.chanbossStatus === "已打包" || o.chanbossStatus === "已出库" || ["已出货", "已完成", "退货退款"].includes(o.platformStatus);
export const isOpen = (o: Order) => o.platformStatus === "待出货" && !isPacked(o);

export function checkOrders(s: Snapshot): Result {
	const reminders: Reminder[] = [];
	const todo: Todo[] = [];
	const computed = new Map<string, Computed>();
	const who = (account: string) => s.accounts.get(account) ?? account;
	/** 店里的商品 → 选用的货源 */
	const chosenOf = new Map(s.sources.filter((x) => x.chosen).map((x) => [x.itemId, x]));
	/** 货源 → 快照（给人看名字、价格） */
	const offerOf = new Map(s.sources.map((x) => [x.offerId, x]));

	// ── 加购记录、采购单 → 采购单分给订单 ──
	const cartWrites: CartWrite[] = s.writes
		.filter((w) => w.op === "加购" && DONE.has(w.status) && w.params.account)
		.map((w) => ({ id: w.id, account: w.params.account, offerId: w.params.offerId, skuId: w.params.skuId, at: w.finishedAt ?? s.now, lines: w.params.lines }));
	// 每个订单行（有货源的）都拿去对剩下的采购单：外部采购的也认得出来；x2 加了购、人又另外买了，也认得出来
	const needs: Need[] = s.orders.flatMap((o) =>
		o.items.flatMap((i) => {
			const src = chosenOf.get(i.itemId);
			const sku = src ? matchSku(i.spec, src.skus, src.exceptions) : null;
			return src && sku && o.createdAt
				? [{ sn: o.sn, modelId: i.modelId, qty: i.qty, offerId: src.offerId, skuId: sku.skuId, createdAt: o.createdAt, until: o.cancelledAt }]
				: [];
		}),
	);
	const lines = reconcile(cartWrites, s.purchases, s.cart, needs);
	const rank = { 已付款: 0, 在购物车: 1, 不见了: 2 } as const;
	const lineOf = new Map<string, Line>();
	for (const l of lines) {
		const k = `${l.sn}:${l.modelId}`;
		const had = lineOf.get(k);
		if (!had || rank[l.state] < rank[had.state]) lineOf.set(k, l);
	}
	/** 外部采购（采购单对上了，不是经 x2 加购的） */
	const boughtOutside = new Set(lines.filter((l) => l.outside).map((l) => `${l.sn}:${l.modelId}`));
	// 正在路上的加购（还没核清的）：这些订单行不再准备
	const flying = new Set(
		s.writes
			.filter((w) => w.op === "加购" && IN_FLIGHT.has(w.status))
			.flatMap((w) => (w.params.lines as CartParams["lines"]).map((l) => `${l.sn}:${l.modelId}`)),
	);
	const forecastFlying = new Set(s.writes.filter((w) => w.op === "预报" && IN_FLIGHT.has(w.status)).map((w) => w.params.sn as string));

	// ── 货源 ──
	// 一个商品一个货源；店里的规格按名字在货源的规格里配，配不上的看人定的规格例外（都没有：规格不匹配，要人看）
	type SourceState = { state: "有" | "新" | "待选" | "没有" | "失效" | "规格不匹配"; src?: Source; sku?: SourceSku; why?: string };
	const sourceOf = (i: Item): SourceState => {
		const pick = (src: Source, state: "有" | "新"): SourceState => {
			const sku = matchSku(i.spec, src.skus, src.exceptions);
			if (sku) return { state, src, sku };
			const named = exceptionFor(i.spec, src.exceptions);
			const where = `货源「${short(src.title ?? src.offerId)}」`;
			return {
				state: "规格不匹配",
				src,
				why:
					named === undefined ? `「${i.spec || "（单规格）"}」在${where}里无匹配的规格` : `规格例外中的「${named}」在${where}里已不存在（货源可能改了规格名）`,
			};
		};
		const chosen = chosenOf.get(i.itemId);
		if (chosen) return chosen.broken ? { state: "失效", why: chosen.broken } : pick(chosen, "有");
		const opts = s.sources.filter((x) => x.itemId === i.itemId);
		const sure = opts.filter((x) => x.sure);
		if (sure.length === 1) return pick(sure[0]!, "新");
		return opts.length ? { state: "待选" } : { state: "没有" };
	};

	const toFind = new Map<string, { itemId: string; name: string; why: string }>();
	const toChoose = new Map<string, { item: Item; due: Date | null; shop: string | null }>();
	const unmatched = new Map<string, { item: Item; src: Source; why: string; due: Date | null; shop: string | null }>();
	const cartPlan = new Map<string, CartParams>();
	const forecasts: ForecastParams[] = [];
	const unforecast: string[] = [];
	const paySet = new Map<string, { lines: Line[]; due: Date | null }>();

	for (const o of s.orders) {
		const daysLeft = o.shipBy ? Math.round(((o.shipBy.getTime() - s.now.getTime()) / DAY) * 10) / 10 : null;
		if (isCancelled(o)) {
			checkCancelled(o);
			continue;
		}
		if (!isOpen(o)) {
			computed.set(o.sn, { daysLeft, destination: null, step: isPacked(o) ? "已打包" : o.platformStatus, stepDetail: o.chanbossStatus || null });
			if (o.problem && !isPacked(o)) reminders.push(problem(o));
			continue;
		}
		const sources = o.items.map((i) => ({ i, src: sourceOf(i), line: lineOf.get(`${o.sn}:${i.modelId}`) }));
		const needsBuy = o.chanbossStatus === "待处理";
		const sourced = sources.every((x) => x.src.state === "有" || x.src.state === "新");
		const carted = sources.every((x) => x.line && x.line.state !== "不见了");
		const paid = sources.every((x) => x.line?.state === "已付款");
		const ps = sources.flatMap((x) => x.line?.purchases ?? []);
		const arrived = paid && ps.every((p) => p.signed);
		// 收货地址：采购单列表里没有这一项（2026-10-09），都寄到 1688 的默认地址，当成寄到我们这里；认得出寄到 chanboss 的（toChanboss）才算寄到 chanboss
		const toChanboss = ps.map((p) => p.toChanboss === true);
		const destination = !paid ? null : toChanboss.every(Boolean) ? "寄到 chanboss" : toChanboss.some(Boolean) ? "两边都有" : "寄到我们这里";

		// 当前步骤
		let step: (typeof STEPS)[number];
		let stepDetail: string | null = null;
		if (!needsBuy && !paid) {
			step = "外部采购";
			stepDetail = `chanboss：${o.chanbossStatus}；采购单未匹配（规格缺货源，或在其他账号购买）`;
		} else if (!sourced) {
			const bad = sources.filter((x) => x.src.state !== "有" && x.src.state !== "新");
			step = bad.every((x) => x.src.state === "规格不匹配") ? "规格不匹配" : "缺货源";
			stepDetail = bad.map((x) => label(x.i)).join("、");
		} else if (!carted && !paid) {
			step = "待加购";
			if (sources.some((x) => flying.has(`${o.sn}:${x.i.modelId}`))) stepDetail = "加购的结果还没核清";
		} else if (!paid) step = "待 1688 付款";
		else if (needsBuy) {
			step = "待预报";
			if (forecastFlying.has(o.sn)) stepDetail = "预报的结果还没核清";
		} else if (destination === "寄到我们这里") {
			const missing = sources.filter((x) => !(x.line?.purchases ?? []).every((p) => p.signed)).map((x) => label(x.i));
			step = missing.length ? "待到齐" : "待打包";
			if (missing.length) stepDetail = `未到：${missing.join("、")}`;
		} else step = o.chanbossStatus === "已到齐" ? "待 chanboss 打包" : "待 chanboss 收货";
		// 有到货问题（人上报的）：处理完之前不提醒打包
		const issues = s.issues.filter((x) => x.sn === o.sn);
		if (issues.length && (step === "待到齐" || step === "待打包")) {
			step = "有到货问题";
			stepDetail = issues.map(issueText).join("；");
		}
		if (sources.some((x) => boughtOutside.has(`${o.sn}:${x.i.modelId}`))) stepDetail = [stepDetail, "外部采购"].filter(Boolean).join("；");
		computed.set(o.sn, { daysLeft, destination, step, stepDetail });

		// 选货源、找货源：只看还要买、还没买的订单行
		if (needsBuy)
			for (const { i, src, line } of sources) {
				if (line?.state === "已付款") continue;
				const due = (had: { due: Date | null } | undefined) => (had?.due && o.shipBy && had.due < o.shipBy ? had.due : o.shipBy);
				if (src.state === "没有" || src.state === "失效") toFind.set(i.itemId, { itemId: i.itemId, name: short(i.name, 20), why: src.why ?? "缺货源" });
				if (src.state === "待选") toChoose.set(i.itemId, { item: i, shop: o.shop, due: due(toChoose.get(i.itemId)) });
				if (src.state === "规格不匹配") unmatched.set(i.modelId, { item: i, src: src.src!, why: src.why!, shop: o.shop, due: due(unmatched.get(i.modelId)) });
			}
		// 加购：还要买、货源齐了的订单，没加过（或加的不见了）、不是外部采购、也没有在路上的
		if (needsBuy && sourced)
			for (const { i, src, line } of sources) {
				if ((line && line.state !== "不见了") || flying.has(`${o.sn}:${i.modelId}`)) continue;
				const x = src.src!,
					sku = src.sku!;
				const k = `${x.offerId}:${sku.skuId}`;
				const c = cartPlan.get(k) ?? {
					offerId: x.offerId,
					skuId: sku.skuId,
					qty: 0,
					title: x.title ?? x.offerId,
					sku: sku.name || "（单规格）",
					price: sku.price,
					lines: [],
					newSources: [],
				};
				c.qty += i.qty;
				c.lines.push({ sn: o.sn, modelId: i.modelId, qty: i.qty });
				if (src.state === "新" && !c.newSources.includes(i.itemId)) c.newSources.push(i.itemId);
				cartPlan.set(k, c);
			}
		// 付款：加购了还在购物车里的
		for (const { line } of sources)
			if (line?.state === "在购物车") {
				const p = paySet.get(line.account) ?? { lines: [], due: null };
				p.lines.push(line);
				if (o.shipBy && (!p.due || o.shipBy < p.due)) p.due = o.shipBy;
				paySet.set(line.account, p);
			}
		// 预报：付了款还没报的。寄到我们这里报无单号；寄到 chanboss 的要每件都有快递单号
		if (needsBuy && paid && !forecastFlying.has(o.sn) && destination !== "两边都有") {
			const byChanboss = destination === "寄到 chanboss";
			const ready = !byChanboss || sources.every((x) => (x.line?.purchases ?? []).every((p) => p.trackingNo));
			if (ready)
				forecasts.push({
					sn: o.sn,
					chanbossId: o.chanbossId,
					chanbossTime: o.chanbossTime,
					lines: sources.map(({ i, line }) => ({
						modelId: i.modelId,
						chanbossModelId: i.chanbossModelId,
						qty: i.qty,
						trackingNo: byChanboss ? (line!.purchases[0]?.trackingNo ?? null) : null,
					})),
				});
		}
		// 打包：寄到我们这里、到齐了、报过了
		if (destination === "寄到我们这里" && arrived && !needsBuy && !issues.length)
			reminders.push({
				key: `pack:${o.sn}`,
				kind: "打包",
				shop: o.shop,
				due: o.shipBy,
				link: CHANBOSS_ORDERS,
				title: `打包：订单 ${o.sn} 的货已到齐`,
				detail: `${o.items.map((i) => `${label(i)} × ${i.qty}`).join("\n")}\n按这张订单装箱，在 chanboss 上打印 SKU 拣货单贴上，寄给 chanboss`,
			});
		// 快到期：离出货期限不到 N 天还没打包，直接给人
		if (daysLeft !== null && daysLeft < s.settings.lateDays)
			reminders.push({
				key: `late:${o.sn}`,
				kind: "快到期",
				shop: o.shop,
				due: o.shipBy,
				link: CHANBOSS_ORDERS,
				title: `快到期：订单 ${o.sn} 出货期限剩余 ${Math.max(0, Math.floor(daysLeft))} 天，未打包（当前步骤：${step}${stepDetail ? `，${stepDetail}` : ""}）`,
				detail: o.items.map((i) => `${label(i)} × ${i.qty}`).join("\n"),
			});
		if (o.problem) reminders.push(problem(o));
	}

	// 到货问题：一个问题一行，人在「到货问题」里勾「已处理」就不再提醒
	for (const x of s.issues) {
		const o = s.orders.find((y) => y.sn === x.sn);
		reminders.push({
			key: `issue:${x.id}`,
			kind: "到货问题",
			shop: o?.shop ?? null,
			due: o?.shipBy ?? null,
			link: null,
			title: `到货问题：订单 ${x.sn} ${issueText(x)}`,
			detail: [
				...(o ? [] : ["库里无此订单：请核对订单号"]),
				...(x.note ? [x.note] : []),
				`处理方式：${x.resolution ?? "未定（退换、重新采购、无需处理）"}`,
				"处理完在「到货问题」里勾「已处理」",
			].join("\n"),
		});
	}

	function problem(o: Order): Reminder {
		return {
			key: `problem:${o.sn}`,
			kind: "问题单",
			shop: o.shop,
			due: o.shipBy,
			link: CHANBOSS_ORDERS,
			title: `问题单：订单 ${o.sn} 被 chanboss 标记问题`,
			detail: o.problem ?? "",
		};
	}

	// 买家取消：看货走到了哪（docs/orders.md「买家取消」）。
	// 购物车里的：删掉（x2 看得到删没删）。货的去处（退款、退回卖家、合并给新订单、台湾仓）：x2 看不到结果，人做完 x2 handled 记下。
	// chanboss 上的预报：不重要了，agent 去取消
	function checkCancelled(o: Order) {
		const mine = o.items.map((i) => ({ i, line: lineOf.get(`${o.sn}:${i.modelId}`) }));
		computed.set(o.sn, { daysLeft: null, destination: null, step: "已取消", stepDetail: o.chanbossStatus || null });
		const inCart = lines.filter((l) => l.sn === o.sn && l.cartQty > 0);
		if (inCart.length)
			reminders.push({
				key: `cancel:${o.sn}`,
				kind: "取消",
				shop: o.shop,
				due: null,
				link: CART_URL,
				title: `取消：订单 ${o.sn} 已取消，购物车里还有 ${inCart.reduce((n, l) => n + l.cartQty, 0)} 件待删除`,
				detail: inCart.map((l) => `${label(o.items.find((i) => i.modelId === l.modelId)!)} × ${l.cartQty}（账号 ${who(l.account)}）`).join("\n"),
			});
		if (o.chanbossStatus === "已预报") unforecast.push(o.sn);
		// 货的去处：where 货在哪，what 怎么办
		let where: string | null = null;
		let what = "";
		let due: Date | null = null;
		const bought = mine.filter((x) => x.line?.state === "已付款");
		if (isPacked(o)) {
			where = "货已到台湾";
			what = "在 chanboss 台湾仓上架，30 天内给别的订单用（超过 30 天由货代处理）";
			// 30 天从上架算；还读不到上架时间，先按取消的时间算。过了期限货就没了：这件事也就结束了，不再提醒
			due = o.cancelledAt ? new Date(o.cancelledAt.getTime() + 30 * DAY) : null;
			if (due && due < s.now) where = null;
		} else if (o.chanbossStatus === "已到齐") {
			where = "货在 chanboss 仓库";
			what = "给新订单用（合并发货），或者退回卖家";
		} else if (bought.length) {
			// 退款：进行中的写出走到哪一步（x2 看得到，退成了就不再提醒）；关闭了是没退成，要人再处理
			const refunds = bought.flatMap((x) => x.line!.purchases.map((p) => p.refund)).filter((r): r is NonNullable<typeof r> => Boolean(r));
			const closedRefund = refunds.find((r) => r.status === "refundclose");
			const going = refunds.find((r) => r.status !== "refundclose" && r.status !== "refundsuccess");
			const shipped = bought.some((x) => x.line!.purchases.some((p) => p.status !== "waitsellersend"));
			if (going && !closedRefund) {
				where = `${going.kind ?? "退款"}进行中`;
				what = going.label || "退款中";
			} else if (closedRefund) {
				where = "退款已关闭（未退成）";
				what = "重新申请，或者定去处";
			} else {
				where = shipped ? "1688 已发货" : "已付款，1688 未发货";
				what = shipped ? "退回 1688 卖家" : "在 1688 申请退款";
			}
		}
		if (where)
			reminders.push({
				key: `cancel-goods:${o.sn}`,
				kind: "取消",
				shop: o.shop,
				due,
				link: isPacked(o) || o.chanbossStatus === "已到齐" ? CHANBOSS_ORDERS : BUYER_ORDERS,
				title: `取消：订单 ${o.sn} 已取消，${where}，${what}`,
				detail: [
					...o.items.map((i) => `${label(i)} × ${i.qty}`),
					...bought.map(
						(x) =>
							`采购单 ${x.line!.purchases.map((p) => `${p.orderId}${p.refund ? `（${p.refund.kind ?? "退款"}：${p.refund.label}）` : ""}`).join("、")}：${label(x.i)} × ${x.line!.paidQty}${x.line!.outside ? "（外部采购）" : ""}`,
					),
					"",
					bought.length ? "x2 读得到退款、退货的进度：退款成功后不再提醒" : `处理完告诉 agent（x2 handled cancel-goods:${o.sn}）`,
				].join("\n"),
			});
	}

	// ── 提醒：选货源、付款 ──
	for (const [itemId, c] of toChoose)
		reminders.push({
			key: `source:${itemId}`,
			kind: "选货源",
			shop: c.shop,
			due: c.due,
			link: null,
			title: `选货源：${short(c.item.name, 20)} 待人工选定`,
			detail: `找到的货源在「货源」里（按店里的商品分组），勾选一个「选用」`,
		});
	// 规格不匹配：人定哪个配哪个，写进货源那一行的「规格例外」（照抄第一个最像的，不对就改）；或者换货源
	for (const [modelId, c] of unmatched) {
		const near = nearest(c.item.spec, c.src.skus)
			.slice(0, 5)
			.map((k) => k.name);
		reminders.push({
			key: `sku:${modelId}`,
			kind: "规格不匹配",
			shop: c.shop,
			due: c.due,
			link: null,
			title: `规格不匹配：${label(c.item)}`,
			detail: [
				`${c.why}。`,
				"在「货源」里这个商品那一行的「规格例外」加一行（照抄下面这行；不对就换成正确的规格名）：",
				`${c.item.spec || "（单规格）"} = ${near[0] ?? "货源的规格名"}`,
				...(near.length ? ["", "货源里最相近的规格：", ...near.map((n) => `· ${n}`)] : []),
				"",
				"也可以在终端里告诉 agent 哪个配哪个；或者换货源",
			].join("\n"),
		});
	}
	const offerName = (l: Line) => {
		const x = offerOf.get(l.offerId);
		const sku = x?.skus.find((k) => k.skuId === l.skuId);
		return { name: `${short(x?.title ?? l.offerId)} / ${sku?.name || "（单规格）"}`, price: sku?.price ?? null };
	};
	const cartRows = new Map<string, { orders: string[]; shouldBuy: string }>();
	for (const l of lines)
		if (l.cartQty > 0) {
			const k = `${l.account}|${l.offerId}|${l.skuId}`;
			const o = s.orders.find((x) => x.sn === l.sn);
			const why = !o
				? "订单不在库里"
				: isCancelled(o)
					? `不该买：订单 ${o.sn} 已取消`
					: isPacked(o)
						? `不该买：订单 ${o.sn} 已打包`
						: boughtOutside.has(`${l.sn}:${l.modelId}`)
							? `不该买：订单 ${o.sn} 已有外部采购`
							: "该买";
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
		reminders.push({
			key: `pay:${account}`,
			kind: "付款",
			shop: null,
			due: p.due,
			link: CART_URL,
			title: `付款：1688 账号「${who(account)}」的购物车里 ${sns.size} 张订单的货${Number.isNaN(total) ? "" : ` ¥${total.toFixed(2)}`}`,
			detail: [
				...p.lines.map((l) => `${offerName(l).name} × ${l.cartQty}（订单 ${l.sn}）`),
				...(not.length ? ["", "付款前先删除这些（不该买）：", ...not.map(([k, r]) => `${k.split("|").slice(1).join(" / ")}：${r.shouldBuy}`)] : []),
				"",
				"付完在 agent 里说「我付好了」",
			].join("\n"),
		});
	}

	// ── 1688 付了款，过了 N 小时还没发货：给人催（最近 30 天付款的；退款了、关了的不算） ──
	const waitMs = (s.settings.shipWaitHours ?? 48) * 3600_000;
	const late = new Map<string, Purchase[]>();
	for (const p of s.purchases) {
		if (p.status !== "waitsellersend" || p.refund || !p.paidAt) continue;
		const age = s.now.getTime() - p.paidAt.getTime();
		if (age < waitMs || age > 30 * DAY) continue;
		late.set(p.orderId, [...(late.get(p.orderId) ?? []), p]);
	}
	for (const [orderId, ps] of late) {
		const sns = [...new Set(lines.filter((l) => l.purchases.some((b) => b.orderId === orderId)).map((l) => l.sn))];
		const hours = Math.floor((s.now.getTime() - ps[0]!.paidAt!.getTime()) / 3600_000);
		const due =
			sns
				.map((sn) => s.orders.find((o) => o.sn === sn)?.shipBy)
				.filter((d): d is Date => Boolean(d))
				.sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
		reminders.push({
			key: `unshipped:${orderId}`,
			kind: "未发货",
			shop: null,
			due,
			link: BUYER_ORDERS,
			title: `未发货：1688 采购单 ${orderId} 付款已 ${hours} 小时仍未发货${sns.length ? `（订单 ${sns.join("、")}）` : ""}`,
			detail: `${ps.map((p) => `${p.offerId} / ${p.offerSkuId ?? ""} × ${p.qty}`).join("\n")}\n找卖家催发货；催不动就退款换一家（x2 会重新准备加购）`,
		});
	}

	// ── agent 要做的 ──
	if (toFind.size)
		todo.push({
			kind: "找货源",
			why: `${toFind.size} 个商品缺货源或货源不可用`,
			items: [...toFind.values()],
			command: `x2 source ${[...toFind.keys()].join(" ")}`,
		});
	if (cartPlan.size) {
		const plan = [...cartPlan.values()].map((c) => (s.settings.buyAccount ? { ...c, account: s.settings.buyAccount } : c));
		const sns = new Set(plan.flatMap((c) => c.lines.map((l) => l.sn)));
		todo.push({
			kind: "加购",
			why: `${sns.size} 张订单货源齐了，待加购`,
			batch: {
				title: `加购：${plan.map((c) => `${short(c.title, 10)} / ${c.sku} × ${c.qty}`).join("；")}（订单 ${[...sns].join("、")}）`,
				writes: plan.map((params) => ({ op: "加购", params })),
			},
		});
	}
	if (forecasts.length)
		todo.push({
			kind: "预报",
			why: `${forecasts.length} 张订单已付款，待预报`,
			batch: {
				title: `预报 ${forecasts.length} 张订单（${s.settings.channel}、${forecasts.every((f) => f.lines.every((l) => !l.trackingNo)) ? "无单号" : "带快递单号"}）：${forecasts.map((f) => f.sn).join("、")}`,
				writes: forecasts.map((params) => ({ op: "预报", params })),
			},
		});
	if (unforecast.length)
		todo.push({ kind: "取消预报", why: `${unforecast.length} 张取消的订单在 chanboss 上还是已预报（不重要；x2 还不会取消预报，先不管）`, orders: unforecast });
	const unknown = s.writes.filter((w) => w.status === "结果未知" || w.status === "已提交");
	if (unknown.length) todo.push({ kind: "核清", why: `${unknown.length} 个写入结果未知：先读回来`, writes: unknown.map((w) => w.id), command: "x2 verify" });

	return {
		reminders,
		orders: computed,
		cart: new Map([...cartRows].map(([k, r]) => [k, { orders: r.orders.join("、"), shouldBuy: r.shouldBuy }])),
		todo,
		covered: new Set([...lineOf.values()].filter((l) => l.state !== "不见了").map((l) => `${l.sn}:${l.modelId}`)),
	};
}

/** 检查现在认为该做的：加购的订单行（订单号:规格 id）、该预报的订单号。x2 do 只收这些；加购前现读一遍再对一次 */
export function planned(r: Result): { cart: Set<string>; forecast: Set<string> } {
	const cart = new Set<string>(),
		forecast = new Set<string>();
	for (const t of r.todo) {
		if (t.kind === "加购") for (const w of t.batch.writes) for (const l of (w.params as CartParams).lines) cart.add(`${l.sn}:${l.modelId}`);
		if (t.kind === "预报") for (const w of t.batch.writes) forecast.add((w.params as ForecastParams).sn);
	}
	return { cart, forecast };
}
