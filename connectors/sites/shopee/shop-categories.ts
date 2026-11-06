// 店铺导览分类（Shop Categories），不是商品的平台 category_path。
// 接口与字段来自卖家中心 decoration/category 页面；正式分类由同名草稿转换，写请求各发一次，业务层负责读回对账。
import { z } from "zod";
import { idText, reply } from "../../../platform/reply.ts";
import { parseJson, type Sent, submit } from "../../../platform/tool.ts";
import { seller, withData, write } from "./seller.ts";

const PREFIX = "/api/shopcategory/v4/category/";
const id = z
	.string()
	.regex(/^[1-9]\d*$/)
	.refine((v) => Number.isSafeInteger(Number(v)), "id 须为不丢精度的正整数");
const ids = z
	.array(id)
	.min(1)
	.refine((v) => new Set(v).size === v.length, "id 不能重复");
const name = z.string().min(1).max(40);
const status = z.enum(["active", "inactive", "deleted"]);
const category = z.looseObject({
	id: idText.pipe(id),
	name: z.string(),
	status,
	sort_weight: z.number(),
	type: z.string(),
	product_count: z.number().int().nonnegative(),
	product_id_list: z.array(idText.pipe(id)).optional(),
});
const listReply = withData(z.looseObject({ list: z.array(category) }));
const detailReply = withData(z.looseObject({ list: z.array(category.safeExtend({ product_id_list: z.array(idText.pipe(id)) })) }));
// 空草稿池的原生 data 是 {}；页面 module199 的 responseSchema 也只为 draftList 缺失补 []。
const draftReply = withData(z.looseObject({ draft_list: z.array(z.looseObject({ id: idText.pipe(id), name: z.string() })).default([]) }));

export type ShopCategory = {
	id: string;
	name: string;
	status: z.output<typeof status>;
	sortWeight: number;
	type: string;
	productCount: number;
	productIds?: string[];
};
export type ShopCategoryDraft = { id: string; name: string };

function categoryOf(r: z.output<typeof category>): ShopCategory {
	return {
		id: r.id,
		name: r.name,
		status: r.status,
		sortWeight: r.sort_weight,
		type: r.type,
		productCount: r.product_count,
		...(r.product_id_list ? { productIds: r.product_id_list } : {}),
	};
}

export function shopCategoriesOf(raw: unknown): ShopCategory[] {
	const list = reply(listReply, raw, "Shopee get_collection_list").data.list;
	if (new Set(list.map((r) => r.id)).size !== list.length) throw new Error("Shopee get_collection_list 回了重复分类 id");
	return list.map(categoryOf);
}

/** product_count 是有效商品数；异常/下架等成员仍可能留在 product_id_list，不能用 count 代替清单。 */
export function shopCategoryOf(raw: unknown, categoryId: string): ShopCategory {
	const list = reply(detailReply, raw, "Shopee get_collection").data.list;
	if (list.length !== 1 || list[0]!.id !== categoryId) throw new Error("Shopee get_collection 未返回唯一且匹配的分类 id");
	const value = categoryOf(list[0]!);
	if (new Set(value.productIds).size !== value.productIds!.length) throw new Error("Shopee get_collection 回了重复商品 id");
	return value;
}

export function shopCategoryDraftsOf(raw: unknown): ShopCategoryDraft[] {
	const list = reply(draftReply, raw, "Shopee get_collection_draft_list").data.draft_list;
	if (new Set(list.map((r) => r.id)).size !== list.length) throw new Error("Shopee get_collection_draft_list 回了重复草稿 id");
	return list.map((r) => ({ id: r.id, name: r.name }));
}

export async function shopCategories(): Promise<ShopCategory[]> {
	return shopCategoriesOf(await seller(`${PREFIX}get_collection_list/`, listReply, { query: { need_parent_shop_category: true } }));
}

export async function shopCategory(categoryId: string): Promise<ShopCategory> {
	const value = id.parse(categoryId);
	return shopCategoryOf(await seller(`${PREFIX}get_collection/`, detailReply, { query: { collection_ids: value } }), value);
}

export async function shopCategoryDrafts(): Promise<ShopCategoryDraft[]> {
	return shopCategoryDraftsOf(await seller(`${PREFIX}get_collection_draft_list/`, draftReply));
}

const createDraftInput = z.object({ name });
const createInput = z.object({ name, productIds: z.preprocess(parseJson, ids), draftId: id });
const statusInput = z.object({ id, status: z.enum(["active", "inactive"]) });
const sortInput = z.object({ ids: z.preprocess(parseJson, ids) });

export function createShopCategoryBody(input: { name: string; productIds: string[]; draftId: string }) {
	const p = createInput.parse(input);
	return {
		independent_shop_category: {
			name: p.name,
			collection_type: "customized",
			to_delete_draft_id: Number(p.draftId),
			product_id_list: p.productIds.map(Number),
		},
	};
}

export function sortShopCategoriesBody(input: { ids: string[] }) {
	const p = sortInput.parse(input);
	return { collection_list: p.ids.map((value, index) => ({ id: Number(value), sort_weight: p.ids.length - index })) };
}

async function send(endpoint: string, body: unknown): Promise<Sent> {
	const result = await write(`${PREFIX}${endpoint}/`, { method: "POST", body });
	return result.kind === "refused" ? { kind: "refused", why: `${result.code ?? ""} ${result.why}`.trim() } : result;
}

export async function createShopCategoryDraft(input: { name: string }): Promise<Sent> {
	return send("create_collection_draft", createDraftInput.parse(input));
}

export async function createShopCategory(input: { name: string; productIds: string[]; draftId: string }): Promise<Sent> {
	return send("create_parent_or_sub_category", createShopCategoryBody(input));
}

export async function setShopCategoryStatus(input: { id: string; status: "active" | "inactive" }): Promise<Sent> {
	const p = statusInput.parse(input);
	return send("update_category", { shop_category_id: Number(p.id), status: p.status });
}

export async function sortShopCategories(input: { ids: string[] }): Promise<Sent> {
	return send("update_shop_collection_sequence", sortShopCategoriesBody(input));
}

export const createShopCategoryDraftTool = submit("建立店铺分类草稿（只经业务工具的写工具调）", createDraftInput, createShopCategoryDraft);
export const createShopCategoryTool = submit("将指定草稿转为店铺自定义分类并加入商品（只经业务工具的写工具调）", createInput, createShopCategory);
export const setShopCategoryStatusTool = submit("显示或隐藏指定店铺分类（只经业务工具的写工具调）", statusInput, setShopCategoryStatus);
export const sortShopCategoriesTool = submit("按完整 id 顺序调整店铺分类（只经业务工具的写工具调）", sortInput, sortShopCategories);
