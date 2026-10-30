// 建商品、上架（写）：只发一次请求、回结果；读回对账用 products.ts 的读（商品详情、物流渠道）。
// 只经业务工具的写工具调：组 product_info、看还该不该建、读回来怎么比都是业务工具的事
import { z } from "zod";
import { submit } from "../../../platform/tool.ts";
import { allProducts, createProduct, productInfo, setUnlisted } from "./products.ts";

/** 建商品结果未知时按货号找：新建的是下架，在售列表里没有，翻全部商品；名字一样的再读详情核对货号 */
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
	"建商品（先建成下架；只经业务工具的写工具调）",
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
