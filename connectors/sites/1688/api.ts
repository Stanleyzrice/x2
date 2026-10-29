// 1688：货源详情、购物车、加购。货源详情是服务端渲染进页面的全局变量（window.context.result.global.globalData.model），打开商品页读它，不用签名。
// 查过的事实（2026-09-30）：tradeModel.skuMap 是规格（specAttrs 用「&gt;」连接几个属性，例「kitty猫款式5&gt;20*30cm【硅藻泥】3mm」）；
// offerDetail.skuProps 是属性（prop，例「颜色」「尺寸」）和它的取值（value: {name, imageUrl}），第一个属性的取值带图片；只有一个规格的货源没有 skuMap。
// 2026-10-10 核对过：mainImageList 是 { fullPathImageURI }；detailDescription.freightInfo.skuWeight 按 skuId 记运费重量（kg），没有的用 unitWeight；
// 详情图在 offerDetail.detailUrl（itemcdn.tmall.com，服务端取，见 detailImages）；48 小时发货是 deliveryLimit ≤ 2；包邮是 freeDeliverFee；
// freightInfo.totalCost 是寄到账号默认地址（recieveAddress）买 1 件的运费（页面上的「运费¥8起」）
import { challenge, page } from "../../../platform/browser/browser.ts";
import { Challenge, NeedsHuman } from "../../../platform/errors.ts";

/** attrs：每个属性的取值，顺序同 Offer.props */
export type Sku = { skuId: string; specId: string; name: string; attrs: string[]; price: number; stock: number; image: string; weightKg?: number | null };
export type Prop = { name: string; values: { name: string; image: string }[] };
/** 货源的服务：一件代发、包邮、48 小时发货（deliveryDays 是卖家承诺几天内发货） */
export type Tags = { onePsale: boolean; freeShipping: boolean; ship48h: boolean; deliveryDays: number | null };
/** 国内运费：寄到 1688 账号的默认地址（就是我们这里）买 1 件要多少（元）；包邮是 0，读不到是 null */
export type Freight = { costRmb: number | null; to: string };
export type Offer = {
	offerId: string;
	url: string;
	title: string;
	image: string;
	unit: string;
	minQty: number;
	props: Prop[];
	skus: Sku[];
	images?: string[];
	detailUrl?: string | null;
	tags?: Tags;
	freight?: Freight;
};

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
		if (!m?.tradeModel)
			return location.href.includes("login") || location.href.includes("punish")
				? { error: "1688 要登录或要过滑块：在浏览器里处理一下" }
				: { gone: true as const };
		const t = m.tradeModel,
			d = m.offerDetail;
		const data = (window as any).context?.result?.data;
		const https = (u: unknown) => (typeof u === "string" ? u.replace(/^\/\//, "https://") : "");
		const unescapeHtml = (s: string) => s.replace(/&gt;/g, ">").replace(/&amp;/g, "&");
		const freight = m.detailDescription?.freightInfo ?? {};
		// 小于 20 克的当作没给（见过填 0.001 kg 的，照它核价会定得太低）：交给 agent 往重了估
		const weightOf = (skuId: unknown) => {
			const w = Number(freight.skuWeight?.[String(skuId)]) || Number(freight.unitWeight) || null;
			return w !== null && w >= 0.02 ? w : null;
		};
		let json = "";
		try {
			json = JSON.stringify(m);
		} catch {
			/* 有循环引用就只看页面的字 */
		}
		const text = String(document.body?.innerText ?? "");
		const days = /"deliveryLimit":(\d+)/.exec(json);
		const tags = {
			onePsale: /"isOnePsale":true/.test(json) || /一件代发/.test(json + text),
			freeShipping: /"freeDeliverFee":true/.test(json),
			ship48h: (days !== null && Number(days[1]) <= 2) || /"serviceName":"(?:24|48)小时发货"/.test(json),
			deliveryDays: days ? Number(days[1]) : null,
		};
		const images = [
			...new Set(
				[
					...((d.mainImageList ?? []) as any[]).map((i) => https(i?.fullPathImageURI ?? i)),
					...((data?.gallery?.fields?.mainImage ?? []) as unknown[]).map(https),
				].filter(Boolean),
			),
		];
		const detailUrl = https(d.detailUrl ?? data?.description?.fields?.detailUrl) || null;
		const cost = Number(freight.totalCost);
		const freightOut = {
			costRmb: tags.freeShipping ? 0 : Number.isFinite(cost) && freight.totalCost !== undefined && freight.totalCost !== null ? cost : null,
			to: String(freight.recieveAddress ?? ""),
		};
		const hasSkus = (t.skuMap ?? []).length > 0;
		const props = hasSkus
			? ((d.skuProps ?? []) as { prop?: string; value?: { name: string; imageUrl?: string }[] }[]).map((p) => ({
					name: p.prop ?? "",
					values: (p.value ?? []).map((v) => ({ name: unescapeHtml(v.name), image: v.imageUrl ?? "" })),
				}))
			: [];
		// 第一个属性的取值 → 图片
		const valueImages = new Map<string, string>((props[0]?.values ?? []).map((v) => [v.name, https(v.image)]));
		const skus = hasSkus
			? (t.skuMap as any[]).map((s) => {
					const attrs = unescapeHtml(s.specAttrs ?? "").split(">");
					return {
						skuId: String(s.skuId),
						specId: s.specId ?? "",
						name: attrs.join(" / "),
						attrs,
						price: Number(s.price || s.discountPrice || t.minPrice),
						stock: Number(s.canBookCount ?? 0),
						image: valueImages.get(attrs[0]!) ?? "",
						weightKg: weightOf(s.skuId),
					};
				})
			: [
					{
						skuId: String(t.offerId),
						specId: "",
						name: "",
						attrs: [],
						price: Number(t.minPrice),
						stock: Number(t.canBookedAmount ?? 0),
						image: d.mainImageList?.[0]?.fullPathImageURI ?? "",
						weightKg: weightOf(t.offerId),
					},
				];
		return {
			offerId: String(t.offerId),
			url,
			title: d.subject,
			image: images[0] ?? "",
			unit: t.unit ?? "",
			minQty: Number(t.beginAmount ?? 1),
			props,
			skus,
			images,
			detailUrl,
			tags,
			freight: freightOut,
		};
	}, url);
	if ("error" in got) throw new NeedsHuman(`读 1688 货源 ${offerId}：${got.error}`);
	if ("gone" in got) throw new Gone(`1688 货源 ${offerId} 不存在或已下架`);
	return got;
}

/** 详情图：detailUrl 回的是 `var offer_details={"content":"<html>"};`（浏览器跨域拿不到，在这边取）。按出现的顺序取 <img src>，去重，最多 40 张 */
export async function detailImages(detailUrl: string): Promise<string[]> {
	const r = await fetch(detailUrl, {
		headers: {
			"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
			referer: "https://detail.1688.com/",
		},
		signal: AbortSignal.timeout(30_000),
	});
	if (!r.ok) throw new Error(`取 1688 详情 HTTP ${r.status}`);
	const text = await r.text();
	let html = text;
	try {
		html = String(JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)).content ?? "");
	} catch {
		/* 不是 JSON 外壳：当成 HTML */
	}
	const urls = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]!.replace(/^\/\//, "https://")).filter((u) => /^https:\/\//.test(u));
	return [...new Set(urls)].slice(0, 40);
}

// ── mtop ──
// 购物车、加购、采购单、物流都在页面里用页面自己的 lib.mtop.request 发（签名由它算）。依据 lilto 的 packages/presets/src/1688.ts（2026-09-24 读的 mtop.js 源码）：
// 站点回 SUCCESS 时 resolve；站点回别的 ret 时 reject 整个响应（带 api）；库自己超时、解析失败时 reject 的对象没有 api，这时请求可能已经到了站点

/** ok：站点回 SUCCESS；site：站点回了别的 ret（确定是站点的答复）；unknown：没有站点的答复（超时、解析失败），请求可能已经到了站点；
 * blocked：要登录，或要过滑块验证（challenge），请求没发出去或站点没受理 */
type Mtop =
	| { kind: "ok"; data: any }
	| { kind: "site"; ret: string }
	| { kind: "unknown"; ret: string }
	| { kind: "blocked"; ret: string; challenge?: boolean };

/** 在 url 这一页（它要有 lib.mtop）里调一个 mtop 接口。标签页已经在这一页、lib.mtop 也在的，不再加载（同一页上发几个请求，少加载几次 1688）。
 * 发之前就跳了滑块验证的算没发（blocked）；发了以后页面弹出验证框的，browser.ts 抛 Challenge（请求可能在人拉过滑块以后才到站点） */
async function mtop(url: string, api: string, data: Record<string, string>): Promise<Mtop> {
	const u = new URL(url);
	const p = await page(u.origin);
	try {
		if (!(await p.run((path: string) => location.pathname === path && Boolean((window as any).lib?.mtop), u.pathname))) await p.goto(url);
	} catch (e) {
		if (e instanceof Challenge) return { kind: "blocked", ret: e.message, challenge: true };
		throw e;
	}
	const r = await p.run(
		async (api: string, data: Record<string, string>) => {
			if (/login|passport|punish/.test(location.href)) return { kind: "blocked" as const, ret: "1688 要登录：在浏览器里登录 1688" };
			const lib = (window as any).lib;
			if (!lib?.mtop) return { kind: "site" as const, ret: "页面没加载好（没有 lib.mtop），没有发请求" };
			try {
				const res = await lib.mtop.request({ api, v: "1.0", type: "post", dataType: "json", H5Request: true, timeout: 20000, data });
				return { kind: "ok" as const, data: res.data };
			} catch (e: any) {
				const ret = ((e?.ret ?? []) as string[]).join("，") || String(e);
				if (!e?.api) return { kind: "unknown" as const, ret };
				// 网关要过滑块（阿里系风控）：站点没受理
				if (/FAIL_SYS_USER_VALIDATE|RGV587_ERROR/.test(ret)) return { kind: "challenge" as const, ret };
				if (/FAIL_SYS_SESSION_EXPIRED/.test(ret)) return { kind: "blocked" as const, ret };
				return { kind: "site" as const, ret };
			}
		},
		api,
		data,
	);
	return r.kind === "challenge" ? { kind: "blocked", ret: (await challenge(p.browser, "1688")).message, challenge: true } : r;
}

/** 读的接口：不是 ok 就抛错 */
async function read(url: string, api: string, data: Record<string, string>, what: string): Promise<any> {
	const r = await mtop(url, api, data);
	if (r.kind === "blocked" && r.challenge) throw new Challenge(r.ret);
	if (r.kind === "blocked") throw new NeedsHuman(`${what}：${r.ret}`);
	if (r.kind !== "ok") throw new Error(`${what}：${r.ret}`);
	return r.data;
}

// ── 账号 ──

/** 登录着的 1688 账号：userId 唯一且不变；loginId 是会员名（能改，只给人看）。首页服务端渲染的 loginStore */
/** cookie __cn_logon__ 说登录着没有（纯函数）：true、false；没有这个 cookie（读不了、没去过 1688）是 null */
export function alibabaCookie(jar: Map<string, string> | null): boolean | null {
	const v = jar?.get("__cn_logon__");
	return v === "true" ? true : v === "false" ? false : null;
}

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
	// 搜索页没有带 name 的搜索框了：关键词直接放在地址里（charset=utf8 才认 UTF-8）
	await p.goto(`https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(keyword)}&charset=utf8`);
	let seen = -1,
		still = 0,
		last: SearchHit[] | null = null;
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 1000));
		const got = await p.run(() => {
			if (/login|passport|punish/.test(location.href) || document.querySelector(".nc_wrapper,.baxia-dialog,#nc_1_wrapper"))
				return { error: "1688 要登录或要过滑块：在浏览器里处理一下" };
			if (document.readyState !== "complete") return null;
			const cards = [
				...document.querySelectorAll<HTMLAnchorElement>(
					'a[class*="feedCard--"], a[data-tracker="offer"][href*="offerId="], a[class*="offerCard--"][href*="offerId="], a.search-offer-item, a.search-offer-wrapper',
				),
			];
			if (!cards.length) return /空空如也|没有找到/.test(document.body.innerText) ? { hits: [] } : null;
			// 滚到底，让页面接着加载这一页后面的卡片
			window.scrollTo(0, document.body.scrollHeight);
			const text = (el: Element | null) => ((el as HTMLElement | null)?.innerText ?? "").trim();
			return {
				hits: cards
					.map((card) => {
						// 广告卡片的链接里没有货源 id：跳过
						const offerId = card.href.match(/\/offer\/(\d+)\.html/)?.[1] ?? card.href.match(/offerId=(\d+)/)?.[1] ?? "";
						const descs = [...card.querySelectorAll('[class*="descText--"], .desc-text')].map(text);
						const min = descs.find((v) => /^[≥>]\s*\d/.test(v) || /\d+\s*件起批/.test(v)) || text(card.querySelector('[class*="hoverPriceQty--"]'));
						const sold = descs.find((v) => /^(?:全网)?\d[\d.+万]*件$/.test(v)) || "";
						// 标题：卡片里第一段长文字（不在描述、价格、店铺那几块里）
						const titleEl =
							card.querySelector('[class*="title--"], .title-text, [class*="titleText--"]') ??
							[...card.querySelectorAll<HTMLElement>("div, span")].find((el) => {
								const own = [...el.childNodes]
									.filter((n) => n.nodeType === 3)
									.map((n) => n.textContent ?? "")
									.join("")
									.trim();
								return own.length >= 8 && !/desc|price|seller|channel/i.test(String(el.className));
							}) ??
							null;
						const price =
							text(card.querySelector('[class*="priceMain--"]')) + text(card.querySelector('[class*="priceSub--"]')) ||
							text(card.querySelector('.offer-price-row .price-item, .price-item, [class*="priceItem--"], [class*="hoverPriceValue--"]'));
						const img = card.querySelector<HTMLImageElement>('img:not([class*="Icon"]):not([class*="icon"])');
						return {
							offerId,
							url: `https://detail.1688.com/offer/${offerId}.html`,
							title: text(titleEl) || (card.innerText.split("\n")[0] ?? "").trim(),
							price: Number.parseFloat(price.replace(/[^\d.]/g, "")) || 0,
							minQty: Number.parseInt(min.replace(/[^\d]/g, ""), 10) || 0,
							sold,
							shop:
								text(card.querySelector('[class*="sellerInformationText--"]')) ||
								descs.filter((v) => v !== min && v !== sold && !/回头率|包运费|先采后付/.test(v)).pop() ||
								"",
							image: img?.src || img?.getAttribute("data-src") || "",
						};
					})
					.filter((h) => h.offerId),
			};
		});
		if (got && "error" in got) throw new NeedsHuman(got.error);
		if (!got) continue;
		last = got.hits;
		// 卡片数连着两次不再变多，才算这一页加载完
		if (got.hits.length > seen) {
			seen = got.hits.length;
			still = 0;
			continue;
		}
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
	const data = await read(
		"https://cart.1688.com/cart.htm",
		"mtop.1688.buycenter.MtopPurchaseAstoreService.render",
		{ fromkv: "", purchaseType: "main_purchase_type", platformType: "PC" },
		"读 1688 购物车",
	);
	const parts = Object.values(JSON.parse(data.model).data) as { type: string; fields: any }[];
	const items = parts
		.filter((x) => x.type === "item")
		.map((x) => ({ offerId: String(x.fields.offerId), skuId: String(x.fields.skuId ?? x.fields.offerId), quantity: Number(x.fields.quantity) }));
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
		client: "pc",
		purchaseType: "",
		attributes: "{}",
		fromkv: "offerdetail:pc",
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
	orderId: string;
	status: string;
	statusLabel: string;
	createdAt: string;
	paidAt: number | null;
	goods: number;
	freight: number;
	discount: number;
	paid: number;
	/** 收货地址：采购单列表里没有（2026-10-09 对 50 张真采购单核对过），从名字带 address、addr、receiver 的字段里找；找不到是空字符串。要的话得读采购单详情 */
	address: string;
	/** 每一行（货源的一个规格）：skuId（只有一个规格的货源是空的）、这一行的状态（已发货、已收货……）、已收件数 */
	items: {
		offerId: string;
		specId: string;
		skuId: string;
		name: string;
		spec: string;
		quantity: number;
		price: number;
		status: string;
		statusLabel: string;
		received: number;
		trackingNo: string;
		shippedAt: number | null;
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
		if (typeof v === "string") {
			if (/address|addr/i.test(key) && v.trim()) found.push(v.trim());
			return;
		}
		if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, /receiver|address|addr/i.test(key) ? `${key}.${k}` : k, depth + 1);
	};
	walk(o, "", 0);
	return found.sort((a, b) => b.length - a.length)[0] ?? "";
}

const BUYER_ORDERS = "https://air.1688.com/app/ctf-page/trade-order-list/buyer-order-list.html";

/** 采购单（在 1688 买的订单），一页最多 50 张，新的在前。金额是元（接口是分）。
 * orderId 用 idStr：19 位订单号当数字会丢精度 */
export async function buyerOrders(pageNo = 1, pageSize = 50, tradeStatus = ""): Promise<{ total: number; pages: number; rows: BuyerOrder[] }> {
	const data = await read(
		BUYER_ORDERS,
		"mtop.1688.trading.dataline.service",
		{
			serviceId: "OrderListDataLineService.buyerOrderList",
			param: JSON.stringify({ tradeStatus, page: pageNo, pageSize: Math.min(50, pageSize) }),
		},
		"读 1688 采购单",
	);
	const payload = JSON.parse(String(data?.data?.result ?? "null"))?.data;
	const yuan = (v: unknown) => Number(v ?? 0) / 100;
	const rows = ((payload?.data ?? []) as any[]).map(
		(o): BuyerOrder => ({
			orderId: String(o.idStr ?? o.id),
			status: String(o.status ?? ""),
			statusLabel: String(o.statusLabel ?? ""),
			createdAt: String(o.gmtCreate ?? ""),
			paidAt: o.gmtPayment ? Number(o.gmtPayment) : null,
			goods: yuan(o.sumProductPayment),
			freight: yuan(o.carriage),
			discount: yuan(o.allPromotionFee),
			paid: yuan(o.sumPayment),
			address: addressOf(o),
			raw: o,
			items: ((o.orderEntries ?? []) as any[]).map((e) => ({
				offerId: String(e.sourceId ?? ""),
				specId: String(e.specId ?? ""),
				skuId: String(e.skuId ?? ""),
				name: String(e.productName ?? ""),
				spec: ((e.specInfo?.specItems ?? []) as any[]).map((x) => x.specValue).join(" / "),
				quantity: Number(e.quantity?.realAmount ?? e.quantity?.calAmount ?? e.quantity ?? 0),
				price: yuan(e.price),
				status: String(e.entryStatus ?? ""),
				statusLabel: String(e.entryStatusLabel ?? ""),
				received: Number(e.entryExtension?.receivedQuantity ?? 0),
				// 售中退款在 refundId / refundStatus，售后（确认收货以后申请的）在 refundIdForAs / refundStatusForAs（2026-10-09 读页面的 JS、对真退款单核对过，见同目录的 NOTES.md）
				refund: e.entryExtension?.refundIdForAs
					? { id: String(e.entryExtension.refundIdForAs), stage: "售后", status: String(e.entryExtension.refundStatusForAs ?? "") }
					: e.entryExtension?.refundId
						? { id: String(e.entryExtension.refundId), stage: "售中", status: String(e.entryExtension.refundStatus ?? "") }
						: null,
				trackingNo: String(e.entryExtension?.trackingNo ?? ""),
				shippedAt: e.entryExtension?.sendgt ? Number(e.entryExtension.sendgt) : null,
			})),
		}),
	);
	return { total: Number(payload?.total ?? rows.length), pages: Number(payload?.pages ?? 1), rows };
}

// ── 退款 ──

/** 一张退款单的状态。status：waitselleragree 等卖家同意、waitbuyermodify 卖家拒绝等买家修改、waitbuyersend 等买家寄回、
 * waitsellerreceive 等卖家收货、refundsuccess 成功、refundclose 关闭（后两个是终态）。同一个状态码中文会变（退款成功、极速退款成功），判断用状态码 */
export type Refund = {
	refundId: string;
	status: string;
	statusLabel: string;
	/** 仅退款、退货退款、换货、补寄 */
	kind: string;
	/** 退的钱（元）：货款 + 运费 */
	amount: number;
	/** 退货寄回的运单号、物流状态（还没寄是 null） */
	returnTrackingNo: string | null;
	returnLogistics: string | null;
	createdAt: string;
	updatedAt: string;
};

/** 读一张退款单的详情（viewRefundDetail）。stage：售中（行上的 refundId）还是售后（refundIdForAs）。
 * 回包里有卖家的电话、姓名、退货地址：只取上面这些，不留 */
export async function refund(refundId: string, stage: "售中" | "售后"): Promise<Refund> {
	const d = await read(
		BUYER_ORDERS,
		"mtop.alibaba.cbu.refund.MtopRefundView.viewRefundDetail",
		{ refundId, disputeType: stage === "售中" ? "1" : "2" },
		`读 1688 退款单 ${refundId}`,
	);
	const m = d?.model;
	if (!m?.status) throw new Error(`1688 退款单 ${refundId} 没有回状态`);
	const scene = m.refundSceneModel ?? {};
	const back = m.selfReturnGoodsLogisticModel;
	return {
		refundId,
		status: String(m.status),
		statusLabel: String(m.statusLabel ?? ""),
		kind: scene.replaceNew ? "换货" : scene.reshipping ? "补寄" : m.needReturnGoods ? "退货退款" : "仅退款",
		amount: (Number(m.refundPayment ?? 0) + Number(m.refundCarriage ?? 0)) / 100,
		returnTrackingNo: back?.freightBill ? String(back.freightBill) : null,
		returnLogistics: back?.logisticsStatus ? String(back.logisticsStatus) : null,
		createdAt: String(m.gmtCreate ?? ""),
		updatedAt: String(m.gmtModified ?? ""),
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
			traces: ((found?.trace ?? []) as any[])
				.filter((t) => t.mailNo)
				.map((t) => ({
					status: String(t.currentStatus ?? ""),
					trackingNo: String(t.mailNo),
					logisticsId: String(t.logisticsId ?? ""),
					remark: String(t.remark ?? ""),
				})),
		};
	});
}
