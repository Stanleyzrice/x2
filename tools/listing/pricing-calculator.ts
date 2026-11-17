// 定价工作区只试算：规则参数从现有说明读取，显式成本与优惠交给既有核价函数，不存店铺设置或商品。
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Usage } from "../../platform/errors.ts";
import { get, parseJson, str } from "../../platform/tool.ts";
import { orderPrice } from "./order-pricing.ts";
import { roundUpNine, type TemplateParams, templateParams, templateUnitPrice } from "./template-pricing.ts";

const nullableAmount = (schema: z.ZodNumber) =>
	z.preprocess((value) => (typeof value === "string" && !value.trim() ? null : value), z.coerce.number().pipe(schema).nullable().default(null));

export const calculatorInput = z.object({
	template: z.preprocess(parseJson, templateParams),
	costRmb: nullableAmount(z.number().nonnegative()),
	weightKg: nullableAmount(z.number().positive()),
	freightRmb: nullableAmount(z.number().nonnegative()),
	units: z.coerce.number().int().positive().default(1),
	priceTwd: nullableAmount(z.number().positive()),
	sellerDiscountTwd: nullableAmount(z.number().nonnegative()),
});
export type CalculatorInput = z.output<typeof calculatorInput>;

export function pricingTemplateFromPolicy(markdown: string): TemplateParams {
	const section = markdown.match(/^## 参数与口径\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1];
	const json = section?.match(/```json\s*\n([\s\S]*?)\n```/)?.[1];
	try {
		if (json) return templateParams.parse(JSON.parse(json));
	} catch {
		throw new Usage("定价模板参数无效，请修复现有定价规则的参数与口径段");
	}
	throw new Usage("缺少定价模板参数，请修复现有定价规则的参数与口径段");
}

export function calculatePricing(input: CalculatorInput) {
	const { template, costRmb, weightKg, freightRmb, units, sellerDiscountTwd } = input;
	const unit = templateUnitPrice({ key: "试算", costRmb, weightKg, freightRmb, units, currentTwd: null }, template);
	// 单件标价先加回整单卖家优惠，再向内取整，避免优惠后跌出目标区间。
	const bounds =
		unit.unitTheoretical && sellerDiscountTwd !== null
			? { min: unit.unitTheoretical.min + sellerDiscountTwd / units, max: unit.unitTheoretical.max + sellerDiscountTwd / units }
			: null;
	const low = bounds ? Math.max(1, Math.ceil(bounds.min - 1e-9)) : null;
	const high = bounds ? Math.floor(bounds.max + 1e-9) : null;
	const rangeTwd = low !== null && high !== null && low <= high ? { min: low, max: high } : null;
	const firstNine = rangeTwd ? roundUpNine(rangeTwd.min) : null;
	const suggestedPriceTwd = firstNine !== null && rangeTwd && firstNine <= rangeTwd.max ? firstNine : (rangeTwd?.min ?? null);
	const priceTwd = input.priceTwd ?? suggestedPriceTwd;
	const priceSource = input.priceTwd !== null ? ("input" as const) : suggestedPriceTwd !== null ? ("suggested" as const) : null;
	const order =
		priceTwd === null
			? null
			: orderPrice(
					{
						items: [{ key: "试算", priceTwd, costRmb, weightKg, units }],
						freightRmb,
						sellerDiscountTwd,
						minimumTwd: 0,
					},
					template,
				);
	const invalid = order?.paidTwd !== null && order?.paidTwd !== undefined && order.paidTwd < 0;
	const missing = [...unit.missing, ...(sellerDiscountTwd === null ? ["卖家承担的优惠"] : [])];
	const status = invalid
		? ("INVALID_INPUT" as const)
		: missing.length
			? ("DATA_INSUFFICIENT" as const)
			: priceTwd === null
				? ("NO_PRICE" as const)
				: ("CALCULATED" as const);
	const netRmb = invalid ? null : (order?.netRmb ?? null);
	const problems = [
		...missing.map((key) => `缺${key}`),
		...(invalid ? ["卖家优惠超过商品总额"] : []),
		...(status === "NO_PRICE" ? ["目标区间内没有整数售价，请调整输入"] : []),
	];
	return {
		input,
		template,
		status,
		missing,
		problems,
		suggestedPriceTwd,
		priceTwd,
		priceSource,
		rangeTwd,
		netRmb,
		totalCostRmb: unit.totalCostRmb,
		profitRmb: invalid ? null : (order?.profitRmb ?? null),
		margin: invalid ? null : (order?.margin ?? null),
		withinTarget: invalid ? null : (order?.withinTarget ?? null),
		breakdown: {
			goodsRmb: costRmb === null ? null : costRmb * units,
			firstLegRmb: weightKg === null ? null : weightKg * units * template.freightPerKgRmb,
			domesticFreightRmb: freightRmb,
			labelFeeRmb: template.labelFeeRmb,
			platformFeeRmb: invalid || order?.paidTwd === null || order?.paidTwd === undefined ? null : (order.paidTwd * template.feeRate) / template.fx,
			discountTwd: sellerDiscountTwd,
			grossTwd: order?.grossTwd ?? null,
			paidTwd: order?.paidTwd ?? null,
		},
	};
}

const policyPath = "skills/listing/references/pricing.md";
export const pricingCalculatorTools = {
	"calculator-settings": get("读取现行定价规则的模板输入，不改店铺配置", z.object({ shop: str("用于展示的店铺") }), async ({ shop }) => ({
		shop,
		template: pricingTemplateFromPolicy(await readFile(new URL("../../skills/listing/references/pricing.md", import.meta.url), "utf8")),
		source: "policy" as const,
		policyPath,
	})),
	"calculator-preview": get("按显式输入试算单件建议售价和整单人民币利润，不改设置或商品", calculatorInput, async (input) => calculatePricing(input)),
};
