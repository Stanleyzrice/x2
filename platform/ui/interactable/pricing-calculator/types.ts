// 定价组件与业务工具之间的响应类型；页面只显示服务端返回的金额，不另建计算公式。
export type Template = { fx: number; feeRate: number; freightPerKgRmb: number; labelFeeRmb: number; minMargin: number; maxMargin: number };
export type Settings = { shop: string; template: Template; source: "policy"; policyPath: string };
export type CalculationInput = {
	template: Template;
	costRmb: number | null;
	weightKg: number | null;
	freightRmb: number | null;
	units: number;
	priceTwd: number | null;
	sellerDiscountTwd: number | null;
};
export type Calculation = {
	suggestedPriceTwd: number | null;
	priceTwd: number | null;
	priceSource: "input" | "suggested" | null;
	rangeTwd: { min: number; max: number } | null;
	missing: string[];
	status: "INVALID_INPUT" | "DATA_INSUFFICIENT" | "NO_PRICE" | "CALCULATED";
	netRmb: number | null;
	totalCostRmb: number | null;
	profitRmb: number | null;
	margin: number | null;
	withinTarget: boolean | null;
	breakdown: {
		goodsRmb: number | null;
		firstLegRmb: number | null;
		domesticFreightRmb: number | null;
		labelFeeRmb: number;
		platformFeeRmb: number | null;
		discountTwd: number | null;
		paidTwd: number | null;
		grossTwd: number | null;
	};
	problems: string[];
};
