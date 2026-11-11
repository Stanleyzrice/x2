// 旧商品缺少商品稿时，以真实1688规格完整重建40字符商家SKU；仅补充来源事实，不选用货源或修改Shopee资料。
import { z } from "zod";
import { OfferId, offer as read1688Offer } from "../../connectors/sites/1688/api.ts";
import type { CatalogModel, ProductFact } from "./facts.ts";

export type EncodedSourceOffer = {
	offerId: string;
	skus: { skuId: string; specId: string; name: string; attrs?: string[]; image?: string | null }[];
};
export type EncodedSourceSnapshot = { offerId: string; offer: unknown; readAt: Date | null; error: string | null };

const sourceOffer = z.object({
	offerId: z.string().regex(/^\d+$/),
	skus: z.array(
		z.object({
			skuId: z.string().regex(/^\d+$/),
			specId: z.string(),
			name: z.string(),
			attrs: z.array(z.string()).optional(),
			image: z.string().nullish(),
		}),
	),
});
const missingWarnings = new Set(["未保存此商品的 SKU 货源对应", "商品稿没有此 SKU 的货源对应"]);
const fallback = (model: CatalogModel) => !model.source && missingWarnings.has(model.sourceWarning ?? "");
const encodedId = (sku: string | null) => (sku && sku.length <= 40 ? /^LT(\d+)-([^\s]+)$/.exec(sku)?.[1] : undefined);
const parentMatches = (fact: ProductFact, offerId: string) => !fact.parentSku || fact.parentSku === `LT${offerId}`;

function skuCounts(fact: ProductFact): Map<string, number> {
	const counts = new Map<string, number>();
	for (const model of fact.models ?? []) if (model.sku) counts.set(model.sku, (counts.get(model.sku) ?? 0) + 1);
	return counts;
}

export function encodedOfferIds(fact: ProductFact): string[] {
	const counts = skuCounts(fact);
	return [
		...new Set(
			(fact.models ?? []).flatMap((model) => {
				const id = fallback(model) && counts.get(model.sku ?? "") === 1 ? encodedId(model.sku) : undefined;
				return id && parentMatches(fact, id) ? [id] : [];
			}),
		),
	];
}

function sourceImage(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) ? url.href : null;
	} catch {
		return null;
	}
}

export function enrichEncodedProductSources(fact: ProductFact, snapshots: EncodedSourceSnapshot[]): ProductFact {
	const counts = skuCounts(fact);
	const models = fact.models?.map((model): CatalogModel => {
		if (!fallback(model) && model.source?.basis !== "encoded_sku") return model;
		const missing = (sourceWarning: string): CatalogModel => ({ ...model, source: null, sourceWarning });
		if (model.sku && counts.get(model.sku)! > 1) return missing("Shopee 同一 SKU 对应多个规格，无法确认逐规格的 1688 对应");
		const id = encodedId(model.sku);
		if (!id) return missing("SKU 不符合可核对的 LT 货号格式，1688 规格待核对");
		if (!parentMatches(fact, id)) return missing("父 SKU 与规格 SKU 的1688货源编号冲突，待核对");
		const found = snapshots.filter((snapshot) => snapshot.offerId === id);
		if (found.length !== 1) return missing(found.length ? "同一货源存在多个规格快照，待核对" : "尚未读取 LT 货号对应的1688规格，待核对");
		const snapshot = found[0]!;
		if (snapshot.error) return missing(`1688 货源读取失败：${snapshot.error}`);
		const parsed = sourceOffer.safeParse(snapshot.offer);
		if (!parsed.success) return missing("1688 货源规格资料不完整，无法核对 LT 货号");
		if (parsed.data.offerId !== id) return missing("1688 货源编号与规格快照不一致，待核对");
		const matched = parsed.data.skus.filter((sku) => `LT${id}-${sku.specId || sku.skuId}`.slice(0, 40) === model.sku);
		if (matched.length !== 1) return missing(matched.length ? "LT 货号对应多个1688规格，无法唯一核对" : "1688 当前规格没有与 LT 货号完整对应的规格，待核对");
		const sku = matched[0]!;
		if (parsed.data.skus.filter((other) => other.skuId === sku.skuId).length !== 1) return missing("1688 快照存在重复 SKU ID，待核对");
		return {
			...model,
			source: {
				offerId: id,
				skuId: sku.skuId,
				specId: sku.specId,
				name: sku.name.trim() || sku.attrs?.filter((value) => value.trim()).join(" / ") || "规格名未提供",
				image: sourceImage(sku.image),
				url: `https://detail.1688.com/offer/${id}.html`,
				readAt: snapshot.readAt?.toISOString() ?? null,
				basis: "encoded_sku",
			},
			sourceWarning: null,
		};
	});
	return { ...fact, models: models ?? null };
}

export async function readEncodedSourceSnapshots(
	fact: ProductFact,
	readOffer: (id: string) => Promise<unknown> = (id) => read1688Offer(OfferId.parse(id)),
): Promise<EncodedSourceSnapshot[]> {
	const snapshots: EncodedSourceSnapshot[] = [];
	for (const id of encodedOfferIds(fact)) {
		try {
			const parsed = sourceOffer.safeParse(await readOffer(id));
			if (!parsed.success) throw new Error("1688 货源规格回包格式不完整");
			if (parsed.data.offerId !== id) throw new Error("1688 货源编号与请求不一致");
			snapshots.push({ offerId: id, offer: parsed.data, readAt: new Date(), error: null });
		} catch (error) {
			snapshots.push({ offerId: id, offer: null, readAt: new Date(), error: error instanceof Error ? error.message || error.name : String(error) });
		}
	}
	return snapshots;
}
