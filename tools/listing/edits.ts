// 人说了的改动现在能不能做、改成什么：放弃、定类目、保留的图、估重量和国内运费。纯的判断，库的读写在 index.ts

import { categoryAllowed } from "./category.ts";
import type { Pic, Pics } from "./pics.ts";
import { freightOf, type Need } from "./pricing.ts";
import { LABEL, numbered } from "./product.ts";
import type { OfferLike } from "./row.ts";

/** 放弃：已上架的是下架、建了商品的是不 publish，都不是放弃；建商品、上架还没核清的可能已经建了，先核清 */
export function cancelBlock(
	name: string,
	l: { cancelled: boolean; product_id: string | null; listed_at: unknown },
	unsure: { op: string; status: string }[],
): string | null {
	if (l.cancelled) return null;
	if (l.listed_at) return `${name}已上架（商品 ${l.product_id ?? "—"}）：不卖了是下架，不是放弃`;
	if (l.product_id) return `${name}已经建了商品（商品 ${l.product_id}，下架）：不上架就不 publish，不是放弃`;
	if (unsure.length) return `${name}在建商品中（${unsure.map((w) => `${w.op}：${w.status}`).join("；")}）：可能已经建了，先核清（x2 verify）`;
	return null;
}

/** 人定的类目：建了商品的不改；店铺设置了允许的类目，要在里面 */
export function categoryBlock(
	name: string,
	l: { shop: string; product_id: string | null; listed_at: unknown },
	category: string,
	full: string,
	allowed: Set<string> | null,
	exception?: unknown,
): string | null {
	if (l.product_id || l.listed_at) return `${name}已经建了商品（商品 ${l.product_id ?? "—"}）：不改类目`;
	if (!categoryAllowed(category, allowed, exception)) return `${name}：「${full}」不在 ${l.shop} 允许的类目里（店铺设置的「允许的类目」）`;
	return null;
}

/** 保留的图：按图的名字（主图 N、详情图 N）找图；没有的、人删的不收；x2 去掉的（drop 是 Gemini 文字检查写的）放回来 */
export function keepImages(
	name: string,
	asked: string[],
	images: Partial<Pics>,
	removed: string[],
	dropPrefix: string,
): { imageIds: string[]; restored: string[] } | { error: string } {
	const named = new Map<string, Pic>();
	for (const role of ["main", "detail"] as const) for (const { pic, n } of numbered(images, role)) named.set(`${LABEL[role]} ${n}`, pic);
	const unknown = asked.filter((x) => !named.has(x));
	if (unknown.length) return { error: `${name}没有${unknown.join("、")}（有：${[...named.keys()].join("、") || "无"}）` };
	const deleted = asked.filter((x) => removed.includes(named.get(x)!.imageId!));
	if (deleted.length) return { error: `${name}的${deleted.join("、")}是人删的（已删除的图），不放回来` };
	return {
		imageIds: [...new Set(asked.map((x) => named.get(x)!.imageId!))],
		restored: asked.filter((x) => named.get(x)!.drop?.startsWith(dropPrefix)),
	};
}

/** 估重量、国内运费：只填空着的（人填过的、估过的不动），1688 给了的不用估 */
export function estimateFill(
	l: { weight_kg: unknown; freight_rmb: unknown; offer: OfferLike | null },
	needs: Need[],
	given: { weight?: number | undefined; freight?: number | undefined },
): { set: { weight_kg?: number; freight_rmb?: number }; notes: string[] } {
	const notes: string[] = [],
		set: { weight_kg?: number; freight_rmb?: number } = {};
	if (given.weight !== undefined) {
		if (l.weight_kg !== null) notes.push(`重量：已有 ${Number(l.weight_kg)} kg（人填的或估过的），不改`);
		else if (!needs.includes("重量")) notes.push("重量：1688 给了每个规格的重量，不用估");
		else {
			set.weight_kg = given.weight;
			notes.push(`重量：记为 ${given.weight} kg`);
		}
	}
	if (given.freight !== undefined) {
		const known = freightOf(l.offer, null);
		if (l.freight_rmb !== null) notes.push(`国内运费：已有 ${Number(l.freight_rmb)} 元/件（人填的或估过的），不改`);
		else if (known !== null) notes.push(`国内运费：${l.offer?.tags?.freeShipping ? "货源包邮" : `1688 读得到（${known} 元/件）`}，不用估`);
		else {
			set.freight_rmb = given.freight;
			notes.push(`国内运费：记为 ${given.freight} 元/件`);
		}
	}
	return { set, notes };
}
