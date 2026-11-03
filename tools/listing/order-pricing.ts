// 整单金额计算：汇总调用方提供的商品、费用、优惠和金额下限；返回数值及比较结果。
import { z } from "zod";
import { roundUpNine, type TemplateParams, templatePrice } from "./template-pricing.ts";

export const orderPricingInput = z.object({
	items: z
		.array(
			z.object({
				key: z.string().min(1),
				priceTwd: z.number().positive(),
				units: z.number().int().positive(),
				costRmb: z.number().nonnegative().nullable(),
				weightKg: z.number().positive().nullable(),
			}),
		)
		.min(1)
		.max(1000),
	freightRmb: z.number().nonnegative().nullable().describe("整单国内运费；多个货源须合计，未知填 null"),
	sellerDiscountTwd: z.number().nonnegative().nullable().describe("整单卖家承担的优惠合计；明确无优惠才填 0，未知填 null"),
	minimumTwd: z.number().nonnegative().default(0).describe("用于比较的商品金额下限，TWD"),
});
export type OrderPricingInput = z.output<typeof orderPricingInput>;

export function orderPrice(input: OrderPricingInput, p: TemplateParams) {
	const missing = input.items.flatMap((v) => [...(v.costRmb === null ? [`${v.key}：进货成本`] : []), ...(v.weightKg === null ? [`${v.key}：计费重量`] : [])]);
	if (input.freightRmb === null) missing.push("整单国内运费");
	if (input.sellerDiscountTwd === null) missing.push("卖家承担的优惠");
	const grossTwd = input.items.reduce((n, v) => n + v.priceTwd * v.units, 0);
	const paidTwd = input.sellerDiscountTwd === null ? null : grossTwd - input.sellerDiscountTwd;
	const costRmb = input.items.some((v) => v.costRmb === null) ? null : input.items.reduce((n, v) => n + v.costRmb! * v.units, 0);
	const weightKg = input.items.some((v) => v.weightKg === null) ? null : input.items.reduce((n, v) => n + v.weightKg! * v.units, 0);
	const r = templatePrice(
		{ key: "order", currentTwd: paidTwd !== null && paidTwd > 0 ? paidTwd : null, costRmb, weightKg, freightRmb: input.freightRmb, units: 1 },
		p,
	);
	const netRmb = paidTwd === null ? null : (paidTwd * (1 - p.feeRate)) / p.fx;
	const profitRmb = netRmb === null || r.totalCostRmb === null ? null : netRmb - r.totalCostRmb;
	const minimumMet = paidTwd === null ? null : paidTwd >= input.minimumTwd;
	const nonLoss = profitRmb === null ? null : profitRmb >= -1e-9;
	const margin = netRmb !== null && netRmb > 0 && profitRmb !== null ? profitRmb / netRmb : null;
	const withinTarget = margin === null ? null : margin >= p.minMargin - 1e-9 && margin <= p.maxMargin + 1e-9;
	const low = r.range === null ? null : Math.max(r.range.min, Math.ceil(input.minimumTwd));
	const range = low !== null && r.range !== null && low <= r.range.max ? { min: low, max: r.range.max } : null;
	const firstNine = range === null ? null : roundUpNine(range.min);
	const suggestedPaidTwd = firstNine !== null && range !== null && firstNine <= range.max ? firstNine : (range?.min ?? null);
	const problems = [...missing.map((x) => `缺${x}`), ...(paidTwd !== null && paidTwd < 0 ? ["卖家优惠超过商品总额"] : [])];
	return {
		status: missing.length ? "DATA_INSUFFICIENT" : paidTwd !== null && paidTwd < 0 ? "INVALID_INPUT" : "CALCULATED",
		missing,
		grossTwd,
		paidTwd,
		netRmb,
		totalCostRmb: r.totalCostRmb,
		profitRmb,
		margin,
		minimumTwd: input.minimumTwd,
		minimumMet,
		nonLoss,
		withinTarget,
		rangeTwd: range,
		suggestedPaidTwd,
		problems,
	};
}
