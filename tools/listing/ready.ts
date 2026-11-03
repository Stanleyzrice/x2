// 商品稿 → 要建的商品（product_info），和还缺什么。检查、x2 listing publish、建商品都用它：交给 x2 时的 product_info 和执行时现组的一样，才算人看过的就是要建的
import { createHash } from "node:crypto";
import type { Pics } from "./pics.ts";
import { estimateNeeds, pricingProblems, reprice, type Settings } from "./pricing.ts";
import { type Product, productInfo, usedPics } from "./product.ts";
import { purchaseLimitOf } from "./purchase-limit.ts";
import type { ListingRow } from "./row.ts";
import { OLD_SPECS, specsOf, structureProblems } from "./variants.ts";

export function productOf(l: ListingRow, s: Settings): { product?: Product; info?: Record<string, unknown>; hash?: string; problems: string[] } {
	const problems: string[] = [];
	if (!l.offer) return { problems: ["未做商品稿"] };
	const specs = specsOf(l.variants);
	if (!specs) return { problems: [OLD_SPECS] };
	if (l.problems) problems.push(...String(l.problems).split("\n"));
	if (!l.title || !l.description) problems.push("未写文案");
	const dropped = new Set((l.removed_variants ?? []) as string[]);
	if (specs.variants.some((v) => dropped.has(v.sku))) problems.push("规格：已移除的规格还在，待重做商品稿（x2 listing make）");
	problems.push(...pricingProblems(specs, estimateNeeds(l)), ...structureProblems(specs));
	if (s.template && reprice(l, s)?.changed) problems.push("核价：模板规则、成本或售价已变，待重新核价（x2 status）");
	if (!l.category_path?.length) problems.push("未定类目");
	if (!l.days_to_ship) problems.push("未定备货天数");
	if (problems.length) return { problems: [...new Set(problems)] };
	const pics = (l.images ?? {}) as Pics;
	const removed = new Set<string>([...((l.removed_images ?? []) as string[])]);
	const used = new Set(specs.tiers[0]!.options.map((o) => o.image));
	const optionImages = Object.fromEntries(
		(pics.options ?? []).filter((p) => !p.drop && p.imageId && !removed.has(p.imageId) && used.has(p.from)).map((p) => [p.from, p.imageId!]),
	);
	const tiers = specs.tiers.map((t, a) =>
		a > 0 ? t : { ...t, options: t.options.map((o) => (o.image && !optionImages[o.image] ? { ...o, image: null } : o)) },
	);
	const product: Product = {
		parentSku: `LT${l.offer_id}`,
		title: String(l.title),
		description: String(l.description),
		categoryPath: (l.category_path as unknown[]).map(Number),
		attributes: l.attributes ?? [],
		preOrder: s.preOrder,
		daysToShip: Number(l.days_to_ship),
		minPurchase: purchaseLimitOf(l, s.minPurchase),
		channels: s.channels,
		tiers,
		variants: specs.variants.map((v) => ({ ...v, priceTwd: v.priceTwd! })),
		images: usedPics(pics, "main", removed).map(({ pic }) => pic.imageId!),
		detail: usedPics(pics, "detail", removed).map(({ pic }) => ({ id: pic.imageId!, width: pic.width!, height: pic.height! })),
		optionImages,
		sizeChart: null,
	};
	try {
		const info = productInfo(product);
		return { product, info, hash: createHash("sha256").update(JSON.stringify(info)).digest("hex"), problems };
	} catch (e) {
		return { problems: [(e as Error).message] };
	}
}
