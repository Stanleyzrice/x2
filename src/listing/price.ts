// 核价：照 lilto 的 legacy/lib/cost.py（快照 1c8a7926；参数 2026-09-02 依账单和结算截图定）。docs/listing.md「核价」。
// 每个规格一个售价：同时满足「毛利率 ≥ 最低毛利率」和「毛利 ≥ 最低毛利」的最小整数售价（新台币），在 1–499999 上二分找。
// 毛利率的分母是平台预计进账，不是售价。平台费逐项四舍五入再相加；免运方案费有每单最低。没有倍率、没有尾数 9
import { z } from "zod";

/** 店铺设置里的核价参数（一家店一套）。比例都是 0–1 的小数 */
export const priceParams = z.object({
	fx: z.number().positive(), // 汇率：台币 / 元
	pricePerKgRmb: z.number().nonnegative(), // 海快每公斤运费（元）
	labelFeeRmb: z.number().nonnegative(), // 贴单费（元 / 单）
	weightRoundingKg: z.number().nonnegative(), // 重量按多少公斤取整（0.01）
	returnLossRate: z.number().min(0).max(1), // 退货损耗，按售价
	minMarginRate: z.number().min(0).max(1), // 最低毛利率，按进账
	minMarginRmb: z.number().nonnegative(), // 最低毛利（元）
	commissionRate: z.number().min(0).max(1), // 成交手续费
	preOrderRate: z.number().min(0).max(1), // 预售服务费
	paymentRate: z.number().min(0).max(1), // 金流费
	coinRate: z.number().min(0).max(1), // 虾币回馈
	freeShippingRate: z.number().min(0).max(1), // 免运方案费
	freeShippingMinTwd: z.number().nonnegative(), // 免运方案费每单最低（台币）
	shippingNetTwd: z.number(), // 买家付的运费和补贴相抵后的净额（台币）
});
export type PriceParams = z.infer<typeof priceParams>;

/** 平台逐项按元四舍五入（不是银行家舍入） */
const roundTwd = (v: number) => Math.round(v);

/** 海快运费（元）：重量按 0.01 kg 取整 × 每公斤运费 + 贴单费；不算体积重 */
export function shipRmb(kg: number, p: PriceParams): number {
	const w = p.weightRoundingKg > 0 ? Math.round(kg / p.weightRoundingKg) * p.weightRoundingKg : kg;
	return w * p.pricePerKgRmb + p.labelFeeRmb;
}

/** 卖一件的平台预计进账（台币），费用逐项取整 */
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

/** 一件的毛利（元）和毛利率（按进账）。costRmb 是 1688 价，freightRmb 是国内运费（元 / 件） */
export function margin(sellTwd: number, costRmb: number, freightRmb: number, kg: number, p: PriceParams, preOrder: boolean) {
	const { payoutTwd } = payout(sellTwd, p, preOrder);
	const landedTwd = (costRmb + freightRmb + shipRmb(kg, p)) * p.fx;
	const marginTwd = payoutTwd - landedTwd - sellTwd * p.returnLossRate;
	return { profitRmb: marginTwd / p.fx, rate: payoutTwd > 0 ? marginTwd / payoutTwd : Number.NaN, payoutTwd, landedTwd };
}

/** 最低售价（台币整数）：两道门都过的最小整数价；最高价都过不了回 null */
export function minPrice(costRmb: number, freightRmb: number, kg: number, p: PriceParams, preOrder: boolean): number | null {
	const passes = (t: number) => {
		const m = margin(t, costRmb, freightRmb, kg, p, preOrder);
		return m.rate >= p.minMarginRate && m.profitRmb >= p.minMarginRmb;
	};
	let low = 1, high = 499_999;
	if (!passes(high)) return null;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (passes(mid)) high = mid;
		else low = mid + 1;
	}
	return low;
}
