// 建商品、上架（写）：只发一次请求、回结果；读回对账用 products.ts 的读（商品详情、物流渠道）。
// 只经平台登记的写操作调用；这里解析接口响应，不决定提交时机或经营条件。
import { z } from "zod";
import { submit } from "../../../platform/tool.ts";
import { allProducts, createProduct, productInfo, setUnlisted, unlistFromList, updateProduct } from "./products.ts";
import { ItemId, ModelId } from "./seller.ts";

/** 从全部商品列表按名称筛选，再读详情匹配 parent_sku；同时覆盖在售和下架状态。 */
export async function findByParentSku(parentSku: string, name: string): Promise<string | null> {
	for (let page = 1; page <= 20; page++) {
		const r = await allProducts(page);
		for (const p of r.rows.filter((x) => x.name === name)) if ((await productInfo(p.productId)).parent_sku === parentSku) return p.productId;
		if (page * 48 >= r.total || r.rows.length === 0) break;
	}
	return null;
}

/** 建好以后的答复里有商品 id（product_id，旧的叫 id）；没有、认不出都是结果未知，不是失败 */
const created = z.looseObject({ product_id: z.union([z.number(), z.string()]).nullish(), id: z.union([z.number(), z.string()]).nullish() }).nullish();

export const createListing = submit(
	"建商品：提交输入的 product_info（只经业务工具的写工具调）",
	z.object({ productInfo: z.record(z.string(), z.unknown()).describe("create_product_info 的 product_info") }),
	async (p) => {
		const w = await createProduct(p.productInfo);
		if (w.kind === "refused") return { kind: "refused", why: `${w.code ?? ""} ${w.why}`.trim() };
		if (w.kind !== "done") return w;
		const d = created.safeParse(w.data);
		const id = String((d.success ? (d.data?.product_id ?? d.data?.id) : undefined) ?? "");
		if (!/^\d+$/.test(id) || id === "0") return { kind: "unknown", why: "Shopee 说建好了，但没回商品 id" };
		return { kind: "done", data: { productId: id } };
	},
);

export const listProduct = submit(
	"上架：下架 → 在售（只经业务工具的写工具调）",
	z.object({ productId: z.string().regex(/^\d+$/).describe("商品 id") }),
	async (p) => {
		const w = await setUnlisted(p.productId, false);
		return w.kind === "done" ? { kind: "done" } : w.kind === "refused" ? { kind: "refused", why: `${w.code ?? ""} ${w.why}`.trim() } : w;
	},
);

export const unlistProduct = submit(
	"下架：在售 → 下架（只经业务工具的写工具调）",
	z.object({
		productId: ItemId.refine((id) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0).describe("商品 id"),
		shopId: z.string().regex(/^\d+$/).describe("店铺 id（列表签名使用）"),
	}),
	async (p) => {
		const w = await unlistFromList(p.productId, p.shopId);
		return w.kind === "done" ? { kind: "done", data: w.data } : w.kind === "refused" ? { kind: "refused", why: `${w.code ?? ""} ${w.why}`.trim() } : w;
	},
);

export const editProduct = submit(
	"修改商品名稱和規格價格（只经业务工具的写工具调）",
	z.object({
		productId: ItemId,
		title: z.string().min(1),
		models: z.array(z.object({ id: ModelId, tier_index: z.array(z.number().int().nonnegative()), price: z.string() })).optional(),
	}),
	async (p) => {
		const w = await updateProduct(p.productId, { name: p.title, ...(p.models ? { model_list: p.models.map((m) => ({ ...m, id: Number(m.id) })) } : {}) });
		return w.kind === "refused" ? { kind: "refused", why: `${w.code ?? ""} ${w.why}`.trim() } : w;
	},
);
