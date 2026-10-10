// 商品稿 → 要建的商品（product_info），和还缺什么。检查、x2 propose、x2 run 都用它：批准时的 product_info 和执行时现组的一样，才算人看过的就是要建的
import { createHash } from "node:crypto";
import type { Pics } from "./images.ts";
import type { Settings } from "./make.ts";
import { type Product, productInfo } from "./product.ts";
import type { Priced } from "./make.ts";

/** 商品稿（库里的一行）→ 要建的商品；缺的写成问题。人删掉的图不用 */
export function productOf(l: any, s: Settings): { product?: Product; info?: Record<string, unknown>; hash?: string; problems: string[] } {
	const problems: string[] = [];
	if (!l.offer) return { problems: ["还没做商品稿"] };
	if (l.problems) problems.push(...String(l.problems).split("\n"));
	if (!l.title || !l.description) problems.push("还没写文案");
	const pics = (l.images ?? {}) as Pics;
	const removed = new Set<string>([...((l.removed_images ?? []) as string[])]);
	const usable = (list: Pics["main"] = []) => list.filter((p) => !p.drop && p.imageId && !removed.has(p.imageId));
	const variants = ((l.variants ?? []) as Priced[]).map((v) => ({ ...v }));
	if (variants.some((v) => v.priceTwd === null)) problems.push("有规格没定价");
	if (!l.category_path?.length) problems.push("还没定类目");
	if (!l.days_to_ship) problems.push("还没定备货天数");
	if (problems.length) return { problems };
	// 规格图被筛掉的选项不挂图
	const optionImages = Object.fromEntries(usable(pics.options).map((p) => [p.from, p.imageId!]));
	for (const v of variants) if (v.image && !optionImages[v.image]) v.image = null;
	const product: Product = {
		parentSku: `LT${l.offer_id}`, title: String(l.title), description: String(l.description), categoryPath: (l.category_path as unknown[]).map(Number),
		attributes: l.attributes ?? [], preOrder: s.preOrder, daysToShip: Number(l.days_to_ship), minPurchase: s.minPurchase, channels: s.channels,
		variants: variants.map((v) => ({ ...v, priceTwd: v.priceTwd! })),
		images: usable(pics.main).slice(0, 9).map((p) => p.imageId!),
		detail: usable(pics.detail).slice(0, 12).map((p) => ({ id: p.imageId!, width: p.width!, height: p.height! })),
		optionImages, sizeChart: null,
	};
	try {
		const info = productInfo(product);
		return { product, info, hash: createHash("sha256").update(JSON.stringify(info)).digest("hex"), problems };
	} catch (e) {
		return { problems: [(e as Error).message] };
	}
}
