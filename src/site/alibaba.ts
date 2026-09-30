// 1688：货源详情、购物车、加购。货源详情是服务端渲染进页面的全局变量（window.context.result.global.globalData.model），打开商品页读它，不用签名。
// 查过的事实（2026-09-30）：tradeModel.skuMap 是规格（specAttrs 用「&gt;」连接几个属性，例「kitty猫款式5&gt;20*30cm【硅藻泥】3mm」）；
// offerDetail.skuProps 是属性（prop，例「颜色」「尺寸」）和它的取值（value: {name, imageUrl}），第一个属性的取值带图片；只有一个规格的货源没有 skuMap
import { page } from "../browser.ts";

/** attrs：每个属性的取值，顺序同 Offer.props */
export type Sku = { skuId: string; specId: string; name: string; attrs: string[]; price: number; stock: number; image: string };
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
	if ("error" in got) throw new Error(`读 1688 货源 ${offerId}：${got.error}`);
	if ("gone" in got) throw new Gone(`1688 货源 ${offerId} 不存在或已下架`);
	return got;
}

// ── 购物车 ──
// 读和加都在页面里用页面自己的 lib.mtop.request 发（签名由它算）。依据 lilto 的 packages/presets/src/1688.ts（2026-09-24 读的 mtop.js 源码）：
// 站点回 SUCCESS 时 resolve；站点回别的 ret 时 reject 整个响应（带 api）；库自己超时、解析失败时 reject 的对象没有 api，这时请求可能已经到了站点

export type CartLine = { offerId: string; skuId: string; quantity: number };


/** 购物车里的全部规格。超过一页读不全时报错（没有做翻页），免得把读了一半当成全部 */
export async function cart(): Promise<CartLine[]> {
	const p = await page("https://cart.1688.com");
	await p.goto("https://cart.1688.com/cart.htm");
	const got = await p.run(async () => {
		if (/login|passport|punish/.test(location.href)) return { error: "1688 要登录或要过滑块：在浏览器里处理一下" };
		const lib = (window as any).lib;
		if (!lib?.mtop) return { error: "购物车页面没加载好（没有 lib.mtop）" };
		try {
			const res = await lib.mtop.request({ api: "mtop.1688.buycenter.MtopPurchaseAstoreService.render", v: "1.0", type: "post", dataType: "json", H5Request: true, timeout: 20000, data: { fromkv: "", purchaseType: "main_purchase_type", platformType: "PC" } });
			const parts = Object.values(JSON.parse(res.data.model).data) as { type: string; fields: any }[];
			const items = parts.filter((x) => x.type === "item").map((x) => ({ offerId: String(x.fields.offerId), skuId: String(x.fields.skuId ?? x.fields.offerId), quantity: Number(x.fields.quantity) }));
			const total = Number(parts.find((x) => x.type === "root")?.fields?.totalSkuCount ?? items.length);
			return items.length < total ? { error: `购物车有 ${total} 个规格，只读到 ${items.length} 个（没有做翻页）` } : { items };
		} catch (e: any) {
			return { error: `读购物车：${(e?.ret ?? [String(e)]).join("，")}` };
		}
	});
	if ("error" in got) throw new Error(got.error);
	return got.items;
}

/** 加购的结果。sent：站点收下了（到底加没加上由调用方回读购物车判断）；refused：站点确定没加；unknown：请求可能到了站点，不知道加没加 */
export type AddResult = { kind: "sent" } | { kind: "refused"; why: string } | { kind: "blocked"; why: string } | { kind: "unknown"; why: string };

/** 把一个规格加进购物车（addCargo，在这个货源的商品页里发）。只有一个规格的货源 specId 是空字符串。
 * 同一个规格加两次，购物车里是两倍：结果未知时调用方不许重发 */
export async function addToCart(offerId: string, specId: string, quantity: number): Promise<AddResult> {
	const p = await page("https://detail.1688.com");
	await p.goto(`https://detail.1688.com/offer/${offerId}.html`);
	return p.run(async (offerId: string, specId: string, quantity: number) => {
		if (/login|passport|punish/.test(location.href)) return { kind: "blocked" as const, why: "1688 要登录或要过滑块：在浏览器里处理一下" };
		const lib = (window as any).lib;
		if (!lib?.mtop) return { kind: "refused" as const, why: "商品页没加载好（没有 lib.mtop），没有发请求" };
		try {
			await lib.mtop.request({
				api: "com.alibaba.china.buy.service.purchase.MtopPurchaseService.addCargo", v: "1.0", type: "post", dataType: "json", H5Request: true, timeout: 20000,
				data: {
					client: "pc", purchaseType: "", attributes: "{}", fromkv: "offerdetail:pc",
					goodsParams: JSON.stringify([{ offerId, specId, quantity, flow: "general", ext: { sceneCode: "" }, selectedTradeServices: [] }]),
				},
			});
			return { kind: "sent" as const };
		} catch (e: any) {
			const ret = ((e?.ret ?? []) as string[]).join("，") || String(e);
			if (!e?.api) return { kind: "unknown" as const, why: ret };
			if (/FAIL_SYS_SESSION_EXPIRED|FAIL_SYS_USER_VALIDATE/.test(ret)) return { kind: "blocked" as const, why: ret };
			// 只有这几种是站点确定没加：业务拒绝、参数不对。别的（系统错误、限流、令牌过期）可能已经加了
			if (/FAIL_BIZ|ILLEGAL|PARAM/.test(ret)) return { kind: "refused" as const, why: ret };
			return { kind: "unknown" as const, why: ret };
		}
	}, offerId, specId, quantity);
}
