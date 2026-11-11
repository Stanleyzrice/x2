// 已审图片只替换稿件的第一层规格选项图，不改1688原始offer中的图片和规格事实。
import { z } from "zod";
import { SkuId } from "../../connectors/sites/1688/api.ts";
import { Usage } from "../../platform/errors.ts";
import type { Specs } from "./variants.ts";

export const skuImagesSchema = z.array(z.object({ skuId: SkuId, url: z.url({ protocol: /^https?$/ }) })).min(1);
export type SkuImage = z.infer<typeof skuImagesSchema>[number];

export function withSkuImages(specs: Specs, images?: readonly SkuImage[]): Specs {
	if (!images?.length) return specs;
	const selected = new Map(specs.variants.map((v) => [v.skuId, v]));
	const seen = new Set<string>();
	const byOption = new Map<number, string>();
	for (const { skuId, url } of images) {
		if (seen.has(skuId)) throw new Usage(`规格图有重复 SKU ${skuId}`);
		seen.add(skuId);
		const variant = selected.get(skuId);
		if (!variant) throw new Usage(`商品稿未选用 SKU ${skuId}，不能指定规格图`);
		const index = variant.options[0];
		if (index === undefined || !specs.tiers[0]?.options[index]) throw new Usage(`SKU ${skuId} 没有对应的第一层规格选项`);
		const previous = byOption.get(index);
		if (previous !== undefined && previous !== url) throw new Usage("同一第一层规格选项不能指定不同图片");
		byOption.set(index, url);
	}
	const updated = structuredClone(specs);
	for (const [index, url] of byOption) updated.tiers[0]!.options[index]!.image = url;
	return updated;
}
