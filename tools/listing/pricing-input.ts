// 商品稿的显式核价输入：锁住一份未建商品的稿件，只改指定 SKU；来源 offer 不改。
import { z } from "zod";
import { SkuId } from "../../connectors/sites/1688/api.ts";
import type { Json, Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { parseJson } from "../../platform/tool.ts";
import { estimateNeeds, pricingPolicy, pricingProblems, reprice, settingsOf, variantTemplatePrice } from "./pricing.ts";
import { ListingId, type ListingRow, type ShopSettingsRow } from "./row.ts";
import { type Specs, specsOf, variantPricingInput } from "./variants.ts";

const item = variantPricingInput.extend({ skuId: SkuId });
export const pricingInputsParams = z.object({
	id: ListingId.describe("商品稿编号"),
	items: z
		.preprocess(parseJson, z.array(item).min(1))
		.describe("显式逐规格输入 JSON：skuId、costRmb、chargeableWeightKg、priceTwd；可附 freightRmbPerUnit（每单位国内运费）和 sourceEvidence"),
});
type Input = z.output<typeof pricingInputsParams>;

export function applyPricingInputs(specs: Specs, items: z.output<typeof item>[]): Specs {
	if (new Set(items.map((i) => i.skuId)).size !== items.length) throw new Usage("核价输入有重复 skuId");
	const existing = new Set(specs.variants.map((v) => v.skuId));
	if (existing.size !== specs.variants.length) throw new Usage("商品稿有重复 skuId，不修改");
	for (const i of items) if (!existing.has(i.skuId)) throw new Usage(`商品稿没有 SKU ${i.skuId}`);
	const selected = new Map(items.map(({ skuId, ...input }) => [skuId, variantPricingInput.parse(input)]));
	return {
		...specs,
		variants: specs.variants.map((v) => (selected.has(v.skuId) ? { ...v, pricingInput: structuredClone(selected.get(v.skuId)!) } : v)),
	};
}

export async function setPricingInputs(sql: Sql, p: Input) {
	return sql.begin(async (tx) => {
		const [l] = await tx<ListingRow[]>`select * from listings where id = ${p.id} for update`;
		if (!l) throw new Usage(`没有商品稿 ${p.id}`);
		if (l.product_id || l.listed_at) throw new Usage("商品已经建成或上架；草稿核价输入工具不修改现有商品");
		const specs = specsOf(l.variants);
		if (!l.offer || !specs) throw new Usage("商品稿没有来源或规格，先做商品稿");
		const [shop] = await tx<ShopSettingsRow[]>`select * from shop_settings where shop = ${l.shop}`;
		if (!shop) throw new Usage(`没有店铺设置 ${l.shop}`);
		const settings = settingsOf(shop);
		const updated = applyPricingInputs(specs, p.items);
		const calculated = reprice({ ...l, variants: updated }, settings);
		if (!calculated) throw new Usage("无法读取核价输入");
		const selected = new Set(p.items.map((i) => i.skuId));
		const bySku = new Map(calculated.specs.variants.map((v) => [v.skuId, v]));
		const final: Specs = {
			...updated,
			variants: updated.variants.map((v) => (selected.has(v.skuId) ? { ...bySku.get(v.skuId)!, stock: v.stock } : v)),
		};
		const retainedProblems = String(l.problems ?? "")
			.split("\n")
			.filter((line) => line && !/^核价：|^缺(?:重量|国内运费)/.test(line));
		const problems = [...retainedProblems, ...pricingProblems(final, estimateNeeds({ ...l, variants: final }))];
		const pricing = {
			...pricingPolicy(settings),
			freightRmb: calculated.freightRmb,
			minimumPurchase: calculated.minimumPurchase,
			at: new Date().toISOString(),
		};
		await tx`update listings set variants = ${tx.json(final as Json)}, pricing = ${tx.json(pricing as Json)},
			problems = ${retainedProblems.join("\n") || null}, updated_at = now() where id = ${p.id}`;
		return {
			id: p.id,
			applied: p.items.length,
			minimumPurchase: calculated.minimumPurchase,
			problems,
			rows: final.variants
				.filter((v) => selected.has(v.skuId))
				.map((v) => ({
					skuId: v.skuId,
					pricingInput: v.pricingInput,
					costRmb: v.costRmb,
					chargeableWeightKg: v.weightKg,
					priceTwd: v.priceTwd,
					calculation: settings.template ? variantTemplatePrice(v, calculated.freightRmb, settings.template, calculated.minimumPurchase) : null,
				})),
		};
	});
}
