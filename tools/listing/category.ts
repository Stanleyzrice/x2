// 类目、属性、备货天数：照 lilto 的 shopee_base.py（快照 1c8a7926）。
// 类目：Shopee 按标题加一张已传的图推荐（只给标题回空），取第一个；要在本店允许的类目里。
// 属性：只送必填的，值一字不差取自属性树（编的值发布被拒）：只有「是 / 否」的选「否」，有「其他」「一般」的选它，不然选第一个；
// 要填字的必填属性（属性树里没有可选值）不拿标题编，交给人。备货天数取这个类目的上限（10、15、30 天）
// 推荐的不对、不在本店允许的类目里：人定（x2 listing category --id <商品稿> --category <叶子类目 id>），做商品稿不再问推荐
import { z } from "zod";
import type { Attribute, Category, Recommended } from "../../connectors/sites/shopee/products.ts";

export const CATEGORY_PROBLEM = /^(类目|属性|备货天数)：/;

export const categoryExceptionSchema = z.object({ categoryId: z.string().regex(/^\d+$/), reason: z.string().trim().min(1) });
export type CategoryException = z.output<typeof categoryExceptionSchema>;

/** 显式单稿例外只对该叶子有效；未记录理由、改成其他类目都仍按店铺范围检查。 */
export function categoryAllowed(category: string, allowed: Set<string> | null, exception?: unknown): boolean {
	if (!allowed || allowed.has(category)) return true;
	const parsed = categoryExceptionSchema.safeParse(exception);
	return Boolean(parsed.success && parsed.data.categoryId === category);
}

export function leafPath(tree: Category[], id: string): { path: number[]; names: string[] } | { error: string } {
	const find = (list: Category[], up: Category[]): Category[] | null => {
		for (const c of list) {
			const r = c.id === id ? [...up, c] : find(c.children, [...up, c]);
			if (r) return r;
		}
		return null;
	};
	const hit = find(tree, []);
	if (!hit) return { error: `Shopee 的类目树里没有类目 ${id}` };
	const names = hit.map((c) => c.name);
	const leaf = hit[hit.length - 1]!;
	if (leaf.children.length)
		return { error: `「${names.join(" > ")}」不是叶子类目，选它下面的：${leaf.children.map((c) => `${c.name}（${c.id}）`).join("、")}` };
	return { path: hit.map((c) => Number(c.id)), names };
}

export function recommendedPath(data: Recommended): { path: number[]; names: string[] } | null {
	const first = (data?.category_recommend_list ?? [])[0];
	const path = ((first?.category_path ?? []) as unknown[]).map(Number);
	if (!path.length || path.some((n) => !Number.isInteger(n) || n <= 0)) return null;
	const names = ((first?.category_path_name ?? first?.display_path ?? first?.category_name_list ?? []) as unknown[]).map(String);
	return { path, names };
}

export function pickAttributes(tree: Attribute[]): {
	attributes: { attribute_id: number; attribute_values: { value_id: number }[] }[];
	text: string[];
	missing: string[];
} {
	const attributes: { attribute_id: number; attribute_values: { value_id: number }[] }[] = [],
		text: string[] = [],
		missing: string[] = [];
	for (const a of tree.filter((x) => x.mandatory)) {
		if (!a.values.length) {
			missing.push(a.name);
			continue;
		}
		const names = a.values.map((v) => v.name);
		const pick =
			names.every((n) => n === "是" || n === "否") && names.includes("否") ? "否" : (names.find((n) => n.includes("其他") || n.includes("一般")) ?? names[0]!);
		const v = a.values.find((x) => x.name === pick)!;
		attributes.push({ attribute_id: Number(a.id), attribute_values: [{ value_id: Number(v.valueId) }] });
		text.push(`${a.name}：${pick}`);
	}
	return { attributes, text, missing };
}

export function daysToShip(categoryId: number, rules: { categoryIds: string[]; min: number; max: number }[]): number | null {
	const r = rules.find((x) => x.categoryIds.includes(String(categoryId)));
	return r ? r.max : null;
}
