// 市场价格与成本只读比较；试算继续由现有计算器负责，不改店铺、商品或外部站点。
import { z } from "zod";
import { Usage } from "../../platform/errors.ts";
import { get, parseJson } from "../../platform/tool.ts";
import { calculatePricing, calculatorInput } from "./pricing-calculator.ts";
import { roundUpNine } from "./template-pricing.ts";

const sampleSchema = z.object({
	sampleId: z.string().trim().min(1),
	sourceUrl: z.url({ protocol: /^https?$/ }),
	observedAt: z.iso.datetime({ offset: true }),
	paidTwd: z.number().positive().nullable(),
	units: z.number().int().positive(),
	excludeReason: z.string().trim().min(1).optional(),
});
export const marketPricingInput = calculatorInput
	.extend({
		comparisonKey: z.string().trim().min(1),
		marketSamples: z.preprocess(parseJson, z.array(sampleSchema)),
		referenceSampleIds: z.preprocess(parseJson, z.array(z.string().trim().min(1))).default([]),
		referenceReason: z.string().trim().min(1).optional(),
	})
	.refine((value) => !value.referenceSampleIds.length || Boolean(value.referenceReason), {
		path: ["referenceReason"],
		message: "指定主流样本组时须提供核定依据",
	});
export type MarketPricingInput = z.output<typeof marketPricingInput>;
type Sample = z.output<typeof sampleSchema>;
type NormalizedSample = Sample & { unitPaidTwd: number | null; excludeReasons: string[] };
type KnownSample = NormalizedSample & { unitPaidTwd: number };
type Range = { min: number; max: number };
type ReferencePosition = "ABOVE_REFERENCE" | "BELOW_REFERENCE" | "OVERLAP";

function summarize(samples: Sample[]) {
	const unique = new Map<string, NormalizedSample>();
	for (const sample of samples) {
		const old = unique.get(sample.sampleId);
		if (old) {
			if (old.paidTwd !== sample.paidTwd || old.units !== sample.units) throw new Usage(`市场样本 ${sample.sampleId} 的价格或件数冲突，未计算`);
			// 同一事实的副本不能用空白理由取消已明确排除，全部排除依据随结果保留。
			if (sample.excludeReason && !old.excludeReasons.includes(sample.excludeReason)) old.excludeReasons.push(sample.excludeReason);
		} else {
			unique.set(sample.sampleId, {
				...sample,
				unitPaidTwd: sample.paidTwd === null ? null : sample.paidTwd / sample.units,
				excludeReasons: sample.excludeReason ? [sample.excludeReason] : [],
			});
		}
	}
	const rows = [...unique.values()];
	const excludedSamples = rows.filter((sample) => sample.excludeReasons.length > 0);
	const unknownSamples = rows
		.filter((sample) => !sample.excludeReasons.length && sample.unitPaidTwd === null)
		.map((sample) => ({ ...sample, reason: "优惠后商品总额未知" }));
	const validSamples = rows.filter((sample): sample is KnownSample => !sample.excludeReasons.length && sample.unitPaidTwd !== null);
	const prices = validSamples.map((sample) => sample.unitPaidTwd).sort((a, b) => a - b);
	const count = prices.length;
	const middle = Math.floor(count / 2);
	return {
		rawCount: samples.length,
		validCount: count,
		unknownCount: unknownSamples.length,
		excludedCount: excludedSamples.length,
		deduplicatedCount: samples.length - unique.size,
		meanTwd: count ? prices.reduce((sum, price) => sum + price / count, 0) : null,
		medianTwd: count ? (count % 2 ? prices[middle]! : prices[middle - 1]! / 2 + prices[middle]! / 2) : null,
		minTwd: prices[0] ?? null,
		maxTwd: prices.at(-1) ?? null,
		validSamples,
		unknownSamples,
		excludedSamples,
	};
}

function positionOf(cost: Range | null, market: Range | null): ReferencePosition | null {
	if (!cost || !market) return null;
	if (cost.min > market.max + 1e-9) return "ABOVE_REFERENCE";
	if (cost.max < market.min - 1e-9) return "BELOW_REFERENCE";
	return "OVERLAP";
}

function intersect(cost: Range | null, market: Range | null): Range | null {
	if (!cost || !market) return null;
	const min = Math.max(cost.min, Math.ceil(market.min - 1e-9));
	const max = Math.min(cost.max, Math.floor(market.max + 1e-9));
	return min <= max ? { min, max } : null;
}

export function marketPricePreview(input: MarketPricingInput) {
	const market = summarize(input.marketSamples);
	const byId = new Map(market.validSamples.map((sample) => [sample.sampleId, sample]));
	const referenceSampleIds = [...new Set(input.referenceSampleIds)];
	const referenceSamples = referenceSampleIds.map((id) => {
		const sample = byId.get(id);
		if (!sample) throw new Usage(`主流样本 ${id} 不是已知有效样本，不能用于主流价带`);
		return sample;
	});
	const reference = referenceSamples.length
		? {
				sampleIds: referenceSampleIds,
				reason: input.referenceReason!,
				paidUnitBandTwd: {
					min: Math.min(...referenceSamples.map((sample) => sample.unitPaidTwd)),
					max: Math.max(...referenceSamples.map((sample) => sample.unitPaidTwd)),
				},
			}
		: null;
	const costInput = calculatorInput.parse(input);
	const pricing = calculatePricing(costInput);
	// 观察样本是券后单位金额；现有计算器区间是含本店优惠加回后的单位标价，须先统一口径。
	const discountPerUnitTwd = input.sellerDiscountTwd === null ? null : input.sellerDiscountTwd / input.units;
	const marketListedBandTwd =
		reference && discountPerUnitTwd !== null
			? { min: reference.paidUnitBandTwd.min + discountPerUnitTwd, max: reference.paidUnitBandTwd.max + discountPerUnitTwd }
			: null;
	const referencePosition = positionOf(pricing.rangeTwd, marketListedBandTwd);
	const intersectionTwd = intersect(pricing.rangeTwd, marketListedBandTwd);
	const candidateBasis =
		pricing.status === "INVALID_INPUT"
			? null
			: referencePosition === "BELOW_REFERENCE"
				? ("cost-range-below-reference" as const)
				: intersectionTwd
					? ("market-cost-intersection" as const)
					: null;
	const candidateRange = candidateBasis === "cost-range-below-reference" ? pricing.rangeTwd : candidateBasis ? intersectionTwd : null;
	const evaluate = (priceTwd: number) => {
		const calculated = calculatePricing({ ...costInput, priceTwd });
		return {
			priceTwd,
			paidUnitTwd: discountPerUnitTwd === null ? null : priceTwd - discountPerUnitTwd,
			status: calculated.status,
			netRmb: calculated.netRmb,
			profitRmb: calculated.profitRmb,
			margin: calculated.margin,
			withinTarget: calculated.withinTarget,
		};
	};
	const candidatePrices = new Map<number, string[]>();
	const addCandidate = (price: number, reason: string) => {
		if (!candidateRange || !Number.isInteger(price) || price < candidateRange.min || price > candidateRange.max) return;
		candidatePrices.set(price, [...(candidatePrices.get(price) ?? []), reason]);
	};
	if (candidateRange && discountPerUnitTwd !== null) {
		addCandidate(candidateRange.min, "range-min");
		addCandidate(candidateRange.max, "range-max");
		for (const [value, reason] of [
			[market.meanTwd, "nearest-market-mean"],
			[market.medianTwd, "nearest-market-median"],
		] as const)
			if (value !== null) addCandidate(Math.max(candidateRange.min, Math.min(candidateRange.max, Math.round(value + discountPerUnitTwd))), reason);
		addCandidate(roundUpNine(candidateRange.min), "first-tail-nine");
		if (input.priceTwd !== null) addCandidate(input.priceTwd, "input");
	}
	const candidates = [...candidatePrices].map(([priceTwd, reasons]) => ({ ...evaluate(priceTwd), basis: candidateBasis, reasons }));
	const atMarket = (paidUnitTwd: number | null) => (paidUnitTwd !== null && discountPerUnitTwd !== null ? evaluate(paidUnitTwd + discountPerUnitTwd) : null);
	const status =
		pricing.status === "INVALID_INPUT"
			? ("INVALID_INPUT" as const)
			: pricing.missing.length
				? ("COST_DATA_INSUFFICIENT" as const)
				: !market.validCount
					? ("NO_MARKET_DATA" as const)
					: !pricing.rangeTwd
						? ("NO_COST_PRICE" as const)
						: !reference
							? ("REFERENCE_GROUP_REQUIRED" as const)
							: referencePosition === "ABOVE_REFERENCE" || referencePosition === "BELOW_REFERENCE"
								? referencePosition
								: !intersectionTwd
									? ("NO_INTEGER_INTERSECTION" as const)
									: ("CALCULATED" as const);
	return {
		comparisonKey: input.comparisonKey,
		status,
		market,
		reference,
		pricing,
		discountPerUnitTwd,
		marketListedBandTwd,
		referencePosition,
		intersectionTwd,
		candidateBasis,
		candidates,
		marketPriceCases: { mean: atMarket(market.meanTwd), median: atMarket(market.medianTwd) },
		notice: "仅为显式输入的数学试算，不表示样本代表性、转化预测或发布许可。低于主流仅表示输入下的成本区间位置，不代表商品品质、可比性或符合单卖条件。",
	};
}

export const marketPricingTools = {
	"market-price-preview": get("按显式可比市场样本统计价格并对照成本区间；只试算，不改商品或授权发布", marketPricingInput, async (input) =>
		marketPricePreview(input),
	),
};
