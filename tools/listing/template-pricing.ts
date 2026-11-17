// 百分比费用模型的纯计算：所有费率、汇率、成本和目标区间由调用方提供，返回金额与整数价格区间。
// 与 price.ts 的逐项结算模型分开；这里不选店铺参数、不定义经营目标或业务流程。
import { z } from "zod";

const orderedMargins = (p: { minMargin: number; maxMargin: number }) => p.maxMargin >= p.minMargin;
const marginOrderError = { message: "毛利率上限不能低于下限", path: ["maxMargin"] };

export const templateParams = z
	.object({
		fx: z.coerce.number().positive().describe("TWD/RMB"),
		feeRate: z.coerce.number().min(0).lt(1).describe("百分比费用率"),
		freightPerKgRmb: z.coerce.number().nonnegative().describe("每 kg 运费，人民币"),
		labelFeeRmb: z.coerce.number().nonnegative().describe("每订单固定费用，人民币"),
		minMargin: z.coerce.number().min(0).lt(1).describe("输入的到手金额口径毛利率下限"),
		maxMargin: z.coerce.number().min(0).lt(1).describe("输入的到手金额口径毛利率上限"),
	})
	.refine(orderedMargins, marginOrderError);
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

/** 单位售价与真实订单数量分开：收入、货价和重量按数量合计，整单国内运费、贴单费只计一次。 */
export function templateUnitPrice(item: TemplateItem, p: TemplateParams) {
	const orderPaidTwd = item.currentTwd === null ? null : item.currentTwd * item.units;
	const order = templatePrice({ ...item, currentTwd: orderPaidTwd }, p);
	const unitTheoretical = order.theoretical ? { min: order.theoretical.min / item.units, max: order.theoretical.max / item.units } : null;
	const low = unitTheoretical === null ? null : Math.max(1, Math.ceil(unitTheoretical.min - 1e-9));
	const high = unitTheoretical === null ? null : Math.floor(unitTheoretical.max + 1e-9);
	const unitRange = low !== null && high !== null && low <= high ? { min: low, max: high } : null;
	const firstNine = unitRange === null ? null : roundUpNine(unitRange.min);
	const lastNine = unitRange === null ? null : Math.floor((unitRange.max - 9) / 10 + 1e-10) * 10 + 9;
	const unitTailNine = firstNine !== null && lastNine !== null && firstNine <= lastNine ? { min: firstNine, max: lastNine } : null;
	return {
		...order,
		status: order.missing.length ? "待补数据" : unitRange ? "条件试算" : "区间无整数售价",
		units: item.units,
		orderPaidTwd,
		unitTheoretical,
		unitRange,
		unitTailNine,
	};
}
