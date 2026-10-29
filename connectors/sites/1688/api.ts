// 1688：商品（offer）详情、购物车、加购。商品详情是服务端渲染进页面的全局变量（window.context.result.global.globalData.model），打开商品页读它，不用签名。
// 查过的事实（2026-09-30）：tradeModel.skuMap 是规格（specAttrs 用「&gt;」连接几个属性，例「kitty猫款式5&gt;20*30cm【硅藻泥】3mm」）；
// offerDetail.skuProps 是属性（prop，例「颜色」「尺寸」）和它的取值（value: {name, imageUrl}），第一个属性的取值带图片；只有一个规格的商品没有 skuMap。
// 2026-10-10 核对过：mainImageList 是 { fullPathImageURI }；detailDescription.freightInfo.skuWeight 按 skuId 记运费重量（kg），没有的用 unitWeight；
// 详情图在 offerDetail.detailUrl（itemcdn.tmall.com，服务端取，见 detailImages）；48 小时发货是 deliveryLimit ≤ 2；包邮是 freeDeliverFee；
// freightInfo.totalCost 是寄到账号默认地址（recieveAddress）买 1 件的运费（页面上的「运费¥8起」）
import { z } from "zod";
import { challenge, page } from "../../../platform/browser/browser.ts";
import { Challenge, NeedsHuman } from "../../../platform/errors.ts";
import { idText, numeric, reply } from "../../../platform/reply.ts";

/** 1688 的几种 id 都是字符串，贴上标签别互相传错：商品 id（offer id）、规格的 skuId（只有一个规格的商品用商品 id）、
 * 加购要带的 specId（只有一个规格的是空字符串）。在这里解析回包时贴，业务工具的参数、读库时贴 */
export const OfferId = z.string().brand<"OfferId">();
export type OfferId = z.output<typeof OfferId>;
export const SkuId = z.string().brand<"SkuId">();
export type SkuId = z.output<typeof SkuId>;
export const SpecId = z.string().brand<"SpecId">();
export type SpecId = z.output<typeof SpecId>;

export type Sku = { skuId: SkuId; specId: SpecId; name: string; attrs: string[]; price: number; stock: number; image: string; weightKg?: number | null };
export type Prop = { name: string; values: { name: string; image: string }[] };
export type Tags = { onePsale: boolean; freeShipping: boolean; ship48h: boolean; deliveryDays: number | null };
export type Freight = { costRmb: number | null; to: string };
export type Offer = {
	offerId: OfferId;
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

export function offerIdOf(linkOrId: string): OfferId | null {
	const m = /offer\/(\d+)\.html/.exec(linkOrId) ?? /^(\d+)$/.exec(linkOrId.trim());
	return m ? OfferId.parse(m[1]) : null;
}

export class Gone extends Error {}

const image = z.union([z.looseObject({ fullPathImageURI: z.string().nullish() }), z.string()]);
/** 商品页上要用的几块（页面里只取这几块原样带回来，在这边解析）：model 的 tradeModel、offerDetail、detailDescription.freightInfo，data 的主图和详情地址 */
export const offerPage = z.object({
	tradeModel: z.looseObject({
		offerId: idText.pipe(OfferId),
		unit: z.string().nullish(),
		beginAmount: numeric.nullish(),
		minPrice: numeric.nullish(),
		canBookedAmount: numeric.nullish(),
		skuMap: z
			.array(
				z.looseObject({
					skuId: idText.pipe(SkuId),
					specId: SpecId.nullish(),
					specAttrs: z.string().nullish(),
					price: numeric.nullish(),
					discountPrice: numeric.nullish(),
					canBookCount: numeric.nullish(),
				}),
			)
			.nullish(),
	}),
	offerDetail: z.looseObject({
		subject: z.string(),
		detailUrl: z.string().nullish(),
		mainImageList: z.array(image).nullish(),
		skuProps: z
			.array(z.looseObject({ prop: z.string().nullish(), value: z.array(z.looseObject({ name: z.string(), imageUrl: z.string().nullish() })).nullish() }))
			.nullish(),
	}),
	freightInfo: z
		.looseObject({
			skuWeight: z.record(z.string(), numeric.nullish()).nullish(),
			unitWeight: numeric.nullish(),
			totalCost: numeric.nullish(),
			recieveAddress: z.string().nullish(),
		})
		.nullish(),
	gallery: z.array(z.unknown()).nullish(),
	descriptionUrl: z.string().nullish(),
	tags: z.object({ onePsale: z.boolean(), freeShipping: z.boolean(), ship48h: z.boolean(), deliveryDays: z.number().nullable() }),
});
export type OfferPage = z.input<typeof offerPage>;

const https = (u: unknown) => (typeof u === "string" ? u.replace(/^\/\//, "https://") : "");
const unescapeHtml = (s: string) => s.replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** 商品页上的几块 → Offer（纯函数） */
export function offerOf(raw: unknown, offerId: OfferId): Offer {
	const { tradeModel: t, offerDetail: d, freightInfo, gallery, descriptionUrl, tags } = reply(offerPage, raw, `1688 商品 ${offerId}`);
	const url = `https://detail.1688.com/offer/${offerId}.html`;
	const freight = freightInfo ?? {};
	// 规格自己的重量，没有的用整个商品的（unitWeight）；都没有是 null。kg，照 1688 填的原样回
	const weightOf = (skuId: string) => Number(freight.skuWeight?.[skuId]) || Number(freight.unitWeight) || null;
	const images = [
		...new Set(
			[...(d.mainImageList ?? []).map((i) => https(typeof i === "string" ? i : (i.fullPathImageURI ?? i))), ...(gallery ?? []).map(https)].filter(Boolean),
		),
	];
	const cost = Number(freight.totalCost);
	const freightOut = {
		costRmb: tags.freeShipping ? 0 : Number.isFinite(cost) && freight.totalCost !== undefined && freight.totalCost !== null ? cost : null,
		to: String(freight.recieveAddress ?? ""),
	};
	const skuMap = t.skuMap ?? [];
	const props = skuMap.length
		? (d.skuProps ?? []).map((p) => ({
				name: p.prop ?? "",
				values: (p.value ?? []).map((v) => ({ name: unescapeHtml(v.name), image: v.imageUrl ?? "" })),
			}))
		: [];
	const valueImages = new Map<string, string>((props[0]?.values ?? []).map((v) => [v.name, https(v.image)]));
	const first = d.mainImageList?.[0];
	const skus: Sku[] = skuMap.length
		? skuMap.map((s) => {
				const attrs = unescapeHtml(s.specAttrs ?? "").split(">");
				return {
					skuId: s.skuId,
					specId: s.specId ?? SpecId.parse(""),
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
					skuId: SkuId.parse(t.offerId),
					specId: SpecId.parse(""),
					name: "",
					attrs: [],
					price: Number(t.minPrice),
					stock: Number(t.canBookedAmount ?? 0),
					image: (typeof first === "object" ? first.fullPathImageURI : undefined) ?? "",
					weightKg: weightOf(t.offerId),
				},
			];
	return {
		offerId: t.offerId,
		url,
		title: d.subject,
		image: images[0] ?? "",
		unit: t.unit ?? "",
		minQty: Number(t.beginAmount ?? 1),
		props,
		skus,
		images,
		detailUrl: https(d.detailUrl ?? descriptionUrl) || null,
		tags,
		freight: freightOut,
	};
}

type OfferWindow = {
	context?: {
		result?: { global?: { globalData?: { model?: Record<string, unknown> & { detailDescription?: { freightInfo?: unknown } } } }; data?: OfferData };
	};
};
type OfferData = { gallery?: { fields?: { mainImage?: unknown[] } }; description?: { fields?: { detailUrl?: string } } };

export async function offer(offerId: OfferId): Promise<Offer> {
	const p = await page("https://detail.1688.com");
	await p.goto(`https://detail.1688.com/offer/${offerId}.html`);
	// 页面里只取要用的几块原样带回来（解析在 offerOf）；包邮、48 小时发货这几个标记是在整个 model 的 JSON 和页面的字里找的，在页面里算
	const got = await p.run(() => {
		const ctx = (window as unknown as OfferWindow).context?.result;
		const m = ctx?.global?.globalData?.model;
		if (!m?.tradeModel)
			return location.href.includes("login") || location.href.includes("punish")
				? { error: "1688 要登录或要过滑块：在浏览器里处理一下" }
				: { gone: true as const };
		let json = "";
		try {
			json = JSON.stringify(m);
		} catch {}
		const text = String(document.body?.innerText ?? "");
		const days = /"deliveryLimit":(\d+)/.exec(json);
		return {
			page: {
				tradeModel: m.tradeModel,
				offerDetail: m.offerDetail,
				freightInfo: m.detailDescription?.freightInfo,
				gallery: ctx?.data?.gallery?.fields?.mainImage,
				descriptionUrl: ctx?.data?.description?.fields?.detailUrl,
				tags: {
					onePsale: /"isOnePsale":true/.test(json) || /一件代发/.test(json + text),
					freeShipping: /"freeDeliverFee":true/.test(json),
					ship48h: (days !== null && Number(days[1]) <= 2) || /"serviceName":"(?:24|48)小时发货"/.test(json),
					deliveryDays: days ? Number(days[1]) : null,
				},
			},
		};
	});
	if ("error" in got) throw new NeedsHuman(`读 1688 商品 ${offerId}：${got.error}`);
	if ("gone" in got) throw new Gone(`1688 商品 ${offerId} 不存在或已下架`);
	return offerOf(got.page, offerId);
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
	} catch {}
	const urls = [...html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]!.replace(/^\/\//, "https://")).filter((u) => /^https:\/\//.test(u));
	return [...new Set(urls)].slice(0, 40);
}

// 购物车、加购、采购单、物流都在页面里用页面自己的 lib.mtop.request 发（签名由它算）。依据 lilto 的 packages/presets/src/1688.ts（2026-09-24 读的 mtop.js 源码）：
// 站点回 SUCCESS 时 resolve；站点回别的 ret 时 reject 整个响应（带 api）；库自己超时、解析失败时 reject 的对象没有 api，这时请求可能已经到了站点
type MtopWindow = { lib?: { mtop?: { request: (o: Record<string, unknown>) => Promise<{ data: unknown }> } } };

type Mtop =
	| { kind: "ok"; data: unknown }
	| { kind: "site"; ret: string }
	| { kind: "unknown"; ret: string }
	| { kind: "blocked"; ret: string; challenge?: boolean };

async function mtop(url: string, api: string, data: Record<string, string>): Promise<Mtop> {
	const u = new URL(url);
	const p = await page(u.origin);
	try {
		if (!(await p.run((path: string) => location.pathname === path && Boolean((window as unknown as MtopWindow).lib?.mtop), u.pathname))) await p.goto(url);
	} catch (e) {
		if (e instanceof Challenge) return { kind: "blocked", ret: e.message, challenge: true };
		throw e;
	}
	const r = await p.run(
		async (api: string, data: Record<string, string>) => {
			if (/login|passport|punish/.test(location.href)) return { kind: "blocked" as const, ret: "1688 要登录：在浏览器里登录 1688" };
			const lib = (window as unknown as MtopWindow).lib;
			if (!lib?.mtop) return { kind: "site" as const, ret: "页面没加载好（没有 lib.mtop），没有发请求" };
			try {
				const res = await lib.mtop.request({ api, v: "1.0", type: "post", dataType: "json", H5Request: true, timeout: 20000, data });
				return { kind: "ok" as const, data: res.data };
			} catch (err) {
				const e = err as { ret?: string[]; api?: string } | null;
				const ret = (e?.ret ?? []).join("，") || String(err);
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

/** 发一个读的 mtop 请求，回原样的 data（各接口的 …Of 解析） */
async function read(url: string, api: string, data: Record<string, string>, what: string): Promise<unknown> {
	const r = await mtop(url, api, data);
	if (r.kind === "blocked" && r.challenge) throw new Challenge(r.ret);
	if (r.kind === "blocked") throw new NeedsHuman(`${what}：${r.ret}`);
	if (r.kind !== "ok") throw new Error(`${what}：${r.ret}`);
	return r.data;
}

/** 登录着的 1688 账号：userId 唯一且不变；loginId 是会员名（能改，只给人看）。首页服务端渲染的 loginStore */
/** cookie __cn_logon__ 说登录着没有（纯函数）：true、false；没有这个 cookie（读不了、没去过 1688）是 null */
export function alibabaCookie(jar: Map<string, string> | null): boolean | null {
	const v = jar?.get("__cn_logon__");
	return v === "true" ? true : v === "false" ? false : null;
}

const loginStore = z.looseObject({ isLogin: z.boolean().nullish(), userId: idText.nullish(), loginId: idText.nullish() }).nullable();
type HomeWindow = { __ICE_APP_CONTEXT__?: { loaderData?: Record<string, { data?: { loginStore?: unknown } } | undefined> } };

/** 首页的 loginStore → 账号（纯函数）；没登录是 null */
export function accountOf(raw: unknown): { userId: string; loginId: string } | null {
	const u = reply(loginStore, raw, "1688 首页的 loginStore");
	return u?.isLogin === true && u.userId ? { userId: u.userId, loginId: u.loginId ?? "" } : null;
}

export async function account(): Promise<{ userId: string; loginId: string }> {
	const p = await page("https://www.1688.com");
	await p.goto("https://www.1688.com/");
	const a = accountOf(await p.run(() => (window as unknown as HomeWindow).__ICE_APP_CONTEXT__?.loaderData?.["/"]?.data?.loginStore ?? null));
	if (!a) throw new NeedsHuman("1688 没有登录：在浏览器里登录 1688");
	return a;
}

export type SearchHit = { offerId: string; url: string; title: string; price: number; minQty: number; sold: string; shop: string; image: string };

/** 2026-10-09 查过：一页 60 个，先只出 10 来个，往下滚才一批批加载；价格拆成几段（¥、0、.03），要读整个 .price-item；
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
			window.scrollTo(0, document.body.scrollHeight);
			const text = (el: Element | null) => ((el as HTMLElement | null)?.innerText ?? "").trim();
			return {
				hits: cards
					.map((card) => {
						// 广告卡片的链接里没有商品 id（offer id）：跳过
						const offerId = card.href.match(/\/offer\/(\d+)\.html/)?.[1] ?? card.href.match(/offerId=(\d+)/)?.[1] ?? "";
						const descs = [...card.querySelectorAll('[class*="descText--"], .desc-text')].map(text);
						const min = descs.find((v) => /^[≥>]\s*\d/.test(v) || /\d+\s*件起批/.test(v)) || text(card.querySelector('[class*="hoverPriceQty--"]'));
						const sold = descs.find((v) => /^(?:全网)?\d[\d.+万]*件$/.test(v)) || "";
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

export type CartLine = { offerId: OfferId; skuId: SkuId; quantity: number };

/** 购物车：data.model 是一串 JSON，里面 data 的每一块有 type（item 是一个规格，root 是汇总） */
const cartModel = z.object({ data: z.record(z.string(), z.looseObject({ type: z.string().nullish(), fields: z.unknown().optional() })) });
const cartItem = z.object({ offerId: idText.pipe(OfferId), skuId: idText.pipe(SkuId).nullish(), quantity: numeric });
const cartRoot = z.looseObject({ totalSkuCount: numeric.nullish() }).nullish();

/** 购物车 render 的回包 → 每个规格和件数（纯函数） */
export function cartOf(data: unknown): CartLine[] {
	const { model } = reply(z.looseObject({ model: z.string() }), data, "1688 购物车（MtopPurchaseAstoreService.render）");
	const parts = Object.values(reply(cartModel, JSON.parse(model), "1688 购物车（render 的 model）").data);
	const items = reply(
		z.array(cartItem),
		parts.filter((x) => x.type === "item").map((x) => x.fields),
		"1688 购物车的规格（render 的 model 里 type 是 item 的 fields）",
	).map((f) => ({ offerId: f.offerId, skuId: f.skuId ?? SkuId.parse(f.offerId), quantity: f.quantity }));
	const root = reply(cartRoot, parts.find((x) => x.type === "root")?.fields, "1688 购物车的汇总（type 是 root 的 fields）");
	const total = Number(root?.totalSkuCount ?? items.length);
	if (items.length < total) throw new Error(`购物车有 ${total} 个规格，只读到 ${items.length} 个（没有做翻页）`);
	return items;
}

export async function cart(): Promise<CartLine[]> {
	return cartOf(
		await read(
			"https://cart.1688.com/cart.htm",
			"mtop.1688.buycenter.MtopPurchaseAstoreService.render",
			{ fromkv: "", purchaseType: "main_purchase_type", platformType: "PC" },
			"读 1688 购物车",
		),
	);
}

export type AddResult = { kind: "sent" } | { kind: "refused"; why: string } | { kind: "blocked"; why: string } | { kind: "unknown"; why: string };

/** 把一个规格加进购物车（addCargo，在这个商品的详情页里发）。只有一个规格的商品 specId 是空字符串。
 * 同一个规格加两次，购物车里是两倍：结果未知时调用方不许重发。 */
export async function addToCart(offerId: OfferId, specId: SpecId, quantity: number): Promise<AddResult> {
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
	raw: unknown;
};

export function addressOf(o: unknown): string {
	const found: string[] = [];
	const walk = (v: unknown, key: string, depth: number) => {
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

const text = z.union([z.string(), z.number()]).nullish();
const entry = z.looseObject({
	sourceId: text,
	specId: text,
	skuId: text,
	productName: text,
	specInfo: z.looseObject({ specItems: z.array(z.looseObject({ specValue: z.unknown().optional() })).nullish() }).nullish(),
	quantity: z.union([z.looseObject({ realAmount: numeric.nullish(), calAmount: numeric.nullish() }), numeric]).nullish(),
	price: numeric.nullish(),
	entryStatus: text,
	entryStatusLabel: text,
	entryExtension: z
		.looseObject({
			receivedQuantity: numeric.nullish(),
			refundId: text,
			refundStatus: text,
			refundIdForAs: text,
			refundStatusForAs: text,
			trackingNo: text,
			sendgt: text,
		})
		.nullish(),
});
/** 一张采购单（金额是分；采购单号用 idStr） */
const buyerOrder = z.looseObject({
	idStr: z.string().nullish(),
	id: z.union([z.string(), z.number()]).nullish(),
	status: text,
	statusLabel: text,
	gmtCreate: text,
	gmtPayment: text,
	sumProductPayment: numeric.nullish(),
	carriage: numeric.nullish(),
	allPromotionFee: numeric.nullish(),
	sumPayment: numeric.nullish(),
	orderEntries: z.array(entry).nullish(),
});
/** 采购单列表：data.result 是一串 JSON，里面 data.data 是采购单 */
const buyerOrderList = z.looseObject({
	data: z.looseObject({ total: numeric.nullish(), pages: numeric.nullish(), data: z.array(z.unknown()).nullish() }).nullish(),
});

const str = (v: string | number | null | undefined) => String(v ?? "");

/** 采购单列表的回包 → 采购单（纯函数）。raw 是这张采购单原样的一行 */
export function buyerOrdersOf(data: unknown): { total: number; pages: number; rows: BuyerOrder[] } {
	const { data: d } = reply(z.looseObject({ data: z.looseObject({ result: z.string().nullish() }).nullish() }), data, "1688 采购单列表（dataline.service）");
	const payload = reply(buyerOrderList, JSON.parse(d?.result ?? "null"), "1688 采购单列表（result）")?.data;
	const yuan = (v: number | null | undefined) => Number(v ?? 0) / 100;
	const rows = (payload?.data ?? []).map((raw, n): BuyerOrder => {
		const o = reply(buyerOrder, raw, `1688 采购单列表的第 ${n + 1} 张`);
		return {
			orderId: String(o.idStr ?? o.id),
			status: str(o.status),
			statusLabel: str(o.statusLabel),
			createdAt: str(o.gmtCreate),
			paidAt: o.gmtPayment ? Number(o.gmtPayment) : null,
			goods: yuan(o.sumProductPayment),
			freight: yuan(o.carriage),
			discount: yuan(o.allPromotionFee),
			paid: yuan(o.sumPayment),
			address: addressOf(raw),
			raw,
			items: (o.orderEntries ?? []).map((e) => {
				const x = e.entryExtension;
				const q = e.quantity;
				return {
					offerId: str(e.sourceId),
					specId: str(e.specId),
					skuId: str(e.skuId),
					name: str(e.productName),
					spec: (e.specInfo?.specItems ?? []).map((i) => i.specValue).join(" / "),
					quantity: Number((typeof q === "object" && q !== null ? (q.realAmount ?? q.calAmount ?? q) : q) ?? 0),
					price: yuan(e.price),
					status: str(e.entryStatus),
					statusLabel: str(e.entryStatusLabel),
					received: Number(x?.receivedQuantity ?? 0),
					// 售中退款在 refundId / refundStatus，售后（确认收货以后申请的）在 refundIdForAs / refundStatusForAs（2026-10-09 读页面的 JS、对真退款单核对过，见同目录的 NOTES.md）
					refund: x?.refundIdForAs
						? { id: String(x.refundIdForAs), stage: "售后", status: str(x.refundStatusForAs) }
						: x?.refundId
							? { id: String(x.refundId), stage: "售中", status: str(x.refundStatus) }
							: null,
					trackingNo: str(x?.trackingNo),
					shippedAt: x?.sendgt ? Number(x.sendgt) : null,
				};
			}),
		};
	});
	return { total: Number(payload?.total ?? rows.length), pages: Number(payload?.pages ?? 1), rows };
}

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
	return buyerOrdersOf(data);
}

/** 一张退款单的状态。status：waitselleragree 等卖家同意、waitbuyermodify 卖家拒绝等买家修改、waitbuyersend 等买家寄回、
 * waitsellerreceive 等卖家收货、refundsuccess 成功、refundclose 关闭（后两个是终态）。同一个状态码中文会变（退款成功、极速退款成功），判断用状态码 */
export type Refund = {
	refundId: string;
	status: string;
	statusLabel: string;
	kind: string;
	amount: number;
	returnTrackingNo: string | null;
	returnLogistics: string | null;
	createdAt: string;
	updatedAt: string;
};

const refundDetail = z.looseObject({
	model: z.looseObject({
		status: z.string().min(1),
		statusLabel: text,
		refundSceneModel: z.looseObject({ replaceNew: z.unknown().optional(), reshipping: z.unknown().optional() }).nullish(),
		needReturnGoods: z.unknown().optional(),
		refundPayment: numeric.nullish(),
		refundCarriage: numeric.nullish(),
		selfReturnGoodsLogisticModel: z.looseObject({ freightBill: text, logisticsStatus: text }).nullish(),
		gmtCreate: text,
		gmtModified: text,
	}),
});

/** 退款单详情的回包 → Refund（纯函数） */
export function refundOf(refundId: string, data: unknown): Refund {
	const m = reply(refundDetail, data, `1688 退款单 ${refundId}（viewRefundDetail）`).model;
	const scene = m.refundSceneModel;
	const back = m.selfReturnGoodsLogisticModel;
	return {
		refundId,
		status: m.status,
		statusLabel: str(m.statusLabel),
		kind: scene?.replaceNew ? "换货" : scene?.reshipping ? "补寄" : m.needReturnGoods ? "退货退款" : "仅退款",
		amount: (Number(m.refundPayment ?? 0) + Number(m.refundCarriage ?? 0)) / 100,
		returnTrackingNo: back?.freightBill ? String(back.freightBill) : null,
		returnLogistics: back?.logisticsStatus ? String(back.logisticsStatus) : null,
		createdAt: str(m.gmtCreate),
		updatedAt: str(m.gmtModified),
	};
}

export async function refund(refundId: string, stage: "售中" | "售后"): Promise<Refund> {
	const d = await read(
		BUYER_ORDERS,
		"mtop.alibaba.cbu.refund.MtopRefundView.viewRefundDetail",
		{ refundId, disputeType: stage === "售中" ? "1" : "2" },
		`读 1688 退款单 ${refundId}`,
	);
	return refundOf(refundId, d);
}

export type Trace = { orderId: string; traces: { status: string; trackingNo: string; logisticsId: string; remark: string }[] };

const traceReply = z.looseObject({
	result: z
		.array(
			z.looseObject({
				orderId: text,
				trace: z.array(z.looseObject({ mailNo: text, currentStatus: text, logisticsId: text, remark: text })).nullish(),
			}),
		)
		.nullish(),
});

/** 物流轨迹的回包对回采购单（纯函数）。回包里的订单号会被当成数字丢精度、顺序也不稳：订单号对不上时只用运单号反查唯一的一条，不按位置猜 */
export function tracesOf(orders: { orderId: string; trackingNos?: string[] }[], data: unknown): Trace[] {
	const raw = reply(traceReply, data, "1688 物流（querytrace）").result ?? [];
	return orders.map(({ orderId, trackingNos = [] }) => {
		const exact = raw.find((c) => str(c.orderId) === orderId);
		const byNo = trackingNos.length ? raw.filter((c) => (c.trace ?? []).some((t) => trackingNos.includes(str(t.mailNo)))) : [];
		const found = exact ?? (byNo.length === 1 ? byNo[0] : undefined);
		return {
			orderId,
			traces: (found?.trace ?? [])
				.filter((t) => t.mailNo)
				.map((t) => ({ status: str(t.currentStatus), trackingNo: String(t.mailNo), logisticsId: str(t.logisticsId), remark: str(t.remark) })),
		};
	});
}

export async function traces(orders: { orderId: string; trackingNos?: string[] }[]): Promise<Trace[]> {
	if (orders.length === 0) return [];
	return tracesOf(
		orders,
		await read(BUYER_ORDERS, "mtop.1688.mtoplgttraceservice.querytrace", { orderIds: orders.map((o) => o.orderId).join(",") }, "读 1688 物流"),
	);
}
