// 表单仅把文字转换成显式数值并校验；留空的成本仍是未知，百分比在请求边界转换。
import type { CalculationInput, Template } from "./types.ts";

export type Draft = Record<"costRmb" | "weightKg" | "freightRmb" | "units" | "priceTwd" | "sellerDiscountTwd", string>;
export type TemplateDraft = Record<keyof Template, string>;
export const emptyDraft = (): Draft => ({ costRmb: "", weightKg: "", freightRmb: "", units: "1", priceTwd: "", sellerDiscountTwd: "0" });
export const templateDraft = (p: Template): TemplateDraft => ({
	fx: String(p.fx),
	feeRate: String(p.feeRate * 100),
	freightPerKgRmb: String(p.freightPerKgRmb),
	labelFeeRmb: String(p.labelFeeRmb),
	minMargin: String(p.minMargin * 100),
	maxMargin: String(p.maxMargin * 100),
});

export function calculationInput(draft: Draft, parameters: TemplateDraft): { input: CalculationInput | null; errors: string[] } {
	const errors: string[] = [];
	const read = (raw: string, label: string, positive = false, optional = false): number | null => {
		if (!raw.trim() && optional) return null;
		const value = raw.trim() ? Number(raw) : Number.NaN;
		if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
			errors.push(`${label}须为${positive ? "大于 0" : "不小于 0"}的数字`);
			return null;
		}
		return value;
	};
	const costRmb = read(draft.costRmb, "进货价", false, true);
	const weightKg = read(draft.weightKg, "计费重量", true, true);
	const freightRmb = read(draft.freightRmb, "国内运费", false, true);
	const units = read(draft.units, "订单件数", true);
	if (units !== null && !Number.isSafeInteger(units)) errors.push("订单件数须为正整数");
	const priceTwd = read(draft.priceTwd, "每件售价", true, true);
	const sellerDiscountTwd = read(draft.sellerDiscountTwd, "整单卖家优惠", false, true);
	const fx = read(parameters.fx, "汇率", true);
	const feeRate = read(parameters.feeRate, "平台费率");
	const freightPerKgRmb = read(parameters.freightPerKgRmb, "头程单价");
	const labelFeeRmb = read(parameters.labelFeeRmb, "贴单费");
	const minMargin = read(parameters.minMargin, "目标毛利率下限");
	const maxMargin = read(parameters.maxMargin, "目标毛利率上限");
	for (const [label, value] of [
		["平台费率", feeRate],
		["目标毛利率下限", minMargin],
		["目标毛利率上限", maxMargin],
	] as const)
		if (value !== null && value >= 100) errors.push(`${label}须小于 100%`);
	if (minMargin !== null && maxMargin !== null && maxMargin < minMargin) errors.push("目标毛利率上限不能低于下限");
	if (errors.length) return { input: null, errors };
	return {
		input: {
			costRmb,
			weightKg,
			freightRmb,
			units: units!,
			priceTwd,
			sellerDiscountTwd,
			template: {
				fx: fx!,
				feeRate: feeRate! / 100,
				freightPerKgRmb: freightPerKgRmb!,
				labelFeeRmb: labelFeeRmb!,
				minMargin: minMargin! / 100,
				maxMargin: maxMargin! / 100,
			},
		},
		errors,
	};
}
