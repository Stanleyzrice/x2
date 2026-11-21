import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Usage } from "../../platform/errors.ts";

export const WORKBENCH_POLICY = "skills/selection/references/workbench.md";
export const sourcePolicySchema = z.strictObject({
	requireOnePieceSale: z.boolean(),
	requireShip48h: z.boolean(),
	maxMinQty: z.number().int().positive(),
	maxSkuCount: z.number().int().positive(),
	minSinglePriceTwd: z.number().positive(),
});
export type SourcePolicy = z.output<typeof sourcePolicySchema>;

export function parsePolicyJson(markdown: string): unknown {
	const block = markdown.match(/```json\s*\n([\s\S]*?)\n```/);
	if (!block) throw new Usage("策略或定价说明缺少运行参数，请检查当前项目技能");
	try {
		return JSON.parse(block[1]!);
	} catch {
		throw new Usage("项目技能中的运行参数不是有效JSON，请检查策略或定价说明");
	}
}

export async function loadSourcePolicy() {
	const markdown = await readFile(new URL(`../../${WORKBENCH_POLICY}`, import.meta.url), "utf8");
	return z.object({ constraints: sourcePolicySchema }).parse(parsePolicyJson(markdown)).constraints;
}

export function sourceSupplyProblems(offer: { minQty: number | null; tags?: { onePsale: boolean; ship48h: boolean } | null }, policy: SourcePolicy): string[] {
	return [
		...(offer.minQty === null ? ["起订量未知，待补充"] : offer.minQty < 1 || offer.minQty > policy.maxMinQty ? [`起订量${offer.minQty}不符合当前要求`] : []),
		...(policy.requireOnePieceSale && !offer.tags?.onePsale ? ["缺符合要求的一件代发证据"] : []),
		...(policy.requireShip48h && !offer.tags?.ship48h ? ["缺48小时发货证据"] : []),
	];
}

export function sourceSkuLimitProblem(count: number, policy: SourcePolicy) {
	return count > policy.maxSkuCount ? `来源规格${count}个，超过当前上限` : null;
}
