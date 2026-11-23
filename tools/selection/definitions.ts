// 策略工作台从项目技能读取方法与经营输入；运行快照使用当前规则，不从历史策略表恢复已停用方法。
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import type { HermesModel } from "../../platform/ui/hermes-schema.ts";
import { socialDiscoveryStrategy, strategyIds } from "../../platform/ui/interactable/selection/types.ts";
import { parsePolicyJson, sourcePolicySchema, WORKBENCH_POLICY } from "../listing/index.ts";
import { strategyExecution, trendPolicySchema } from "./strategy-execution.ts";

export { parsePolicyJson, WORKBENCH_POLICY } from "../listing/index.ts";
export const selectionStrategyId = z.enum(strategyIds);
export const workflowStepsSchema = z.array(z.string().trim().min(1).max(1000)).min(1).max(12);
const documentedStrategies = strategyIds.filter((id) => id !== socialDiscoveryStrategy);
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
	})
	.refine((strategy) => strategy.kind === strategyExecution[strategy.id].kind, { path: ["kind"], message: "策略分类与执行契约不符" });

const socialDefinition = {
	id: socialDiscoveryStrategy,
	name: "小红书选品发现",
	description: "从近期讨论台湾虾皮具体商品的笔记寻找选题，逐品核实台湾近期购买后再查货源。",
	kind: strategyExecution[socialDiscoveryStrategy].kind,
	purchaseReason: "从原帖里的具体商品或使用场景发现可面向台湾买家的商品。",
	evidenceNeeded: ["可定位到原帖正文或图片的台湾站与商品场景依据。", "候选本身在台湾站有带日期的近期购买样本。"],
	rejectWhen: ["找不到近期原帖、无法绑定使用场景，或者没有匹配该商品的近期购买证据。"],
	researchVersion: 1,
	steps: ["搜索近 30 天的台湾虾皮笔记。", "绑定原帖，提取直接商品或从明确场景延伸一次。", "逐品验证台湾近期购买、货源与成本，保存合格备选。"],
} satisfies z.output<typeof strategySchema>;
export const workbenchPolicySchema = z.strictObject({
	targetShop: z.string().trim().min(1),
	marketSiteId: z.number().int().positive(),
	methodology: z.strictObject({
		summary: z.string().trim().min(1),
		commonChecks: z.array(z.string().trim().min(1)).min(1),
		evidenceRules: z.array(z.string().trim().min(1)).min(1),
		deferred: z.array(z.strictObject({ name: z.string().trim().min(1), reason: z.string().trim().min(1) })),
	}),
	constraints: sourcePolicySchema,
	strategies: z.array(strategySchema).length(documentedStrategies.length),
});
const templateSchema = z.strictObject({
	fx: z.number().positive(),
	feeRate: z.number().min(0).max(1),
	freightPerKgRmb: z.number().nonnegative(),
	labelFeeRmb: z.number().nonnegative(),
	minMargin: z.number().min(0).max(1),
	maxMargin: z.number().min(0).max(1),
});
export type StrategyDefinition = z.output<typeof strategySchema> & { policyPath: string; instructions: string; isCustomized: boolean; trend?: TrendParameters };
export type TrendParameters = z.output<typeof trendPolicySchema>;
export type SelectionRunConfig = {
	shop: string;
	strategy: Pick<StrategyDefinition, "id" | "name" | "description" | "steps" | "policyPath" | "instructions"> &
		Partial<Pick<StrategyDefinition, "researchVersion" | "trend">>;
	limit: number;
	brief: string;
	policyText: string;
	assessmentPolicy?: string;
	pricingTemplate: z.output<typeof templateSchema>;
	constraints: z.output<typeof workbenchPolicySchema>["constraints"];
	allowedCategories: string[] | null;
	marketSiteId?: number;
	sellerDiscountTwd: number | null;
	existingOfferIds: string[];
	agent?: { model: string; reasoningEffort: string };
	deepSeekModel?: HermesModel;
};

export function withWorkflow(definition: StrategyDefinition, steps: unknown): StrategyDefinition {
	return steps === undefined ? definition : { ...definition, steps: workflowStepsSchema.parse(steps), isCustomized: true };
}

export function parseWorkbenchPolicy(markdown: string) {
	const policy = workbenchPolicySchema.parse(parsePolicyJson(markdown));
	const ids = new Set(policy.strategies.map((s) => s.id));
	if (ids.size !== documentedStrategies.length || documentedStrategies.some((id) => !ids.has(id)))
		throw new Usage("每个已登记的文档策略必须各有一个定义，不能重复");
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
		rules.split("\n## 研究判断\n")[0]?.trim() ?? rules,
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
	return [...policy.strategies, socialDefinition].map((s) => {
		const execution = strategyExecution[s.id];
		return withWorkflow(
			{
				...s,
				...(execution.market === "trend" ? { trend: trendPolicySchema.parse(execution.trend) } : {}),
				policyPath: WORKBENCH_POLICY,
				instructions: [
					s.id === socialDiscoveryStrategy ? s.description : strategyInstructions(policy.markdown, s.name),
					`购买理由：${s.purchaseReason}`,
					`所需证据：\n${s.evidenceNeeded.map((requirement) => `- ${requirement}`).join("\n")}`,
					`排除或停止条件：\n${s.rejectWhen.map((condition) => `- ${condition}`).join("\n")}`,
				].join("\n\n"),
				isCustomized: false,
			},
			saved.find((row) => row.strategy_id === s.id)?.steps,
		);
	});
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
		marketSiteId: definition.id === socialDiscoveryStrategy ? 1 : policy.marketSiteId,
		strategy: definition,
		policyText: researchPolicyText(policy.markdown, rules, template),
		assessmentPolicy: strategyInstructions(rules, "研究判断"),
		pricingTemplate: template,
		constraints: policy.constraints,
		allowedCategories: Array.isArray(settings.categories) && settings.categories.length ? settings.categories.map(String) : null,
		sellerDiscountTwd: null,
		existingOfferIds: sources.map((row) => row.offer_id),
	};
}
