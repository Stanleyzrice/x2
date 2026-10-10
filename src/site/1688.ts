// 1688：货源详情、购物车、加购。货源详情是服务端渲染进页面的全局变量（window.context.result.global.globalData.model），打开商品页读它，不用签名。
// 查过的事实（2026-09-30）：tradeModel.skuMap 是规格（specAttrs 用「&gt;」连接几个属性，例「kitty猫款式5&gt;20*30cm【硅藻泥】3mm」）；
// offerDetail.skuProps 是属性（prop，例「颜色」「尺寸」）和它的取值（value: {name, imageUrl}），第一个属性的取值带图片；只有一个规格的货源没有 skuMap
import { z } from "zod";
import { page } from "../browser.ts";
import { NeedsHuman, Usage } from "../errors.ts";
import { all, byPage, get, type Ops, str, strs } from "./op.ts";

/** attrs：每个属性的取值，顺序同 Offer.props */
export type Sku = { skuId: string; specId: string; name: string; attrs: string[]; price: number; stock: number; image: string; weightKg?: number | null };
export type Prop = { name: string; values: { name: string; image: string }[] };
export type Offer = { offerId: string; url: string; title: string; image: string; unit: string; minQty: number; props: Prop[]; skus: Sku[] };

/** 1688 链接或货源 id → 货源 id（纯数字）；认不出是 null */
export function offerIdOf(linkOrId: string): string | null {
	const m = /offer\/(\d+)\.html/.exec(linkOrId) ?? /^(\d+)$/.exec(linkOrId.trim());
	return m ? m[1]! : null;
}

/** 货源下架了或不存在：采购单上算货源失效。要登录、要过滑块是别的错，要人处理 */
export class Gone extends Error {}

export async function offer(offerId: string): Promise<Offer> {
	const url = `https://detail.1688.com/offer/${offerId}.html`;
	const p = await page("https://detail.1688.com");
	await p.goto(url);
	const got = await p.run((url: string) => {
		const m = (window as any).context?.result?.global?.globalData?.model;
		if (!m?.tradeModel) return location.href.includes("login") || location.href.includes("punish") ? { error: "1688 要登录或要过滑块：在浏览器里处理一下" } : { gone: true as const };
		const t = m.tradeModel, d = m.offerDetail;
		const unescape = (s: string) => s.replace(/&gt;/g, ">").replace(/&amp;/g, "&");
		const hasSkus = (t.skuMap ?? []).length > 0;
		const props = hasSkus
			? ((d.skuProps ?? []) as { prop?: string; value?: { name: string; imageUrl?: string }[] }[])
				.map((p) => ({ name: p.prop ?? "", values: (p.value ?? []).map((v) => ({ name: unescape(v.name), image: v.imageUrl ?? "" })) }))
			: [];
		// 第一个属性的取值 → 图片
		const images = new Map<string, string>((props[0]?.values ?? []).map((v) => [v.name, v.image]));
		const skus = hasSkus
			? (t.skuMap as any[]).map((s) => {
				const attrs = unescape(s.specAttrs ?? "").split(">");
				return { skuId: String(s.skuId), specId: s.specId ?? "", name: attrs.join(" / "), attrs, price: Number(s.price || s.discountPrice || t.minPrice), stock: Number(s.canBookCount ?? 0), image: images.get(attrs[0]!) ?? "" };
			})
			: [{ skuId: String(t.offerId), specId: "", name: "", attrs: [], price: Number(t.minPrice), stock: Number(t.canBookedAmount ?? 0), image: d.mainImageList?.[0]?.fullPathImageURI ?? "" }];
		return { offerId: String(t.offerId), url, title: d.subject, image: d.mainImageList?.[0]?.fullPathImageURI ?? "", unit: t.unit ?? "", minQty: Number(t.beginAmount ?? 1), props, skus };
	}, url);
	if ("error" in got) throw new NeedsHuman(`读 1688 货源 ${offerId}：${got.error}`);
	if ("gone" in got) throw new Gone(`1688 货源 ${offerId} 不存在或已下架`);
	return got;
}

// ── mtop ──
// 购物车、加购、采购单、物流都在页面里用页面自己的 lib.mtop.request 发（签名由它算）。依据 lilto 的 packages/presets/src/1688.ts（2026-09-24 读的 mtop.js 源码）：
// 站点回 SUCCESS 时 resolve；站点回别的 ret 时 reject 整个响应（带 api）；库自己超时、解析失败时 reject 的对象没有 api，这时请求可能已经到了站点

/** ok：站点回 SUCCESS；site：站点回了别的 ret（确定是站点的答复）；unknown：没有站点的答复（超时、解析失败），请求可能已经到了站点；blocked：要登录或过滑块 */
type Mtop = { kind: "ok"; data: any } | { kind: "site"; ret: string } | { kind: "unknown"; ret: string } | { kind: "blocked"; ret: string };

/** 打开 url（它要有 lib.mtop），在页面里调一个 mtop 接口 */
async function mtop(url: string, api: string, data: Record<string, string>): Promise<Mtop> {
	const p = await page(new URL(url).origin);
	await p.goto(url);
	return p.run(async (api: string, data: Record<string, string>) => {
		if (/login|passport|punish/.test(location.href)) return { kind: "blocked" as const, ret: "1688 要登录或要过滑块：在浏览器里处理一下" };
		const lib = (window as any).lib;
		if (!lib?.mtop) return { kind: "site" as const, ret: "页面没加载好（没有 lib.mtop），没有发请求" };
		try {
			const res = await lib.mtop.request({ api, v: "1.0", type: "post", dataType: "json", H5Request: true, timeout: 20000, data });
			return { kind: "ok" as const, data: res.data };
		} catch (e: any) {
			const ret = ((e?.ret ?? []) as string[]).join("，") || String(e);
			if (!e?.api) return { kind: "unknown" as const, ret };
			if (/FAIL_SYS_SESSION_EXPIRED|FAIL_SYS_USER_VALIDATE/.test(ret)) return { kind: "blocked" as const, ret };
			return { kind: "site" as const, ret };
		}
	}, api, data);
}

/** 读的接口：不是 ok 就抛错 */
async function read(url: string, api: string, data: Record<string, string>, what: string): Promise<any> {
	const r = await mtop(url, api, data);
	if (r.kind === "blocked") throw new NeedsHuman(`${what}：${r.ret}`);
	if (r.kind !== "ok") throw new Error(`${what}：${r.ret}`);
	return r.data;
}

// ── 账号 ──

/** 登录着的 1688 账号：userId 唯一且不变；loginId 是会员名（能改，只给人看）。首页服务端渲染的 loginStore */
export async function account(): Promise<{ userId: string; loginId: string }> {
	const p = await page("https://www.1688.com");
	await p.goto("https://www.1688.com/");
	const u = await p.run(() => (window as any).__ICE_APP_CONTEXT__?.loaderData?.["/"]?.data?.loginStore ?? null);
	if (u?.isLogin !== true || !u.userId) throw new NeedsHuman("1688 没有登录：在浏览器里登录 1688");
	return { userId: String(u.userId), loginId: String(u.loginId ?? "") };
}

// ── 搜索 ──

export type SearchHit = { offerId: string; url: string; title: string; price: number; minQty: number; sold: string; shop: string; image: string };

/** 在 1688 上按关键词搜货源（第一页）。搜索页的关键词是 GBK 编码，照 lilto 的做法在搜索框里填、提交表单，不自己拼地址。
 * 读的是页面上的卡片（2026-08-29 的页面结构），改版了会读不到，报错。
 * 2026-10-09 查过：一页 60 个，先只出 10 来个，往下滚才一批批加载；价格拆成几段（¥、0、.03），要读整个 .price-item；
 * 起订量（≥N 个）多数卡片上没有，没有时 minQty 是 0 */
export async function search(keyword: string): Promise<SearchHit[]> {
	const p = await page("https://s.1688.com");
	await p.goto("https://s.1688.com/selloffer/offer_search.htm");
	const sent = await p.run((keyword: string) => {
		if (/login|passport|punish/.test(location.href) || document.querySelector(".nc_wrapper,.baxia-dialog,#nc_1_wrapper")) return "blocked";
		const input = document.querySelector<HTMLInputElement>("input[name=keywords]");
		if (!input?.form) return "none";
		input.value = keyword;
		input.form.submit();
		return "sent";
	}, keyword);
	if (sent === "blocked") throw new NeedsHuman("1688 要登录或要过滑块：在浏览器里处理一下");
	if (sent === "none") throw new Error("1688 搜索页没有搜索框：页面可能改版了");
	let seen = -1, still = 0, last: SearchHit[] | null = null;
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 1000));
		const got = await p.run((keyword: string) => {
			if (/login|passport|punish/.test(location.href) || document.querySelector(".nc_wrapper,.baxia-dialog,#nc_1_wrapper")) return { error: "1688 要登录或要过滑块：在浏览器里处理一下" };
			if (document.readyState !== "complete" || (document.querySelector<HTMLInputElement>("input[name=keywords]")?.value ?? "").trim() !== keyword.trim()) return null;
			const cards = [...document.querySelectorAll<HTMLAnchorElement>('a[data-tracker="offer"][href*="offerId="], a[class*="offerCard--"][href*="offerId="], a.search-offer-item, a.search-offer-wrapper')];
			if (!cards.length) return /空空如也/.test(document.body.innerText) ? { hits: [] } : null;
			// 滚到底，让页面接着加载这一页后面的卡片
			window.scrollTo(0, document.body.scrollHeight);
			return {
				hits: cards.map((card: HTMLAnchorElement) => {
					const offerId = card.href.match(/offerId=(\d+)/)?.[1] ?? "";
					const descs = [...card.querySelectorAll<HTMLElement>('.desc-text, [class*="descText--"]')].map((e) => e.innerText.trim());
					const min = descs.find((v) => /^[≥>]/.test(v)) || (card.querySelector<HTMLElement>('[class*="hoverPriceQty--"]')?.innerText ?? "").trim();
					const sold = descs.find((v) => /^(?:全网)?\d[\d.+万]*件$/.test(v)) || "";
					const img = card.querySelector("img");
					return {
						offerId, url: `https://detail.1688.com/offer/${offerId}.html`,
						title: (card.querySelector<HTMLElement>('.title-text, [class*="titleText--"]')?.innerText ?? card.innerText.split("\n")[0] ?? "").trim(),
						// 卡片上那一行的价格（悬停浮层里的是阶梯价），整个 .price-item：¥、整数、小数是分开的几段
						price: Number.parseFloat((card.querySelector<HTMLElement>('.offer-price-row .price-item, .price-item, [class*="priceItem--"], [class*="hoverPriceValue--"]')?.innerText ?? "").replace(/[^\d.]/g, "")) || 0,
						minQty: Number.parseInt(min.replace(/[^\d]/g, ""), 10) || 0,
						sold, shop: descs.filter((v) => v !== min && v !== sold && !/回头率|包运费|先采后付/.test(v)).pop() ?? "",
						image: img?.src || img?.getAttribute("data-src") || "",
					};
				}).filter((h) => h.offerId),
			};
		}, keyword);
		if (got && "error" in got) throw new NeedsHuman(got.error);
		if (!got) continue;
		last = got.hits;
		// 卡片数连着两次不再变多，才算这一页加载完
		if (got.hits.length > seen) { seen = got.hits.length; still = 0; continue; }
		if (++still >= 2) return got.hits;
	}
	if (last) return last;
	throw new Error("1688 搜索结果 30 秒没出来：页面可能改版了");
}

// ── 购物车 ──

export type CartLine = { offerId: string; skuId: string; quantity: number };

/** 购物车里的全部规格。超过一页读不全时报错（没有做翻页），免得把读了一半当成全部。
 * 删购物车没有做：lilto 旧工作台是点页面上的删除确认框（「确认将 N 个商品删除？」），不是接口 */
export async function cart(): Promise<CartLine[]> {
	const data = await read("https://cart.1688.com/cart.htm", "mtop.1688.buycenter.MtopPurchaseAstoreService.render", { fromkv: "", purchaseType: "main_purchase_type", platformType: "PC" }, "读 1688 购物车");
	const parts = Object.values(JSON.parse(data.model).data) as { type: string; fields: any }[];
	const items = parts.filter((x) => x.type === "item").map((x) => ({ offerId: String(x.fields.offerId), skuId: String(x.fields.skuId ?? x.fields.offerId), quantity: Number(x.fields.quantity) }));
	const total = Number(parts.find((x) => x.type === "root")?.fields?.totalSkuCount ?? items.length);
	if (items.length < total) throw new Error(`购物车有 ${total} 个规格，只读到 ${items.length} 个（没有做翻页）`);
	return items;
}

/** 加购的结果。sent：站点收下了（到底加没加上由调用方回读购物车判断）；refused：站点确定没加；unknown：请求可能到了站点，不知道加没加 */
export type AddResult = { kind: "sent" } | { kind: "refused"; why: string } | { kind: "blocked"; why: string } | { kind: "unknown"; why: string };

/** 把一个规格加进购物车（addCargo，在这个货源的商品页里发）。只有一个规格的货源 specId 是空字符串。
 * 同一个规格加两次，购物车里是两倍：结果未知时调用方不许重发。
 * 还没做（lilto 旧工作台做过）：加之前查起订量（混批时看 mixModel）、价格比上次读到的涨了 10% 以上就停 */
export async function addToCart(offerId: string, specId: string, quantity: number): Promise<AddResult> {
	const r = await mtop(`https://detail.1688.com/offer/${offerId}.html`, "com.alibaba.china.buy.service.purchase.MtopPurchaseService.addCargo", {
		client: "pc", purchaseType: "", attributes: "{}", fromkv: "offerdetail:pc",
		goodsParams: JSON.stringify([{ offerId, specId, quantity, flow: "general", ext: { sceneCode: "" }, selectedTradeServices: [] }]),
	});
	if (r.kind === "ok") return { kind: "sent" };
	if (r.kind === "blocked") return { kind: "blocked", why: r.ret };
	// 站点的答复里只有这几种是确定没加：业务拒绝、参数不对、页面没加载好没发。别的（系统错误、限流、令牌过期）可能已经加了
	if (r.kind === "site" && /FAIL_BIZ|ILLEGAL|PARAM|没有发请求/.test(r.ret)) return { kind: "refused", why: r.ret };
	return { kind: "unknown", why: r.ret };
}

// ── 采购单 ──

export type BuyerOrder = {
	orderId: string; status: string; statusLabel: string; createdAt: string; paidAt: number | null;
	goods: number; freight: number; discount: number; paid: number;
	/** 收货地址：采购单列表里没有（2026-10-09 对 50 张真采购单核对过），从名字带 address、addr、receiver 的字段里找；找不到是空字符串。要的话得读采购单详情 */
	address: string;
	/** 每一行（货源的一个规格）：skuId（只有一个规格的货源是空的）、这一行的状态（已发货、已收货……）、已收件数 */
	items: {
		offerId: string; specId: string; skuId: string; name: string; spec: string; quantity: number; price: number; status: string; statusLabel: string; received: number; trackingNo: string; shippedAt: number | null;
		/** 这一行的退款：单号、售中还是售后、粗状态（waitselleragree 进行中、refundsuccess 成功、refundclose 关闭）。没有退款是 null */
		refund: { id: string; stage: "售中" | "售后"; status: string } | null;
	}[];
	/** 原样的一行：字段核对过以前留着查 */
	raw: unknown;
};

/** 在一行采购单里找收货地址：先找名字像地址的字符串字段，再找收货人对象里的 */
export function addressOf(o: any): string {
	const found: string[] = [];
	const walk = (v: any, key: string, depth: number) => {
		if (depth > 4 || v === null || v === undefined) return;
		if (typeof v === "string") { if (/address|addr/i.test(key) && v.trim()) found.push(v.trim()); return; }
		if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, /receiver|address|addr/i.test(key) ? `${key}.${k}` : k, depth + 1);
	};
	walk(o, "", 0);
	return found.sort((a, b) => b.length - a.length)[0] ?? "";
}

const BUYER_ORDERS = "https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html";

/** 采购单（在 1688 买的订单），一页最多 50 张，新的在前。金额是元（接口是分）。
 * orderId 用 idStr：19 位订单号当数字会丢精度 */
export async function buyerOrders(pageNo = 1, pageSize = 50, tradeStatus = ""): Promise<{ total: number; pages: number; rows: BuyerOrder[] }> {
	const data = await read(BUYER_ORDERS, "mtop.1688.trading.dataline.service", {
		serviceId: "OrderListDataLineService.buyerOrderList", param: JSON.stringify({ tradeStatus, page: pageNo, pageSize: Math.min(50, pageSize) }),
	}, "读 1688 采购单");
	const payload = JSON.parse(String(data?.data?.result ?? "null"))?.data;
	const yuan = (v: unknown) => Number(v ?? 0) / 100;
	const rows = ((payload?.data ?? []) as any[]).map((o): BuyerOrder => ({
		orderId: String(o.idStr ?? o.id), status: String(o.status ?? ""), statusLabel: String(o.statusLabel ?? ""),
		createdAt: String(o.gmtCreate ?? ""), paidAt: o.gmtPayment ? Number(o.gmtPayment) : null,
		goods: yuan(o.sumProductPayment), freight: yuan(o.carriage), discount: yuan(o.allPromotionFee), paid: yuan(o.sumPayment),
		address: addressOf(o), raw: o,
		items: ((o.orderEntries ?? []) as any[]).map((e) => ({
			offerId: String(e.sourceId ?? ""), specId: String(e.specId ?? ""), skuId: String(e.skuId ?? ""), name: String(e.productName ?? ""),
			spec: ((e.specInfo?.specItems ?? []) as any[]).map((x) => x.specValue).join(" / "),
			quantity: Number(e.quantity?.realAmount ?? e.quantity?.calAmount ?? e.quantity ?? 0), price: yuan(e.price),
			status: String(e.entryStatus ?? ""), statusLabel: String(e.entryStatusLabel ?? ""), received: Number(e.entryExtension?.receivedQuantity ?? 0),
			// 售中退款在 refundId / refundStatus，售后（确认收货以后申请的）在 refundIdForAs / refundStatusForAs（2026-10-09 读页面的 JS、对真退款单核对过，见 1688.md）
			refund: e.entryExtension?.refundIdForAs ? { id: String(e.entryExtension.refundIdForAs), stage: "售后", status: String(e.entryExtension.refundStatusForAs ?? "") }
				: e.entryExtension?.refundId ? { id: String(e.entryExtension.refundId), stage: "售中", status: String(e.entryExtension.refundStatus ?? "") } : null,
			trackingNo: String(e.entryExtension?.trackingNo ?? ""), shippedAt: e.entryExtension?.sendgt ? Number(e.entryExtension.sendgt) : null,
		})),
	}));
	return { total: Number(payload?.total ?? rows.length), pages: Number(payload?.pages ?? 1), rows };
}

// ── 退款 ──

/** 一张退款单的状态。status：waitselleragree 等卖家同意、waitbuyermodify 卖家拒绝等买家修改、waitbuyersend 等买家寄回、
 * waitsellerreceive 等卖家收货、refundsuccess 成功、refundclose 关闭（后两个是终态）。同一个状态码中文会变（退款成功、极速退款成功），判断用状态码 */
export type Refund = {
	refundId: string; status: string; statusLabel: string;
	/** 仅退款、退货退款、换货、补寄 */
	kind: string;
	/** 退的钱（元）：货款 + 运费 */
	amount: number;
	/** 退货寄回的运单号、物流状态（还没寄是 null） */
	returnTrackingNo: string | null; returnLogistics: string | null;
	createdAt: string; updatedAt: string;
};

/** 读一张退款单的详情（viewRefundDetail）。stage：售中（行上的 refundId）还是售后（refundIdForAs）。
 * 回包里有卖家的电话、姓名、退货地址：只取上面这些，不留 */
export async function refund(refundId: string, stage: "售中" | "售后"): Promise<Refund> {
	const d = await read(BUYER_ORDERS, "mtop.alibaba.cbu.refund.MtopRefundView.viewRefundDetail", { refundId, disputeType: stage === "售中" ? "1" : "2" }, `读 1688 退款单 ${refundId}`);
	const m = d?.model;
	if (!m?.status) throw new Error(`1688 退款单 ${refundId} 没有回状态`);
	const scene = m.refundSceneModel ?? {};
	const back = m.selfReturnGoodsLogisticModel;
	return {
		refundId, status: String(m.status), statusLabel: String(m.statusLabel ?? ""),
		kind: scene.replaceNew ? "换货" : scene.reshipping ? "补寄" : m.needReturnGoods ? "退货退款" : "仅退款",
		amount: (Number(m.refundPayment ?? 0) + Number(m.refundCarriage ?? 0)) / 100,
		returnTrackingNo: back?.freightBill ? String(back.freightBill) : null, returnLogistics: back?.logisticsStatus ? String(back.logisticsStatus) : null,
		createdAt: String(m.gmtCreate ?? ""), updatedAt: String(m.gmtModified ?? ""),
	};
}

export type Trace = { orderId: string; traces: { status: string; trackingNo: string; logisticsId: string; remark: string }[] };

/** 采购单的物流轨迹。回包里的订单号会被当成数字丢精度、顺序也不稳：订单号对不上时只用运单号反查唯一的一条，不按位置猜 */
export async function traces(orders: { orderId: string; trackingNos?: string[] }[]): Promise<Trace[]> {
	if (orders.length === 0) return [];
	const data = await read(BUYER_ORDERS, "mtop.1688.mtoplgttraceservice.querytrace", { orderIds: orders.map((o) => o.orderId).join(",") }, "读 1688 物流");
	const raw = (data?.result ?? []) as any[];
	return orders.map(({ orderId, trackingNos = [] }) => {
		const exact = raw.find((c) => String(c.orderId ?? "") === orderId);
		const byNo = trackingNos.length ? raw.filter((c) => (c.trace ?? []).some((t: any) => trackingNos.includes(String(t.mailNo ?? "")))) : [];
		const found = exact ?? (byNo.length === 1 ? byNo[0] : undefined);
		return {
			orderId,
			traces: ((found?.trace ?? []) as any[]).filter((t) => t.mailNo).map((t) => ({ status: String(t.currentStatus ?? ""), trackingNo: String(t.mailNo), logisticsId: String(t.logisticsId ?? ""), remark: String(t.remark ?? "") })),
		};
	});
}

// ── x2 1688 <操作>：读操作（加购是写，声明在 writes.ts，只经 x2 run） ──

export const ops: Ops = {
	account: get("登录着的 1688 账号", undefined, () => account()),
	offer: get("一家货源：标题、起订量、属性、每个规格的价格和库存", z.object({ id: str("货源 id 或 1688 链接") }), (p) => {
		const id = offerIdOf(p.id);
		if (!id) throw new Usage(`认不出货源：${p.id}`);
		return offer(id);
	}),
	search: all("按关键词搜货源（第一页）", z.object({ keyword: str("关键词") }), (p) => search(p.keyword)),
	cart: all("购物车里的全部规格和件数", undefined, () => cart()),
	orders: byPage("采购单（在 1688 买的订单），新的在前；金额是元",
		z.object({ status: z.string().default("").describe("交易状态（采购单列表接口的 tradeStatus）；不给是全部") }),
		async (p, n) => {
			const r = await buyerOrders(n, 50, p.status);
			return { rows: r.rows, more: n < r.pages };
		}),
	refund: get("一张退款单：状态、类型、退的钱、退货运单号", z.object({ id: str("退款单号（TQ 开头）"), stage: z.enum(["售中", "售后"]).default("售中").describe("售中（行上的 refundId）还是售后（refundIdForAs）") }),
		(p) => refund(p.id, p.stage)),
	traces: all("采购单的物流轨迹", z.object({ orders: strs("采购单号") }), (p) => traces(p.orders.map((orderId) => ({ orderId })))),
};
