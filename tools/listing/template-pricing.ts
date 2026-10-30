// 运营提供的定价模板：毛利率 = 毛利 / 扣平台费后的到手金额。只做建议，不改原有核价参数、商品稿或站点。
// 模板按单一百分比费率计算，没有逐项台币取整、最低毛利、退损；与 price.ts 的结算模型分开，不能冒充真实结算利润。
import { z } from "zod";

export const templateParams = z
	.object({
		fx: z.coerce.number().positive().default(4.8).describe("TWD/RMB，模板假设汇率"),
		feeRate: z.coerce.number().min(0).lt(1).default(0.16).describe("平台综合费率，模板假设值"),
		freightPerKgRmb: z.coerce.number().nonnegative().default(10).describe("每 kg 头程运费，人民币"),
		labelFeeRmb: z.coerce.number().nonnegative().default(1.5).describe("每订单贴单费，人民币"),
		minMargin: z.coerce.number().min(0).lt(1).default(0.15).describe("到手金额口径的目标毛利率下限"),
		maxMargin: z.coerce.number().min(0).lt(1).default(0.2).describe("到手金额口径的目标毛利率上限"),
	})
	.refine((p) => p.maxMargin >= p.minMargin, { message: "毛利率上限不能低于下限", path: ["maxMargin"] });
export type TemplateParams = z.output<typeof templateParams>;

export const templateItem = z.object({
	key: z.string().min(1).describe("报告行标记，例 店铺:商品:规格"),
	currentTwd: z.number().positive().nullable().default(null).describe("当前售价，台币；未知填 null"),
	costRmb: z.number().nonnegative().nullable().default(null).describe("每个销售单位的进货成本，人民币；未知填 null"),
	weightKg: z.number().positive().nullable().default(null).describe("每个销售单位的计费重量，kg；未知填 null"),
	freightRmb: z.number().nonnegative().nullable().default(null).describe("该订单的国内运费，人民币；明确包邮才能填 0"),
	units: z.number().int().positive().default(1).describe("一个订单销售几个单位，贴单费只算一次"),
});
export type TemplateItem = z.output<typeof templateItem>;

/** 模板的尾 9 上取整；不能直接当成目标毛利区间的上限，上取整可能超出目标 */
export const roundUpNine = (price: number): number => Math.ceil((price - 9) / 10 - 1e-10) * 10 + 9;

export function templatePrice(item: TemplateItem, p: TemplateParams) {
	const missing = [
		...(item.costRmb === null ? ["进货成本"] : []),
		...(item.weightKg === null ? ["计费重量"] : []),
		...(item.freightRmb === null ? ["国内运费"] : []),
	];
	const netRmb = item.currentTwd === null ? null : (item.currentTwd * (1 - p.feeRate)) / p.fx;
	// 倒算的是含运费、贴单费的成本预算，不是从售价猜进货成本或实际毛利。
	const budgetRmb = netRmb === null ? null : { min: netRmb * (1 - p.maxMargin), max: netRmb * (1 - p.minMargin) };
	const totalCostRmb =
		item.costRmb !== null && item.weightKg !== null && item.freightRmb !== null
			? (item.costRmb + item.weightKg * p.freightPerKgRmb) * item.units + item.freightRmb + p.labelFeeRmb
			: null;
	const theoretical =
		totalCostRmb === null
			? null
			: {
					min: (totalCostRmb * p.fx) / ((1 - p.feeRate) * (1 - p.minMargin)),
					max: (totalCostRmb * p.fx) / ((1 - p.feeRate) * (1 - p.maxMargin)),
				};
	const low = theoretical === null ? null : Math.max(1, Math.ceil(theoretical.min - 1e-9));
	const high = theoretical === null ? null : Math.floor(theoretical.max + 1e-9);
	const range = low !== null && high !== null && low <= high ? { min: low, max: high } : null;
	const firstNine = range === null ? null : roundUpNine(range.min);
	const lastNine = range === null ? null : Math.floor((range.max - 9) / 10 + 1e-10) * 10 + 9;
	const tailNine = firstNine !== null && lastNine !== null && firstNine <= lastNine ? { min: firstNine, max: lastNine } : null;
	const current = totalCostRmb === null || netRmb === null ? null : { profitRmb: netRmb - totalCostRmb, margin: (netRmb - totalCostRmb) / netRmb };
	return {
		key: item.key,
		status: missing.length ? "待补数据" : range ? "条件试算" : "区间无整数售价",
		missing,
		totalCostRmb,
		theoretical,
		range,
		tailNine,
		current,
		budgetRmb,
	};
}
