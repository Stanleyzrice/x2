// 只展示已有商品稿保存的 SKU 对应；草稿规格不替代 Shopee 的名称、图片或现售 SKU 列表。
import { z } from "zod";
import type { CatalogModel, ProductFact } from "./facts.ts";

export type CatalogSourceRow = {
	shop: string;
	shopId: string;
	productId: string;
	offerId: string;
	variants: unknown;
	offer: unknown;
	readAt: Date | null;
};

const variants = z.object({
	variants: z.array(z.object({ sku: z.string().min(1), skuId: z.string().min(1), specId: z.string() })),
});
const offer = z.object({
	offerId: z.string().min(1),
	skus: z.array(
		z.object({
			skuId: z.string().min(1),
			specId: z.string(),
			name: z.string(),
			attrs: z.array(z.string()).optional(),
			image: z.string().nullish(),
		}),
	),
});

function sourceImage(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

function sourceOf(model: CatalogModel, rows: CatalogSourceRow[]): Pick<CatalogModel, "source" | "sourceWarning"> {
	const missing = (sourceWarning: string) => ({ source: null, sourceWarning });
	if (!rows.length) return missing("未保存此商品的 SKU 货源对应");
	if (!model.sku) return missing("Shopee 未提供 SKU，无法对应 1688 规格");
	const parsed = rows.map((row) => ({ row, variants: variants.safeParse(row.variants), offer: offer.safeParse(row.offer) }));
	if (parsed.some((r) => !r.variants.success || !r.offer.success)) return missing("商品稿的货源规格资料不完整，无法确认对应");
	const matches = parsed.flatMap((entry) =>
		entry.variants.success && entry.offer.success
			? entry.variants.data.variants.filter((v) => v.sku === model.sku).map((variant) => ({ row: entry.row, offer: entry.offer.data!, variant }))
			: [],
	);
	if (matches.length !== 1) return missing(matches.length ? "同一 SKU 存在多个货源对应，待核对" : "商品稿没有此 SKU 的货源对应");
	const match = matches[0]!;
	if (!/^\d+$/.test(match.row.offerId) || match.offer.offerId !== match.row.offerId) return missing("商品稿货源编号与规格快照不一致，待核对");
	const skus = match.offer.skus.filter((sku) => sku.skuId === match.variant.skuId && sku.specId === match.variant.specId);
	if (skus.length !== 1) return missing(skus.length ? "1688 快照存在重复规格编号，待核对" : "1688 快照没有同时匹配 skuId 和 specId 的规格");
	const sku = skus[0]!;
	return {
		source: {
			offerId: match.row.offerId,
			skuId: sku.skuId,
			specId: sku.specId,
			name: sku.name.trim() || sku.attrs?.filter((value) => value.trim()).join(" / ") || "规格名未提供",
			image: sourceImage(sku.image),
			url: `https://detail.1688.com/offer/${match.row.offerId}.html`,
			readAt: match.row.readAt?.toISOString() ?? null,
			basis: "listing_sku",
		},
		sourceWarning: null,
	};
}

export function enrichProductSources(target: { shop: string; shopId: string }, fact: ProductFact, rows: CatalogSourceRow[]): ProductFact {
	const own = rows.filter((row) => row.shop === target.shop && row.shopId === target.shopId && row.productId === fact.productId);
	const skuCounts = new Map<string, number>();
	for (const model of fact.models ?? []) if (model.sku) skuCounts.set(model.sku, (skuCounts.get(model.sku) ?? 0) + 1);
	return {
		...fact,
		models:
			fact.models?.map((model) => ({
				...model,
				...(model.sku && skuCounts.get(model.sku)! > 1
					? { source: null, sourceWarning: "Shopee 同一 SKU 对应多个规格，无法确认逐规格的 1688 对应" }
					: sourceOf(model, own)),
			})) ?? null,
	};
}
