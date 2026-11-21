import { readFile } from "node:fs/promises";
import { z } from "zod";
import { offerIdOf } from "../../connectors/sites/1688/api.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { parseJson, str, strs } from "../../platform/tool.ts";
import { freightOf, num, type Settings, settingsOf, specsAndPrices, usableWeights } from "./pricing.ts";
import { calculatePricing, pricingTemplateFromPolicy } from "./pricing-calculator.ts";
import { purchaseLimitOf } from "./purchase-limit.ts";
import type { ListingRow, ShopSettingsRow } from "./row.ts";
import { SourceId, sourceOffer, sourceProductSchema } from "./source-data.ts";
import { loadSourcePolicy, type SourcePolicy, sourceSkuLimitProblem, sourceSupplyProblems } from "./source-policy.ts";
import type { TemplateParams } from "./template-pricing.ts";
import { limitProblems, specsOf } from "./variants.ts";

const link = z.url({ protocol: /^https?$/, hostname: /^(?:[a-z0-9-]+\.)*1688\.com$/i }).transform((url, ctx) => {
	const id = offerIdOf(url);
	if (id && !new URL(url).username && !new URL(url).password) return id;
	ctx.addIssue({ code: "custom", message: "需要有效的1688商品链接" });
	return z.NEVER;
});

export const sourcePreflightParams = z
	.object({
		shop: str("本批核验店铺"),
		sourceIds: strs("备选编号，逗号分隔").pipe(z.array(SourceId).max(1000)).optional(),
		links: strs("从已保存采集快照查找的1688链接，逗号分隔").pipe(z.array(link).max(1000)).optional(),
		sellerDiscountTwd: z.preprocess(parseJson, z.number().nonnegative()).optional().describe("本批共用的卖家承担优惠，按最小购买量的一单计；核实无优惠才填0"),
	})
	.refine((p) => Boolean(p.sourceIds || p.links), "请指定备选编号或1688链接");

type SavedSource = { id: string; offerId: string; snapshot: unknown; capturedAt: Date; deleted: boolean };
type PreflightDraft = Pick<
	ListingRow,
	| "id"
	| "shop"
	| "offer_id"
	| "product_id"
	| "listed_at"
	| "cancelled"
	| "source_fields"
	| "removed_variants"
	| "variants"
	| "weight_kg"
	| "freight_rmb"
	| "min_purchase"
> & {
	pending: boolean;
};
type Issue = { area: "source" | "supply" | "specs" | "cost"; message: string; skuIds?: string[] };
type Result = { status: "can-prepare" | "needs-input" | "listed" | "built"; issues: Issue[]; sourceSkuCount?: number; selectedSkuCount?: number };

export function checkSourcePreflight(
	source: Pick<SavedSource, "id" | "offerId" | "snapshot" | "deleted">,
	draft: PreflightDraft | undefined,
	otherStore: string | undefined,
	settings: Settings,
	policy: SourcePolicy,
	template: TemplateParams,
	sellerDiscountTwd: number | null,
): Result {
	const hold = (message: string): Result => ({ status: "needs-input", issues: [{ area: "source", message }] });
	if (source.deleted) return hold("备选已移除，请核对原选择");
	if (draft?.pending) return hold("存在未核清的建品或上架请求，先核对原请求");
	if (draft?.listed_at) return { status: "listed", issues: [] };
	if (draft?.product_id) return { status: "built", issues: [] };
	if (draft?.cancelled) return hold("已有商品稿已放弃，需核对原选择");
	if (otherStore) return hold(`「${otherStore}」已有同源商品稿，跨店沿用须确认范围`);
	if (settings.paused) return hold(`店铺暂停上架：${settings.paused}`);

	const parsed = sourceProductSchema.safeParse(source.snapshot);
	if (!parsed.success || parsed.data.sourceId !== source.offerId) return hold("已存货源快照无效或编号不一致，请核对采集回执");
	const snapshot = parsed.data;
	const fields = draft?.source_fields ?? {};
	const issues: Issue[] = snapshot.errors.map((message) => ({ area: "source", message }));
	const result = (selectedSkuCount?: number): Result => ({
		status: issues.length ? "needs-input" : "can-prepare",
		issues,
		sourceSkuCount: snapshot.skus.length,
		selectedSkuCount,
	});
	const skuLimit = sourceSkuLimitProblem(snapshot.skus.length, policy);
	if (skuLimit) issues.push({ area: "specs", message: skuLimit });
	// 人工补充可澄清空白起订量；已存的较高批发起订量仍需对应的代发采购证据。
	const minQty = snapshot.minQty === null ? (fields.minQty ?? null) : Math.max(snapshot.minQty, fields.minQty ?? snapshot.minQty);
	const supply = (effectiveMinQty: number | null) => {
		for (const message of sourceSupplyProblems({ minQty: effectiveMinQty, tags: snapshot.tags }, policy)) issues.push({ area: "supply", message });
	};
	if (skuLimit) {
		supply(minQty);
		return result();
	}
	const { offer, problems } = sourceOffer(snapshot, { ...fields, minQty: minQty ?? undefined });
	if (!offer) {
		supply(minQty);
		for (const message of problems.filter((problem) => !problem.startsWith("货源：起订量"))) issues.push({ area: "specs", message });
		return result();
	}
	const minimumPurchase = purchaseLimitOf({ min_purchase: draft?.min_purchase ?? null }, settings.minPurchase);
	const freightRmb = freightOf(offer, draft?.freight_rmb ?? fields.freightRmb) ?? (snapshot.freeShipping ? 0 : null);
	const { specs, problems: specProblems } = specsAndPrices(
		usableWeights(offer),
		{ ...settings, template },
		{
			removed: draft?.removed_variants ?? undefined,
			prev: specsOf(draft?.variants),
			weightKg: num(draft?.weight_kg ?? fields.weightKg),
			freightRmb,
			minimumPurchase,
			originalText: true,
		},
	);
	const dropshipWithEvidence =
		minQty !== null && minQty > 1 && specs.variants.length > 0 && !specProblems.some((message) => message.startsWith("货源：起订量"));
	supply(dropshipWithEvidence ? 1 : minQty);
	for (const message of specProblems.filter((problem) => !problem.startsWith("货源：起订量"))) issues.push({ area: "specs", message });
	if (!specs.variants.length) return result(0);
	if (specs.variants.every((variant) => variant.stock < minimumPurchase)) {
		issues.push({ area: "specs", message: `没有库存达到最低购买量 ${minimumPurchase} 的可售规格` });
		return result(specs.variants.length);
	}

	const costIssues = new Map<string, string[]>();
	const costIssue = (skuId: string, message: string) => {
		const previous = costIssues.get(message);
		if (previous) previous.push(skuId);
		else costIssues.set(message, [skuId]);
	};
	const priced = specs.variants.map((variant) => {
		const explicitFreight = variant.pricingInput?.freightRmbPerUnit;
		const explicitPrice = variant.pricingInput?.priceTwd ?? null;
		const price = calculatePricing({
			template,
			costRmb: variant.costRmb,
			weightKg: variant.weightKg,
			freightRmb: explicitFreight === undefined ? freightRmb : explicitFreight * minimumPurchase,
			units: minimumPurchase,
			priceTwd: explicitPrice,
			sellerDiscountTwd,
		});
		for (const problem of price.problems) costIssue(variant.skuId, problem);
		if (price.status === "CALCULATED" && (!price.withinTarget || price.profitRmb === null || price.profitRmb < 0))
			costIssue(variant.skuId, "指定售价扣除卖家优惠后未满足现行毛利或利润要求");
		const ceiling = explicitPrice ?? price.rangeTwd?.max;
		if (minimumPurchase === 1 && ceiling !== undefined && ceiling < policy.minSinglePriceTwd)
			costIssue(variant.skuId, `单卖售价低于 NT$${policy.minSinglePriceTwd}，待核实际销售组合`);
		const floor = minimumPurchase === 1 ? policy.minSinglePriceTwd : 1;
		return { ...variant, priceTwd: explicitPrice ?? (price.rangeTwd && price.rangeTwd.max >= floor ? Math.max(floor, price.priceTwd ?? floor) : null) };
	});
	for (const [message, skuIds] of costIssues) issues.push({ area: "cost", message, skuIds });
	for (const message of limitProblems({ ...specs, variants: priced })) issues.push({ area: "specs", message });
	return result(specs.variants.length);
}

export async function sourcePreflight(sql: Sql, p: z.output<typeof sourcePreflightParams>) {
	const started = performance.now();
	const policyFile = new URL("../../skills/listing/references/pricing.md", import.meta.url);
	const [policy, pricing] = await Promise.all([loadSourcePolicy(), readFile(policyFile, "utf8")]);
	const template = pricingTemplateFromPolicy(pricing);
	const ids = [...new Set(p.sourceIds ?? [])];
	const links = [...new Set(p.links ?? [])];
	const items = await sql.begin("isolation level repeatable read read only", async (tx) => {
		const [row] = await tx<ShopSettingsRow[]>`select * from shop_settings where shop = ${p.shop}`;
		if (!row) throw new Usage(`没有「${p.shop}」这家店`);
		const settings = settingsOf(row);
		if (settings.template && Object.entries(template).some(([key, value]) => settings.template?.[key as keyof TemplateParams] !== value))
			throw new Usage("店铺定价输入与当前规则不一致，请先核对定价模板");
		const sources = await tx<SavedSource[]>`select id::text, source_id as "offerId", snapshot, captured_at as "capturedAt", deleted_at is not null as deleted
			from listing_sources where platform = '1688' and (id::text in ${tx(ids)} or source_id in ${tx(links)})`;
		const byId = new Map(sources.map((source) => [source.id, source]));
		const byOffer = new Map(sources.map((source) => [source.offerId, source]));
		const drafts = await tx<PreflightDraft[]>`select id::text, shop, offer_id, product_id, listed_at, cancelled, source_fields,
			removed_variants, variants, weight_kg, freight_rmb, min_purchase,
			exists (select 1 from writes where params->>'listingId' = l.id::text and op in ('建商品', '上架')
				and status in ('待执行','已提交','结果未知','不一致')) as pending
			from listings l where offer_id in ${tx([...byOffer.keys()])} and (shop = ${p.shop} or not cancelled) order by shop`;
		const own = new Map<string, PreflightDraft>(drafts.filter((draft) => draft.shop === p.shop).map((draft) => [draft.offer_id, draft]));
		const other = new Map<string, string>(drafts.filter((draft) => draft.shop !== p.shop).map((draft) => [draft.offer_id, draft.shop]));
		const byRequestedId = new Set(ids.map((id) => byId.get(id)?.offerId));
		const batch = [
			...ids.map((sourceId) => ({ sourceId, offerId: null, source: byId.get(sourceId) })),
			...links.filter((offerId) => !byRequestedId.has(offerId)).map((offerId) => ({ sourceId: null, offerId, source: byOffer.get(offerId) })),
		];
		return batch.map(({ source, sourceId, offerId }) => {
			const draft = source ? own.get(source.offerId) : undefined;
			const result: Result = source
				? checkSourcePreflight(source, draft, other.get(source.offerId), settings, policy, template, p.sellerDiscountTwd ?? null)
				: { status: "needs-input", issues: [{ area: "source", message: "没有已保存的采集快照，请先采集对应1688货源" }] };
			return {
				sourceId: source?.id ?? sourceId,
				offerId: source?.offerId ?? offerId,
				listingId: draft?.id ?? null,
				capturedAt: source?.capturedAt ?? null,
				...result,
			};
		});
	});
	return {
		shop: p.shop,
		checked: items.length,
		reusedSnapshots: items.filter((item) => item.capturedAt).length,
		elapsedMs: Math.round(performance.now() - started),
		items,
	};
}
