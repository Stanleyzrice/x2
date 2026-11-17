// 策略工作台从项目技能读取方法与经营输入；运行快照使用当前规则，不从历史策略表恢复已停用方法。
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";

export const WORKBENCH_POLICY = "skills/selection/references/workbench.md";
export const selectionStrategyIds = ["peer-benchmark", "bestseller-accessories", "unmet-needs", "bundle-sales", "rising-demand"] as const;
export const selectionStrategyId = z.enum(selectionStrategyIds);
export const workflowStepsSchema = z.array(z.string().trim().min(1).max(1000)).min(1).max(12);
const trendPolicySchema = z
	.strictObject({
		windowDays: z.number().int().min(2).max(3660),
		minPoints: z.number().int().positive(),
		maxLagDays: z.number().int().nonnegative(),
		minGrowthRate: z.number().nonnegative(),
		minPreviousGrowthRate: z.number().nonnegative(),
		minRobustGrowthRate: z.number().nonnegative(),
		minBaselineMean: z.number().positive(),
	})
	.refine((v) => v.minPoints <= v.windowDays, "最少点数不得大于窗口天数");
const strategySchema = z
	.strictObject({
		id: selectionStrategyId,
		name: z.string().trim().min(1),
		description: z.string().trim().min(1),
		kind: z.enum(["discovery", "sales-unit"]),
		purchaseReason: z.string().trim().min(1),
		evidenceNeeded: z.array(z.string().trim().min(1)).min(1),
		rejectWhen: z.array(z.string().trim().min(1)).min(1),
		researchVersion: z.literal(1),
		steps: workflowStepsSchema,
		trend: trendPolicySchema.optional(),
	})
	.refine((v) => (v.id === "rising-demand" ? v.trend !== undefined : v.trend === undefined), "近期趋势流程必须配置时间窗口，其它流程不接收趋势参数");
export const workbenchPolicySchema = z.strictObject({
	targetShop: z.string().trim().min(1),
	marketSiteId: z.number().int().positive(),
	methodology: z.strictObject({
		summary: z.string().trim().min(1),
		commonChecks: z.array(z.string().trim().min(1)).min(1),
		evidenceRules: z.array(z.string().trim().min(1)).min(1),
		deferred: z.array(z.strictObject({ name: z.string().trim().min(1), reason: z.string().trim().min(1) })),
	}),
	constraints: z.strictObject({
		requireOnePieceSale: z.boolean(),
		requireShip48h: z.boolean(),
		maxMinQty: z.number().int().positive(),
		maxSkuCount: z.number().int().positive(),
		minSinglePriceTwd: z.number().positive(),
	}),
	strategies: z.array(strategySchema).length(selectionStrategyIds.length),
});
const templateSchema = z.strictObject({
	fx: z.number().positive(),
	feeRate: z.number().min(0).max(1),
	freightPerKgRmb: z.number().nonnegative(),
	labelFeeRmb: z.number().nonnegative(),
	minMargin: z.number().min(0).max(1),
	maxMargin: z.number().min(0).max(1),
});
export type StrategyDefinition = z.output<typeof strategySchema> & { policyPath: string; instructions: string; isCustomized: boolean };
export type TrendParameters = z.output<typeof trendPolicySchema>;
export type SelectionRunConfig = {
	shop: string;
	strategy: Pick<StrategyDefinition, "id" | "name" | "description" | "steps" | "policyPath" | "instructions"> &
		Partial<Pick<StrategyDefinition, "researchVersion" | "trend">>;
	limit: number;
	brief: string;
	policyText: string;
	pricingTemplate: z.output<typeof templateSchema>;
	constraints: z.output<typeof workbenchPolicySchema>["constraints"];
	allowedCategories: string[] | null;
	marketSiteId?: number;
	sellerDiscountTwd: number | null;
	existingOfferIds: string[];
	agent?: { model: string; reasoningEffort: string };
};

export function withWorkflow(definition: StrategyDefinition, steps: unknown): StrategyDefinition {
	return steps === undefined ? definition : { ...definition, steps: workflowStepsSchema.parse(steps), isCustomized: true };
}

export function parsePolicyJson(markdown: string): unknown {
	const block = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
	if (!block) throw new Usage("策略或定价说明缺少运行参数，请检查当前项目技能");
	try {
		return JSON.parse(block[1]!);
	} catch {
		throw new Usage("项目技能中的运行参数不是有效JSON，请检查策略或定价说明");
	}
}

export function parseWorkbenchPolicy(markdown: string) {
	const policy = workbenchPolicySchema.parse(parsePolicyJson(markdown));
	if (new Set(policy.strategies.map((s) => s.id)).size !== selectionStrategyIds.length) throw new Usage("每个研究流程必须各有一个定义，不能重复");
	return policy;
}

export function strategyInstructions(markdown: string, name: string): string {
	const heading = `## ${name}`;
	const start = markdown.indexOf(`${heading}\n`);
	if (start < 0) throw new Usage(`策略「${name}」缺少详细执行步骤`);
	const section = markdown.slice(start + heading.length + 1);
	const end = section.indexOf("\n## ");
	return (end < 0 ? section : section.slice(0, end)).trim();
}

async function readProjectFile(path: string) {
	return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

/** 研究只接收现行规则与执行边界；其它策略和上架操作手册不重复塞进每次模型输入。 */
export function researchPolicyText(markdown: string, rules: string, template: z.output<typeof templateSchema>): string {
	const { methodology } = parseWorkbenchPolicy(markdown);
	return [
		rules,
		methodology.summary,
		`共用检查：\n${methodology.commonChecks.map((check) => `- ${check}`).join("\n")}`,
		`证据口径：\n${methodology.evidenceRules.map((rule) => `- ${rule}`).join("\n")}`,
		"研究备选的执行边界：",
		strategyInstructions(markdown, "执行、停止与交付"),
		"定价参数来自 skills/listing/references/pricing.md，所有金额与可行价格由 listing.calculator-preview 计算，不由模型估算。",
		`当前定价输入：${JSON.stringify(template)}。缺成本输入保留未知，已知亏损或市场冲突不得绕过。`,
	].join("\n\n");
}

export async function loadSelectionPolicy() {
	const markdown = await readProjectFile(WORKBENCH_POLICY);
	return { ...parseWorkbenchPolicy(markdown), markdown };
}

export async function loadStrategyDefinitions(sql?: Sql, shop?: string): Promise<StrategyDefinition[]> {
	const policy = await loadSelectionPolicy();
	const saved =
		sql && shop ? await sql<{ strategy_id: string; steps: unknown }[]>`select strategy_id, steps from selection_workflows where shop = ${shop}` : [];
	return policy.strategies.map((s) =>
		withWorkflow(
			{
				...s,
				policyPath: WORKBENCH_POLICY,
				instructions: [
					strategyInstructions(policy.markdown, s.name),
					`购买理由：${s.purchaseReason}`,
					`所需证据：\n${s.evidenceNeeded.map((requirement) => `- ${requirement}`).join("\n")}`,
					`排除或停止条件：\n${s.rejectWhen.map((condition) => `- ${condition}`).join("\n")}`,
				].join("\n\n"),
				isCustomized: false,
			},
			saved.find((row) => row.strategy_id === s.id)?.steps,
		),
	);
}

export async function saveWorkflow(sql: Sql, input: { shop: string; strategyId: string; steps?: string[] }): Promise<StrategyDefinition> {
	const policy = await loadSelectionPolicy();
	if (input.shop !== policy.targetShop) throw new Usage(`当前新增选品目标是「${policy.targetShop}」`);
	const definition = (await loadStrategyDefinitions()).find((strategy) => strategy.id === input.strategyId);
	if (!definition) throw new Usage("请选择当前研究方法");
	if (input.steps === undefined) await sql`delete from selection_workflows where shop = ${input.shop} and strategy_id = ${input.strategyId}`;
	else {
		const steps = workflowStepsSchema.parse(input.steps);
		await sql`insert into selection_workflows (shop,strategy_id,steps) values (${input.shop},${input.strategyId},${sql.json(steps)})
			on conflict (shop,strategy_id) do update set steps=excluded.steps,updated_at=now()`;
	}
	return withWorkflow(definition, input.steps);
}

export async function loadRunConfig(sql: Sql, input: { shop: string; strategyId: string; limit: number; brief: string }): Promise<SelectionRunConfig> {
	const policy = await loadSelectionPolicy();
	if (input.shop !== policy.targetShop) throw new Usage(`当前新增选品目标是「${policy.targetShop}」`);
	const definition = (await loadStrategyDefinitions(sql, input.shop)).find((s) => s.id === input.strategyId);
	if (!definition) throw new Usage("请选择当前选品研究流程；本店成交延伸尚未启用");
	const [settings] = await sql<{ categories: unknown; pricing_template: unknown }[]>`
		select categories, pricing_template from shop_settings where shop = ${input.shop}`;
	if (!settings) throw new Usage(`没有「${input.shop}」这家店`);
	const [rules, pricing] = await Promise.all([
		readProjectFile("skills/selection/references/rules.md"),
		readProjectFile("skills/listing/references/pricing.md"),
	]);
	const template = templateSchema.parse(parsePolicyJson(pricing));
	if (settings.pricing_template) {
		const stored = templateSchema.parse(settings.pricing_template);
		if (Object.keys(template).some((key) => template[key as keyof typeof template] !== stored[key as keyof typeof stored]))
			throw new Usage("店铺定价输入与当前规则不一致，请先核对定价模板");
	}
	const sources = await sql<{ offer_id: string }[]>`select distinct offer_id from listings where not cancelled`;
	return {
		...input,
		marketSiteId: policy.marketSiteId,
		strategy: definition,
		policyText: researchPolicyText(policy.markdown, rules, template),
		pricingTemplate: template,
		constraints: policy.constraints,
		allowedCategories: Array.isArray(settings.categories) && settings.categories.length ? settings.categories.map(String) : null,
		sellerDiscountTwd: null,
		existingOfferIds: sources.map((row) => row.offer_id),
	};
}
