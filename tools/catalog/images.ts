// 老快照缺 SKU 图片时只读所选商品；仅在响应中补图，不覆盖状态、价格、库存、货源或数据库事实。
import { type ProductInfo, productInfo, productModelImage } from "../../connectors/sites/shopee/products.ts";
import { shop as identity } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import { checkIdentity, type Identity, type ProductFact } from "./facts.ts";

export type ImageReader = {
	where<T>(shopId: string, fn: () => Promise<T>): Promise<T>;
	identity(): Promise<Identity>;
	detail(productId: string): Promise<ProductInfo>;
};
export const catalogImageReader: ImageReader = { where: (shopId, fn) => inAccount("shopee", shopId, fn), identity, detail: productInfo };

export async function enrichProductImages(
	target: { shop: string; shopId: string },
	fact: ProductFact,
	reader: ImageReader = catalogImageReader,
): Promise<ProductFact & { imageError: string | null }> {
	if (!fact.models?.some((m) => m.image === undefined)) return { ...fact, imageError: null };
	const missing = fact.models.map((m) => ({ ...m, image: m.image ?? null }));
	try {
		const info = await reader.where(target.shopId, async () => {
			checkIdentity(target, await reader.identity());
			const detail = await reader.detail(fact.productId);
			checkIdentity(target, await reader.identity());
			return detail;
		});
		if (info.id != null && String(info.id) !== fact.productId) throw new Error("Shopee 图片详情商品编号不匹配");
		const byId = new Map<string, NonNullable<ProductInfo["model_list"]>[number]>();
		const duplicates = new Set<string>();
		for (const model of info.model_list ?? []) {
			if (!model.id) continue;
			if (byId.has(model.id)) duplicates.add(model.id);
			byId.set(model.id, model);
		}
		let unmatched = 0;
		const models = fact.models.map((cached) => {
			if (cached.image !== undefined) return cached;
			const live = cached.modelId && !duplicates.has(cached.modelId) ? byId.get(cached.modelId) : undefined;
			const sameTier = live && JSON.stringify((live.tier_index ?? []).map(Number)) === JSON.stringify(cached.tierIndex);
			if (!sameTier || !live) {
				unmatched++;
				return { ...cached, image: null };
			}
			return { ...cached, image: productModelImage(info, live) };
		});
		return { ...fact, models, imageError: unmatched ? `${unmatched} 个 SKU 的图片未能按 modelId 和 tierIndex 明确对应，保留缺图` : null };
	} catch (e) {
		return { ...fact, models: missing, imageError: `SKU 图片读取失败：${(e as Error).message}` };
	}
}
