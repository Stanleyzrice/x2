// 单次制作的显式货源范围：保留完整1688事实，排除未选规格供后续重做沿用。
import type { Offer } from "../../connectors/sites/1688/api.ts";
import { skuOf } from "./variants.ts";

export function sourceScope(offer: Offer, selected: string[] | undefined, previous: string[]): string[] {
	if (!selected) return previous;
	const wanted = new Set(selected);
	for (const id of wanted) {
		const sku = offer.skus.find((s) => s.skuId === id);
		if (!sku) throw new Error(`1688 SKU ${id} 不存在于货源 ${offer.offerId}`);
		if (sku.stock <= 0) throw new Error(`1688 SKU ${id} 当前无库存`);
	}
	const keep = new Set(offer.skus.filter((s) => wanted.has(s.skuId)).map((s) => skuOf(offer.offerId, s)));
	return [...new Set([...previous.filter((s) => !keep.has(s)), ...offer.skus.filter((s) => !wanted.has(s.skuId)).map((s) => skuOf(offer.offerId, s))])];
}
