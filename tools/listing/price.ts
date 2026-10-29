// 核价：照 lilto 的 legacy/lib/cost.py（快照 1c8a7926；参数 2026-09-02 依账单和结算截图定）。
// 每个规格一个售价：同时满足「毛利率 ≥ 最低毛利率」和「毛利 ≥ 最低毛利」的最小整数售价（新台币），在 1–499999 上二分找。
// 毛利率的分母是平台预计进账，不是售价。平台费逐项四舍五入再相加；免运方案费有每单最低。没有倍率、没有尾数 9
import { z } from "zod";

export const priceParams = z.object({
	fx: z.number().positive(),
	pricePerKgRmb: z.number().nonnegative(),
	labelFeeRmb: z.number().nonnegative(),
	weightRoundingKg: z.number().nonnegative(),
	returnLossRate: z.number().min(0).max(1),
	minMarginRate: z.number().min(0).max(1),
	minMarginRmb: z.number().nonnegative(),
	commissionRate: z.number().min(0).max(1),
	preOrderRate: z.number().min(0).max(1),
	paymentRate: z.number().min(0).max(1),
	coinRate: z.number().min(0).max(1),
	freeShippingRate: z.number().min(0).max(1),
	freeShippingMinTwd: z.number().nonnegative(),
	shippingNetTwd: z.number(),
});
export type PriceParams = z.infer<typeof priceParams>;

/** 平台逐项按元四舍五入（不是银行家舍入） */
const roundTwd = (v: number) => Math.round(v);

export function shipRmb(kg: number, p: PriceParams): number {
	const w = p.weightRoundingKg > 0 ? Math.round(kg / p.weightRoundingKg) * p.weightRoundingKg : kg;
	return w * p.pricePerKgRmb + p.labelFeeRmb;
}

export function payout(sellTwd: number, p: PriceParams, preOrder: boolean) {
	if (!Number.isInteger(sellTwd) || sellTwd <= 0) throw new Error(`售价要是正整数台币：${sellTwd}`);
	const fees = {
		commission: roundTwd(sellTwd * p.commissionRate),
		preOrder: preOrder ? roundTwd(sellTwd * p.preOrderRate) : 0,
		payment: roundTwd(sellTwd * p.paymentRate),
		coin: roundTwd(sellTwd * p.coinRate),
		freeShipping: Math.max(roundTwd(sellTwd * p.freeShippingRate), p.freeShippingMinTwd),
	};
	const total = fees.commission + fees.preOrder + fees.payment + fees.coin + fees.freeShipping;
	return { payoutTwd: sellTwd - total + p.shippingNetTwd, feeTwd: total, fees };
}

export function margin(sellTwd: number, costRmb: number, freightRmb: number, kg: number, p: PriceParams, preOrder: boolean) {
	const { payoutTwd } = payout(sellTwd, p, preOrder);
	const landedTwd = (costRmb + freightRmb + shipRmb(kg, p)) * p.fx;
	const marginTwd = payoutTwd - landedTwd - sellTwd * p.returnLossRate;
	return { profitRmb: marginTwd / p.fx, rate: payoutTwd > 0 ? marginTwd / payoutTwd : Number.NaN, payoutTwd, landedTwd };
}

export function minPrice(costRmb: number, freightRmb: number, kg: number, p: PriceParams, preOrder: boolean): number | null {
	const passes = (t: number) => {
		const m = margin(t, costRmb, freightRmb, kg, p, preOrder);
		return m.rate >= p.minMarginRate && m.profitRmb >= p.minMarginRmb;
	};
	let low = 1,
		high = 499_999;
	if (!passes(high)) return null;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (passes(mid)) high = mid;
		else low = mid + 1;
	}
	return low;
}
