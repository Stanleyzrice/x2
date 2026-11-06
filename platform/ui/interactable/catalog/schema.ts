// Catalog 引用固定店铺；网页只能调整查询条件和商品编号，不能替换服务端保存的店铺身份。
import { z } from "zod";
import { title } from "../../props.ts";

export const description = "店铺 Catalog：默认在售，可筛选已下架商品和库存；查看 SKU、1688 来源，逐件确认后切换商品上架状态";
export const props = z.strictObject({ title, shop: z.string().min(1), scope: z.literal("all").default("all"), defaultStatus: z.literal("1").default("1") });
export type Props = z.infer<typeof props>;
export const actions = {
	shops: "catalog.shops",
	products: "catalog.summaries",
	cachedProduct: "catalog.cached-product",
	product: "catalog.product",
	sync: "catalog.sync",
	statusResult: "catalog.status-result",
	reconcileStatus: "catalog.reconcile-status",
};
export const writeActions = { setStatus: "catalog.set-status" };
export const writePreviews = { setStatus: "catalog.status-preview" };
export const inputs = ["query", "status", "stock", "page", "pageSize", "productId", "targetState", "requestId"];
export const examples: z.input<typeof props>[] = [{ shop: "ni1206" }, { shop: "cheeroutdoor", title: "cheeroutdoor Catalog" }];
