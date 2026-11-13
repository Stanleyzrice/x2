// Catalog 引用固定店铺；网页只能调整查询条件和商品编号，不能替换服务端保存的店铺身份。
import { z } from "zod";
import { title } from "../../props.ts";

export const description =
	"Catalog（商品目录）：查看店铺商品；collect（人工采集）通过当前浏览器采集1688；candidates（上架备选区）保留原文原图并沿用既有上架流程";
export const props = z.strictObject({
	title,
	shop: z.string().min(1),
	mode: z.enum(["catalog", "collect", "candidates"]).default("catalog"),
	scope: z.literal("all").default("all"),
	defaultStatus: z.literal("1").default("1"),
});
export type Props = z.infer<typeof props>;
export const actions = {
	shops: "catalog.shops",
	products: "catalog.summaries",
	cachedProduct: "catalog.cached-product",
	product: "catalog.product",
	sync: "catalog.sync",
	statusResult: "catalog.status-result",
	reconcileStatus: "catalog.reconcile-status",
	collectionOpen: "listing.collection-open",
	collectionState: "listing.collection-state",
	collectionStop: "listing.collection-stop",
	sources: "listing.sources",
	sourceDetail: "listing.source-detail",
	sourceUpdate: "listing.source-update",
	sourceDelete: "listing.source-delete",
	sourcePrepare: "listing.source-prepare",
	sourcePublishResult: "listing.source-publish-result",
};
export const writeActions = { setStatus: "catalog.set-status", sourcePublish: "listing.source-publish" };
export const writePreviews = { setStatus: "catalog.status-preview", sourcePublish: "listing.source-publish-preview" };
export const inputs = [
	"query",
	"status",
	"stock",
	"category",
	"page",
	"pageSize",
	"productId",
	"targetState",
	"requestId",
	"platform",
	"pageUrl",
	"marker",
	"sessionId",
	"targetShop",
	"sourceId",
	"sourceIds",
	"title",
	"description",
	"weightKg",
	"freightRmb",
	"minQty",
	"daysToShip",
	"categoryPath",
	"attributes",
	"stocks",
	"prices",
	"mainImages",
	"detailImages",
];
export const examples: z.input<typeof props>[] = [{ shop: "ni1206" }, { shop: "cheeroutdoor", title: "cheeroutdoor Catalog" }];
