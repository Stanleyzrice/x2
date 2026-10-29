// 核价（纯函数）：店铺设置 → 核价参数；每个规格的售价、重量、库存；缺重量、国内运费时 agent 要估什么；重新核价（不读 1688）；报价（选品用）
import type { Offer } from "../../connectors/sites/1688/api.ts";
import type { Mark } from "./pics.ts";
import { minPrice, type PriceParams, priceParams } from "./price.ts";
import { limitProblems, priceRange, type Specs, specsFrom, specsOf, specsText, structureProblems, type Variant } from "./variants.ts";

export function settingsOf(row: any) {
	const n = (v: unknown) => Number(v);
	const params: PriceParams = priceParams.parse({
		fx: n(row.fx),
		pricePerKgRmb: n(row.price_per_kg_rmb),
		labelFeeRmb: n(row.label_fee_rmb),
		weightRoundingKg: n(row.weight_rounding_kg),
		returnLossRate: n(row.return_loss_rate),
		minMarginRate: n(row.min_margin_rate),
		minMarginRmb: n(row.min_margin_rmb),
		commissionRate: n(row.commission_rate),
		preOrderRate: n(row.pre_order_rate),
		paymentRate: n(row.payment_rate),
		coinRate: n(row.coin_rate),
		freeShippingRate: n(row.free_shipping_rate),
		freeShippingMinTwd: n(row.free_shipping_min_twd),
		shippingNetTwd: n(row.shipping_net_twd),
	});
	const mark: Mark | null = row.watermark_text
		? { text: row.watermark_text, size: n(row.watermark_size), opacity: n(row.watermark_opacity), position: row.watermark_position }
		: null;
	return {
		shop: String(row.shop),
		shopId: String(row.shop_id),
		params,
		mark,
		paused: row.paused ? String(row.paused) : null,
		preOrder: Boolean(row.pre_order),
		minPurchase: n(row.min_purchase),
		stockCap: n(row.stock_cap),
		channels: String(row.channels ?? "")
			.split(/[,，\s]+/)
			.filter(Boolean),
		categories: Array.isArray(row.categories) && row.categories.length ? new Set((row.categories as unknown[]).map(String)) : null,
	};
}
export type Settings = ReturnType<typeof settingsOf>;

export function priceVariants(variants: Variant[], s: Settings, opts: { weightKg: number | null; freightRmb: number | null }): Variant[] {
	return variants.map((v): Variant => {
		const weightKg = v.weightKg && v.weightKg > 0 ? v.weightKg : opts.weightKg;
		const stock = Math.min(v.stock, s.stockCap);
		if (!weightKg || opts.freightRmb === null) return { ...v, weightKg, stock, priceTwd: null };
		return { ...v, weightKg, stock, priceTwd: minPrice(v.costRmb, opts.freightRmb, weightKg, s.params, s.preOrder) };
	});
}

export const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export const freightOf = (offer: Partial<Offer> | null | undefined, column: unknown): number | null =>
	num(column) ?? offer?.freight?.costRmb ?? (offer?.tags?.freeShipping ? 0 : null);

const weightsOf = (offer: Partial<Offer> | null | undefined) =>
	new Map((offer?.skus ?? []).filter((k) => (k.weightKg ?? 0) > 0).map((k) => [k.skuId, k.weightKg!]));

export type Need = "重量" | "国内运费";
export function estimateNeeds(l: any): Need[] {
	const specs = specsOf(l.variants);
	if (!l.offer || !specs) return [];
	const weights = weightsOf(l.offer);
	const needs: Need[] = [];
	if (num(l.weight_kg) === null && specs.variants.some((v) => !weights.has(v.skuId))) needs.push("重量");
	if (freightOf(l.offer, l.freight_rmb) === null) needs.push("国内运费");
	return needs;
}

export function pricingProblems(specs: Specs, needs: Need[]): string[] {
	if (needs.length) return [`缺${needs.join("、")}：agent 估（x2 listing estimate）`];
	return [...(specs.variants.some((v) => v.priceTwd === null) ? ["核价：有规格怎么定价都过不了毛利的两道门"] : []), ...limitProblems(specs)];
}

export function reprice(l: any, s: Settings): { specs: Specs; freightRmb: number | null; changed: boolean } | null {
	const specs = specsOf(l.variants);
	if (!l.offer || !specs) return null;
	const weights = weightsOf(l.offer);
	const freightRmb = freightOf(l.offer, l.freight_rmb);
	const variants = priceVariants(
		specs.variants.map((v) => ({ ...v, weightKg: weights.get(v.skuId) ?? null })),
		s,
		{ weightKg: num(l.weight_kg), freightRmb },
	);
	const changed = (l.pricing?.freightRmb ?? null) !== freightRmb || variants.some((v, i) => v.weightKg !== specs.variants[i]!.weightKg);
	return { specs: { tiers: specs.tiers, variants }, freightRmb, changed };
}

export function specsAndPrices(
	o: Offer,
	s: Settings,
	opts: { removed?: string[]; prev?: Specs | null; weightKg: number | null; freightRmb: number | null },
): { specs: Specs; problems: string[] } {
	const built = specsFrom(o, opts.removed ?? [], opts.prev ?? null);
	const specs: Specs = { tiers: built.specs.tiers, variants: priceVariants(built.specs.variants, s, { weightKg: opts.weightKg, freightRmb: opts.freightRmb }) };
	return { specs, problems: [...(o.minQty > 1 ? [`货源：起订量 ${o.minQty}，无法单件购买`] : []), ...built.problems, ...structureProblems(specs)] };
}

export function quote(o: Offer, s: Settings, assume: { weightKg: number; freightRmb: number }) {
	const read = freightOf(o, null);
	const freightRmb = read ?? assume.freightRmb;
	const { specs, problems } = specsAndPrices(o, s, { weightKg: assume.weightKg, freightRmb });
	const given = new Map(o.skus.map((k) => [k.skuId, k]));
	const list = specs.variants.map((v) => {
		const k = given.get(v.skuId);
		return {
			sku: v.sku,
			spec: (k?.attrs ?? []).filter(Boolean).join(" / ") || k?.name || "（单规格）",
			priceTwd: v.priceTwd,
			weightKg: v.weightKg,
			weightAssumed: !((k?.weightKg ?? 0) > 0),
			costRmb: v.costRmb,
			stock: v.stock,
		};
	});
	const guessed = list.filter((x) => x.weightAssumed).length;
	return {
		offerId: o.offerId,
		url: o.url,
		title: o.title,
		shop: s.shop,
		minQty: o.minQty,
		tags: {
			onePsale: Boolean(o.tags?.onePsale),
			ship48h: Boolean(o.tags?.ship48h),
			freeShipping: Boolean(o.tags?.freeShipping),
			deliveryDays: o.tags?.deliveryDays ?? null,
		},
		freightRmb,
		freightAssumed: read === null,
		weightAssumed: guessed ? `${guessed} 个规格 1688 没给重量，按 ${assume.weightKg} kg 算` : null,
		variants: list.length,
		priceTwd: priceRange(specs.variants),
		specs: specsText(specs),
		list,
		problems: [...problems, ...pricingProblems(specs, [])],
	};
}
