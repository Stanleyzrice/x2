// 商品稿 → 要建的商品（product_info），和还缺什么。检查、x2 propose、x2 run 都用它：批准时的 product_info 和执行时现组的一样，才算人看过的就是要建的
import { createHash } from "node:crypto";
import type { Pics } from "./images.ts";
import type { Settings } from "./make.ts";
import { type Product, productInfo, usedPics } from "./product.ts";
import { OLD_SPECS, specsOf, specsProblems } from "./variants.ts";

/** 商品稿（库里的一行）→ 要建的商品；缺的写成问题。规格只读存着的那一份（先核一遍规格的规矩）；已删除的图不用 */
export function productOf(l: any, s: Settings): { product?: Product; info?: Record<string, unknown>; hash?: string; problems: string[] } {
	const problems: string[] = [];
	if (!l.offer) return { problems: ["未做商品稿"] };
	const specs = specsOf(l.variants);
	if (!specs) return { problems: [OLD_SPECS] };
	if (l.problems) problems.push(...String(l.problems).split("\n"));
	if (!l.title || !l.description) problems.push("未写文案");
	if (specs.variants.some((v) => v.priceTwd === null)) problems.push("有规格未定价");
	const dropped = new Set((l.removed_variants ?? []) as string[]);
	if (specs.variants.some((v) => dropped.has(v.sku))) problems.push("规格：已移除的规格还在，待重做商品稿（x2 listing make）");
	problems.push(...specsProblems(specs));
	if (!l.category_path?.length) problems.push("未定类目");
	if (!l.days_to_ship) problems.push("未定备货天数");
	if (problems.length) return { problems: [...new Set(problems)] };
	const pics = (l.images ?? {}) as Pics;
	const removed = new Set<string>([...((l.removed_images ?? []) as string[])]);
	// 规格图：第一层的选项挂；图被筛掉、删掉的选项不挂图
	const used = new Set(specs.tiers[0]!.options.map((o) => o.image));
	const optionImages = Object.fromEntries((pics.options ?? []).filter((p) => !p.drop && p.imageId && !removed.has(p.imageId) && used.has(p.from)).map((p) => [p.from, p.imageId!]));
	const tiers = specs.tiers.map((t, a) => (a > 0 ? t : { ...t, options: t.options.map((o) => (o.image && !optionImages[o.image] ? { ...o, image: null } : o)) }));
	const product: Product = {
		parentSku: `LT${l.offer_id}`, title: String(l.title), description: String(l.description), categoryPath: (l.category_path as unknown[]).map(Number),
		attributes: l.attributes ?? [], preOrder: s.preOrder, daysToShip: Number(l.days_to_ship), minPurchase: s.minPurchase, channels: s.channels,
		tiers, variants: specs.variants.map((v) => ({ ...v, priceTwd: v.priceTwd! })),
		images: usedPics(pics, "main", removed).map(({ pic }) => pic.imageId!),
		detail: usedPics(pics, "detail", removed).map(({ pic }) => ({ id: pic.imageId!, width: pic.width!, height: pic.height! })),
		optionImages, sizeChart: null,
	};
	try {
		const info = productInfo(product);
		return { product, info, hash: createHash("sha256").update(JSON.stringify(info)).digest("hex"), problems };
	} catch (e) {
		return { problems: [(e as Error).message] };
	}
}
