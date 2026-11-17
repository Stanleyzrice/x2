// 核价（纯函数）：店铺设置 → 核价参数；每个规格的售价、重量、库存；缺重量、国内运费时 agent 要估什么；重新核价（不读 1688）；报价（选品用）
import type { Offer } from "../../connectors/sites/1688/api.ts";
import type { Mark } from "./pics.ts";
import { minPrice, type PriceParams, priceParams } from "./price.ts";
import { purchaseLimitOf } from "./purchase-limit.ts";
import type { OfferLike, PriceInput, ShopSettingsRow } from "./row.ts";
import { templateParams, templateUnitPrice } from "./template-pricing.ts";
import { limitProblems, priceRange, type Specs, specsFrom, specsOf, specsText, structureProblems, type Variant } from "./variants.ts";

export function settingsOf(row: ShopSettingsRow) {
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
		template: row.pricing_template == null ? null : templateParams.parse(row.pricing_template),
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

/** 模板启用后由模板独立核价，旧结算模型的最低金额、退损和费率不再叠加。 */
export const pricingPolicy = (s: Settings) =>
	s.template ? { model: "template" as const, params: s.template } : { model: "settlement" as const, params: s.params, preOrder: s.preOrder };

export function variantTemplatePrice(v: Variant, freightRmb: number | null, p: NonNullable<Settings["template"]>, units = 1) {
	const orderFreightRmb = v.pricingInput?.freightRmbPerUnit === undefined ? freightRmb : v.pricingInput.freightRmbPerUnit * units;
	return {
		...templateUnitPrice({ key: v.sku, costRmb: v.costRmb, weightKg: v.weightKg, freightRmb: orderFreightRmb, currentTwd: v.priceTwd, units }, p),
		orderFreightRmb,
	};
}

export function priceVariants(
	variants: Variant[],
	s: Settings,
	opts: { weightKg: number | null; freightRmb: number | null; minimumPurchase?: number },
): Variant[] {
	const units = opts.minimumPurchase ?? s.minPurchase;
	return variants.map((v): Variant => {
		const cleared = { ...v };
		delete cleared.pricingProblem;
		if (v.pricingInput) {
			const explicit: Variant = {
				...cleared,
				costRmb: v.pricingInput.costRmb,
				weightKg: v.pricingInput.chargeableWeightKg,
				priceTwd: v.pricingInput.priceTwd,
				stock: Math.min(v.stock, s.stockCap),
			};
			if (!s.template) explicit.pricingProblem = `核价：${v.sku} 的显式售价缺少模板参数，保留输入待核`;
			else {
				const result = variantTemplatePrice(explicit, opts.freightRmb, s.template, units);
				if (result.missing.length) explicit.pricingProblem = `核价：${v.sku} 缺${result.missing.join("、")}，保留输入待核`;
				else if (!result.current || result.current.margin < s.template.minMargin - 1e-9 || result.current.margin > s.template.maxMargin + 1e-9)
					explicit.pricingProblem = `核价：${v.sku} 指定售价 NT$${explicit.priceTwd} 的毛利率${result.current ? `${(result.current.margin * 100).toFixed(2)}%` : "未知"}不在输入区间${(s.template.minMargin * 100).toFixed(2)}%–${(s.template.maxMargin * 100).toFixed(2)}%，保留输入待核`;
			}
			return explicit;
		}
		const weightKg = v.weightKg && v.weightKg > 0 ? v.weightKg : opts.weightKg;
		const stock = Math.min(v.stock, s.stockCap);
		if (!weightKg || opts.freightRmb === null) return { ...cleared, weightKg, stock, priceTwd: null };
		if (s.template) {
			const r = variantTemplatePrice({ ...v, weightKg }, opts.freightRmb, s.template, units);
			return { ...cleared, weightKg, stock, priceTwd: r.unitTailNine?.min ?? r.unitRange?.min ?? null };
		}
		return { ...cleared, weightKg, stock, priceTwd: minPrice(v.costRmb, opts.freightRmb, weightKg, s.params, s.preOrder) };
	});
}

/** 1688 给的重量小于 20 克的当作没给（见过填 0.001 kg 的，照它核价会定得太低）：空着，交给 agent 往重了估 */
export const MIN_WEIGHT_KG = 0.02;
export const usableWeights = (o: Offer): Offer => ({
	...o,
	skus: o.skus.map((k) => ({ ...k, weightKg: k.weightKg != null && k.weightKg >= MIN_WEIGHT_KG ? k.weightKg : null })),
});

export const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export const freightOf = (offer: OfferLike | null | undefined, column: unknown): number | null =>
	num(column) ?? offer?.freight?.costRmb ?? (offer?.tags?.freeShipping ? 0 : null);

const weightsOf = (offer: OfferLike | null | undefined) => new Map((offer?.skus ?? []).filter((k) => (k.weightKg ?? 0) > 0).map((k) => [k.skuId, k.weightKg!]));

export type Need = "重量" | "国内运费";
export function estimateNeeds(l: PriceInput): Need[] {
	const specs = specsOf(l.variants);
	if (!l.offer || !specs) return [];
	const weights = weightsOf(l.offer);
	const needs: Need[] = [];
	if (num(l.weight_kg) === null && specs.variants.some((v) => !v.pricingInput && !weights.has(v.skuId))) needs.push("重量");
	if (freightOf(l.offer, l.freight_rmb) === null && specs.variants.some((v) => v.pricingInput?.freightRmbPerUnit === undefined)) needs.push("国内运费");
	return needs;
}

export function pricingProblems(specs: Specs, needs: Need[]): string[] {
	if (needs.length) return [`缺${needs.join("、")}：agent 估（x2 listing estimate）`];
	return [
		...(specs.variants.some((v) => v.priceTwd === null) ? ["核价：有规格缺少成本数据或没有满足毛利规则的整数售价"] : []),
		...specs.variants.flatMap((v) => (v.pricingProblem ? [v.pricingProblem] : [])),
		...limitProblems(specs),
	];
}

/** 批发起订量保留原值；只有当前货源支持代发、全部选中规格显式举证时才解决对应 MOQ 告警。 */
export function sourceMoqProblems(offer: OfferLike, specs: Specs, previous: readonly string[] = []): string[] {
	const isMoq = (line: string) => /^货源：起订量 \d+(?:\.\d+)?，(?:无法单件购买|单件代发采购条件待核)$/.test(line);
	const other = previous.filter((line) => !isMoq(line));
	const confirmed =
		offer.tags?.onePsale === true &&
		specs.variants.length > 0 &&
		specs.variants.every((v) => v.pricingInput?.purchaseMode === "single-dropship" && Boolean(v.pricingInput.sourceEvidence?.trim()));
	if (confirmed) return other;
	return [
		...other,
		...((offer.minQty ?? 1) > 1
			? [`货源：起订量 ${offer.minQty}，单件代发采购条件待核`]
			: previous.filter(isMoq).map((line) => line.replace("无法单件购买", "单件代发采购条件待核"))),
	];
}

export function reprice(l: PriceInput, s: Settings): { specs: Specs; freightRmb: number | null; minimumPurchase: number; changed: boolean } | null {
	const specs = specsOf(l.variants);
	if (!l.offer || !specs) return null;
	const weights = weightsOf(l.offer);
	const freightRmb = freightOf(l.offer, l.freight_rmb);
	const minimumPurchase = purchaseLimitOf(l, s.minPurchase);
	const variants = priceVariants(
		specs.variants.map((v) => ({ ...v, weightKg: weights.get(v.skuId) ?? null })),
		s,
		{ weightKg: num(l.weight_kg), freightRmb, minimumPurchase },
	);
	const policy = pricingPolicy(s);
	// jsonb 会重排 key，按 key 比较；老结算快照没存参数时靠重算后的售价判断。
	const paramsChanged = l.pricing?.params
		? JSON.stringify(Object.entries(l.pricing.params).sort()) !== JSON.stringify(Object.entries(policy.params).sort())
		: policy.model === "template";
	const changed =
		(l.pricing?.model ?? "settlement") !== policy.model ||
		paramsChanged ||
		(policy.model === "settlement" && l.pricing?.preOrder !== undefined && l.pricing.preOrder !== policy.preOrder) ||
		(l.pricing?.freightRmb ?? null) !== freightRmb ||
		(l.pricing?.minimumPurchase ?? 1) !== minimumPurchase ||
		variants.some((v, i) => {
			const before = specs.variants[i]!;
			return (
				v.costRmb !== before.costRmb ||
				v.weightKg !== before.weightKg ||
				v.priceTwd !== before.priceTwd ||
				v.stock !== before.stock ||
				v.pricingProblem !== before.pricingProblem
			);
		});
	return { specs: { tiers: specs.tiers, variants }, freightRmb, minimumPurchase, changed };
}

export function specsAndPrices(
	o: Offer,
	s: Settings,
	opts: { removed?: string[]; prev?: Specs | null; weightKg: number | null; freightRmb: number | null; minimumPurchase?: number; originalText?: boolean },
): { specs: Specs; problems: string[] } {
	const built = specsFrom(o, opts.removed ?? [], opts.prev ?? null, { originalText: opts.originalText });
	const specs: Specs = { tiers: built.specs.tiers, variants: priceVariants(built.specs.variants, s, opts) };
	return { specs, problems: [...sourceMoqProblems(o, specs), ...built.problems, ...structureProblems(specs)] };
}

export function quote(o: Offer, s: Settings, assume: { weightKg: number; freightRmb: number }) {
	const read = freightOf(o, null);
	const freightRmb = read ?? assume.freightRmb;
	const { specs, problems } = specsAndPrices(o, s, { weightKg: assume.weightKg, freightRmb });
	const given = new Map(o.skus.map((k) => [k.skuId, k]));
	const list = specs.variants.map((v) => {
		const k = given.get(v.skuId);
		const template = s.template ? variantTemplatePrice(v, freightRmb, s.template, s.minPurchase) : null;
		return {
			sku: v.sku,
			spec: (k?.attrs ?? []).filter(Boolean).join(" / ") || k?.name || "（单规格）",
			priceTwd: v.priceTwd,
			rangeTwd: template?.unitRange ?? null,
			margin: template?.current?.margin ?? null,
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
		pricing: pricingPolicy(s),
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
