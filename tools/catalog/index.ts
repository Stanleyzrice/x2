// 店铺 Catalog：同步全状态目录、读取快照、搜索与查看规格；人工确认后逐件上下架。
import { z } from "zod";
import { db } from "../../platform/db/index.ts";
import { get, str, type Toolkit, write } from "../../platform/tool.ts";
import {
	planShopCategoryCreate,
	planShopCategoryDraft,
	planShopCategorySort,
	planShopCategoryStatus,
	readShopCategories,
	replayShopCategory,
	SHOP_CATEGORY_WRITES,
	shopCategoryCreateInput,
	shopCategoryDraftInput,
	shopCategoryReadInput,
	shopCategorySortInput,
	shopCategoryStatusInput,
} from "./shop-categories.ts";
import { CATALOG_STATUS_WRITES, planStatus, previewStatus, readStatusResult, reconcileStatus, replayStatus, statusInput, statusReference } from "./status.ts";
import { catalogShops, readCatalog, readProduct, syncCatalog } from "./store.ts";

const shop = str("已配置的店铺账号名");
export const queryParams = z.object({
	shop,
	query: z.string().default("").describe("商品名、商品 id、SKU 或规格关键词"),
	status: z
		.string()
		.default("all")
		.refine((s) => s === "all" || s === "unknown" || /^-?\d+$/.test(s), "状态须为 all、unknown 或网站状态码"),
	stock: z.enum(["all", "in_stock", "sold_out", "unknown"]).default("all"),
	page: z.coerce.number().int().positive().default(1),
	pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const catalog: Toolkit = {
	name: "catalog",
	title: "店铺 Catalog：全部状态、SKU、价格库存与已有 1688 关联",
	kind: "tool",
	schema: new URL("./schema.sql", import.meta.url),
	tools: {
		shops: get("已配置店铺及最近目录快照和刷新状态；不读外站", undefined, async () => catalogShops(await db())),
		sync: get(
			"读取 Shopee 全状态目录，核对分页和店铺身份后保存快照；失败保留旧快照，不改商品",
			z.object({ shop, scope: z.literal("all").default("all") }),
			async (p) => syncCatalog(await db(), p.shop),
			{ exit: (r) => (r.ok ? undefined : (r.errorKind ?? "error")) },
		),
		products: get("搜索当前目录快照，返回商品、价格库存、1688关联及采集/完整性/失败状态", queryParams, async (p) => readCatalog(await db(), p)),
		summaries: get("搜索目录快照概要，SKU 明细延后读取；不读外站", queryParams, async (p) => readCatalog(await db(), p, true)),
		"cached-product": get("读取单件目录缓存及已有货源规格；不读外站", z.object({ shop, productId: str("Shopee 商品 id") }), async (p) =>
			readProduct(await db(), p.shop, p.productId, undefined, true),
		),
		product: get(
			"读取该件 Shopee 最新规格、图片与价格库存，并按已有上品 SKU 对应 1688 规格；失败保留快照及错误，不修改网站或缓存",
			z.object({ shop, productId: str("Shopee 商品 id") }),
			async (p) => readProduct(await db(), p.shop, p.productId),
		),
		"shop-categories": get("现读店铺导航分类与草稿；--ids 可读取指定分类完整商品成员", shopCategoryReadInput, async (p) => readShopCategories(await db(), p)),
		"create-shop-category-draft": {
			...write("按已确认名称创建店铺分类草稿；结果未知不重发，首次 --try", shopCategoryDraftInput, planShopCategoryDraft),
			replay: (sql, p) => replayShopCategory(sql, "draft", p),
		},
		"create-shop-category": {
			...write("按已确认草稿创建店铺分类并归入指定商品；完整成员读回核对，首次 --try", shopCategoryCreateInput, planShopCategoryCreate),
			replay: (sql, p) => replayShopCategory(sql, "create", p),
		},
		"shop-category-status": {
			...write("修改店铺分类显示；隐藏仅限当前有效商品数为零的分类，首次 --try", shopCategoryStatusInput, planShopCategoryStatus),
			replay: (sql, p) => replayShopCategory(sql, "status", p),
		},
		"sort-shop-categories": {
			...write("按给定全部分类 id 排序；不改变分类成员，首次 --try", shopCategorySortInput, planShopCategorySort),
			replay: (sql, p) => replayShopCategory(sql, "sort", p),
		},
		"status-preview": get("现读身份和单件商品状态，冻结上下架目标并生成精确确认；不提交", statusInput, async (p) => previewStatus(await db(), p)),
		"set-status": {
			...write("仅修改人工确认商品的上下架状态；requestId绑定冻结事实，结果未知不重发；首次按方向 --try", statusInput, planStatus),
			replay: replayStatus,
		},
		"status-result": get("读取指定商品状态修改请求的已保存结果；不读外站、不提交", statusReference, async (p) => readStatusResult(await db(), p)),
		"reconcile-status": get("仅现读核对指定商品的未知上下架结果，核对成功更新当前 Catalog；不重新提交", statusReference, async (p) =>
			reconcileStatus(await db(), p),
		),
	},
	writes: { ...CATALOG_STATUS_WRITES, ...SHOP_CATEGORY_WRITES },
	tables: [
		{
			name: "catalog_current_products",
			title: "当前店铺目录",
			key: ["shop", "shop_id", "product_id"],
			images: ["cover"],
			columns: {
				shop: "店铺",
				product_id: "商品 id",
				name: "商品",
				parent_sku: "主SKU",
				cover: "封面",
				status_label: "状态",
				stock_state: "库存状态",
				price_min: "最低价 TWD",
				price_max: "最高价 TWD",
				stock_total: "库存",
				captured_at: "采集时间",
				revision: "批次",
			},
		},
		{
			name: "catalog_syncs",
			title: "Catalog 同步批次",
			key: ["id"],
			columns: {
				id: "批次",
				shop: "店铺",
				scope: "范围",
				status: "状态",
				started_at: "开始",
				captured_at: "采集时间",
				complete: "列表完整",
				details_complete: "规格完整",
				product_count: "商品数",
				error: "失败原因",
			},
		},
	],
};
