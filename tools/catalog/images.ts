// 打开单件商品时现读完整 Shopee 详情；只在响应中更新事实，不写回目录快照或外站。
import { type ProductInfo, productImageUrl, productInfo } from "../../connectors/sites/shopee/products.ts";
import { shop as identity } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import { productContent } from "./description.ts";
import { checkIdentity, type Identity, type ProductFact, productFact } from "./facts.ts";

export type ImageReader = {
	where<T>(shopId: string, fn: () => Promise<T>): Promise<T>;
	identity(): Promise<Identity>;
	detail(productId: string): Promise<ProductInfo>;
};
export const catalogImageReader: ImageReader = { where: (shopId, fn) => inAccount("shopee", shopId, fn), identity, detail: productInfo };

export async function enrichProductImages(
	target: { shop: string; shopId: string },
	fact: ProductFact,
	reader: ImageReader = catalogImageReader,
): Promise<ProductFact & { imageError: string | null; detailReadAt: string | null }> {
	let content: ReturnType<typeof productContent> | undefined;
	try {
		const info = await reader.where(target.shopId, async () => {
			checkIdentity(target, await reader.identity());
			const detail = await reader.detail(fact.productId);
			checkIdentity(target, await reader.identity());
			return detail;
		});
		if (info.id == null || String(info.id) !== fact.productId) throw new Error("Shopee 详情商品编号不匹配或未返回");
		// 描述和图片与 SKU 独立，规格未返回时仍保留同次读取的有效详情内容。
		content = productContent(info);
		if (!info.model_list?.length) throw new Error("Shopee 未返回规格明细");
		const modelIds = info.model_list.map((m) => m.id);
		if (modelIds.some((id) => !id) || new Set(modelIds).size !== modelIds.length) throw new Error("Shopee 规格编号缺失或重复");
		const rawStatus = info.status;
		const status = rawStatus != null && String(rawStatus).trim() && Number.isInteger(Number(rawStatus)) ? Number(rawStatus) : null;
		const cover = typeof info.images?.[0] === "string" ? productImageUrl(info.images[0]) : null;
		const fresh = productFact({ productId: fact.productId, name: fact.name, status, cover: cover ?? fact.cover ?? "" }, info);
		const single = info.model_list.length === 1 && info.std_tier_variation_list?.length === 0;
		const models = fresh.models!.map((model) => ({
			...model,
			name: single && model.name === "规格名未知" ? "默认规格" : model.name,
			image: model.image ?? (single ? cover : null),
			imageSource: model.image ? ("sku" as const) : single && cover ? ("product" as const) : undefined,
		}));
		const detailError =
			single && fresh.detailError === "部分规格名称未返回"
				? models.some((m) => m.modelId === null || m.price === null || m.stock === null)
					? "部分规格的 id、价格或库存未返回"
					: null
				: fresh.detailError;
		return { ...fresh, ...content, models, detailError, imageError: null, detailReadAt: new Date().toISOString() };
	} catch (e) {
		return { ...fact, ...content, imageError: `Shopee SKU 规格和图片读取失败，当前展示规格目录快照：${(e as Error).message}`, detailReadAt: null };
	}
}
