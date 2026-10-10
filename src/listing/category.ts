// 类目、属性、备货天数：照 lilto 的 shopee_base.py（快照 1c8a7926）。docs/listing.md「每一步怎样算做完」
// 类目：Shopee 按标题加一张已传的图推荐（只给标题回空），取第一个；要在本店允许的类目里。
// 属性：只送必填的，值一字不差取自属性树（编的值发布被拒）：只有「是 / 否」的选「否」，有「其他」「一般」的选它，不然选第一个；
// 要填字的必填属性（属性树里没有可选值）不拿标题编，交给人。备货天数取这个类目的上限（10、15、30 天）
import type { Attribute } from "../site/shopee/products.ts";

/** get_recommended_category 的 data → 第一个推荐的类目路径（叶子在最后）和名字 */
export function recommendedPath(data: any): { path: number[]; names: string[] } | null {
	const first = (data?.category_recommend_list ?? [])[0];
	const path = ((first?.category_path ?? []) as unknown[]).map(Number);
	if (!path.length || path.some((n) => !Number.isInteger(n) || n <= 0)) return null;
	const names = ((first?.category_path_name ?? first?.display_path ?? first?.category_name_list ?? []) as unknown[]).map(String);
	return { path, names };
}

/** 必填属性 → product_info 的 attributes；要人填的列出来 */
export function pickAttributes(tree: Attribute[]): { attributes: { attribute_id: number; attribute_values: { value_id: number }[] }[]; text: string[]; missing: string[] } {
	const attributes: { attribute_id: number; attribute_values: { value_id: number }[] }[] = [], text: string[] = [], missing: string[] = [];
	for (const a of tree.filter((x) => x.mandatory)) {
		if (!a.values.length) { missing.push(a.name); continue; }
		const names = a.values.map((v) => v.name);
		const pick = names.every((n) => n === "是" || n === "否") && names.includes("否") ? "否" : names.find((n) => n.includes("其他") || n.includes("一般")) ?? names[0]!;
		const v = a.values.find((x) => x.name === pick)!;
		attributes.push({ attribute_id: Number(a.id), attribute_values: [{ value_id: Number(v.valueId) }] });
		text.push(`${a.name}：${pick}`);
	}
	return { attributes, text, missing };
}

/** 这个类目的备货天数上限（预售）；类目没有规则回 null */
export function daysToShip(categoryId: number, rules: { categoryIds: string[]; min: number; max: number }[]): number | null {
	const r = rules.find((x) => x.categoryIds.includes(String(categoryId)));
	return r ? r.max : null;
}
