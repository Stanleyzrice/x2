// 1688。货源详情是服务端渲染进页面的全局变量（window.context.result.global.globalData.model），打开商品页读它，不用签名。
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

export async function offer(offerId: string): Promise<Offer> {
	const url = `https://detail.1688.com/offer/${offerId}.html`;
	const p = await page("https://detail.1688.com");
	await p.goto(url);
	const got = await p.run((url: string) => {
		const m = (window as any).context?.result?.global?.globalData?.model;
		if (!m?.tradeModel) return { error: location.href.includes("login") || location.href.includes("punish") ? "1688 要登录或要过滑块：在浏览器里处理一下" : "货源不存在或已下架" };
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
	return got;
}
