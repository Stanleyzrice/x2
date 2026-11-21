// 商品：在售列表、状态、详情、类目、属性、上架用的读取；写：建、改、上下架、删、传图。
// 查过的事实（lilto 旧工作台，真店上踩过）：
// - 「我的商品 / 架上商品」是 opt/mpsku/list/v2/get_product_list?list_type=live_all，一页最多 48；search_product_list_v2?source=attribute_tool 是补属性工具，不是它
// - 商品状态（list_type=all）：0 删除、1 在售、2 审核中、3 禁卖、8 下架；别的值不猜
// - 属性树走 listing-upload/component/get_attribute_tree（POST）：可选值在 children，value_list 恒空；值要一字不差取自 children 的名字，编的值发布被拒
// - 类目推荐是 get_recommended_category（标题 + 已传的图 id）；get_image_category 已坏
// - 规格最多两层（tier）；一个商品最多 100 个规格，规格之间价差不超过 5 倍
// - 1000100256 是通用的字段校验失败码（缺尺码表也回它），不等于重复
// - 直接在售的创建路径曾返回 10025；现有成功请求样本的 unlisted 为 true

import { z } from "zod";
import { page } from "../../../platform/browser/browser.ts";
import { NeedsHuman } from "../../../platform/errors.ts";
import { idText, reply } from "../../../platform/reply.ts";
import { IMAGE, ItemId, ModelId, ORIGIN, type Req, seller, type Write, withData, write } from "./seller.ts";

const image = (id: unknown) => (!id ? "" : /^https?:\/\//.test(String(id)) ? String(id) : `${IMAGE}${id}`);

export type Model = {
	modelId: ModelId;
	sku: string;
	name: string;
	price: number | null;
	stock: number | null;
	sold: number | null;
	tierIndex: number[];
	image?: string | null;
};
export type Product = { productId: ItemId; parentSku: string; name: string; cover: string; createdAt: string | null; models: Model[] };

const scalar = z.union([z.string(), z.number()]).nullish();
const pageInfo = z.looseObject({ total: scalar }).nullish();

/** 在售列表（get_product_list）的回包 */
export const liveList = withData(
	z
		.looseObject({
			page_info: pageInfo,
			products: z
				.array(
					z.looseObject({
						id: idText.pipe(ItemId),
						parent_sku: z.string().nullish(),
						name: z.string().nullish(),
						cover_image: z.string().nullish(),
						create_time: scalar,
						model_list: z
							.array(
								z.looseObject({
									id: idText.pipe(ModelId),
									sku: z.string().nullish(),
									name: z.string().nullish(),
									image: z.string().nullish(),
									price_detail: z.looseObject({ origin_price: scalar }).nullish(),
									stock_detail: z.looseObject({ total_seller_stock: scalar }).nullish(),
									statistics: z.looseObject({ sold_count: scalar }).nullish(),
									tier_index: z.array(z.union([z.number(), z.string()])).nullish(),
								}),
							)
							.nullish(),
					}),
				)
				.nullish(),
		})
		.nullish(),
);

/** 在售列表的回包 → 商品（纯函数） */
export function liveProductsOf(raw: unknown): { total: number; rows: Product[] } {
	const b = reply(liveList, raw, "Shopee get_product_list");
	const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
	return {
		total: Number(b.data?.page_info?.total ?? 0),
		rows: (b.data?.products ?? []).map((p) => ({
			productId: p.id,
			parentSku: String(p.parent_sku ?? ""),
			name: String(p.name ?? ""),
			cover: image(p.cover_image),
			createdAt: Number(p.create_time) > 0 ? new Date(Number(p.create_time) * 1000).toISOString() : null,
			models: (p.model_list ?? []).map((m) => ({
				modelId: m.id,
				sku: String(m.sku ?? ""),
				name: String(m.name ?? ""),
				price: n(m.price_detail?.origin_price),
				stock: n(m.stock_detail?.total_seller_stock),
				sold: n(m.statistics?.sold_count),
				// 改商品的 model_list 必须带 tier_index
				tierIndex: (m.tier_index ?? []).map(Number),
			})),
		})),
	};
}

export async function liveProducts(pageNo = 1, pageSize = 48): Promise<{ total: number; rows: Product[] }> {
	return liveProductsOf(
		await seller("/api/v3/opt/mpsku/list/v2/get_product_list", z.unknown(), {
			query: { page_size: Math.min(48, pageSize), page_number: pageNo, list_type: "live_all", need_ads: false },
		}),
	);
}

export const STATUS: Record<number, string> = { 0: "删除", 1: "在售", 2: "审核中", 3: "禁卖", 8: "下架" };

export type ProductSummary = {
	productId: string;
	name: string;
	status: number | null;
	cover: string;
	/** 平台创建时间，不代表最近一次重新上架时间；历史调用者可缺省。 */
	createdAt?: string | null;
	bulk?: { parentSku: string | null; models: (Model & { isDefault?: boolean })[] };
};
const allProductList = withData(
	z.looseObject({
		page_info: z.looseObject({ total: z.union([z.number(), z.string().regex(/^\d+$/)]) }),
		products: z.array(
			z.looseObject({
				id: z.union([z.string().min(1), z.number().int().positive().refine(Number.isSafeInteger)]).transform(String),
				name: z.string().nullish(),
				status: scalar,
				cover_image: z.string().nullish(),
				create_time: scalar,
			}),
		),
	}),
);

/** 列表明确回了规格才提供 bulk；缺列表、截断提示或数量不符时由调用方另读详情。 */
function bulkModels(p: z.output<typeof allProductList>["data"]["products"][number]): ProductSummary["bulk"] {
	if (!Array.isArray(p.model_list) || !p.model_list.length) return undefined;
	for (const [key, value] of Object.entries(p)) {
		if (/model.*(?:count|num|total)|total.*model/i.test(key)) {
			if (value == null || value === "" || !Number.isSafeInteger(Number(value)) || Number(value) !== p.model_list.length) return undefined;
		} else if (/has_more|truncat|partial|incomplete/i.test(key) && ![false, 0, "false", "0"].includes(value as string | number | boolean)) return undefined;
	}
	// bulk 只取规格；无效创建时间不能让已有的规格解析因 Date.toISOString 抛错。
	const candidate = { data: { page_info: { total: 1 }, products: [{ ...p, create_time: undefined }] } };
	const parsed = liveList.safeParse(candidate);
	if (!parsed.success) return undefined;
	const nativeModels = parsed.data.data?.products?.[0]?.model_list;
	const product = liveProductsOf(candidate).rows[0]!;
	const models = product.models.map((m, i) => {
		const isDefault = nativeModels?.[i]?.is_default;
		return {
			...m,
			image: productImageUrl(nativeModels?.[i]?.image),
			...(typeof isDefault === "boolean" ? { isDefault } : {}),
			price: m.price !== null && Number.isFinite(m.price) && m.price >= 0 ? m.price : null,
			stock: m.stock !== null && Number.isFinite(m.stock) && m.stock >= 0 ? m.stock : null,
		};
	});
	return { parentSku: product.parentSku || null, models };
}

/** 全状态列表的回包解析；缺总数或列表不能当作空店铺。 */
export function allProductsOf(raw: unknown): { total: number; rows: ProductSummary[] } {
	const b = reply(allProductList, raw, "Shopee get_product_list(all)");
	const total = Number(b.data.page_info.total);
	if (!Number.isSafeInteger(total) || total < 0) throw new Error("Shopee get_product_list(all) 的回包变了：total 不是非负整数");
	return {
		total,
		rows: b.data.products.map((p) => {
			const bulk = bulkModels(p);
			const createdAt = new Date(Number(p.create_time) * 1000);
			return {
				productId: p.id,
				name: p.name ?? "",
				status: p.status == null || (typeof p.status === "string" && p.status.trim() === "") || !Number.isInteger(Number(p.status)) ? null : Number(p.status),
				cover: image(p.cover_image),
				createdAt: createdAt.getTime() > 0 ? createdAt.toISOString() : null,
				...(bulk ? { bulk } : {}),
			};
		}),
	};
}

/** 全状态列表与在售列表共用 get_product_list；search_product_list 不按 page_number 翻页。 */
export function allProductsRequest(pageNo = 1, pageSize = 48): { path: string; request: Req } {
	return {
		path: "/api/v3/opt/mpsku/list/v2/get_product_list",
		request: { query: { page_size: Math.min(48, pageSize), page_number: pageNo, list_type: "all", need_ads: false } },
	};
}

export async function allProducts(pageNo = 1, pageSize = 48): Promise<{ total: number; rows: ProductSummary[] }> {
	const { path, request } = allProductsRequest(pageNo, pageSize);
	return allProductsOf(await seller(path, z.unknown(), request));
}

/** 商品的完整资料（product_info）：写只认识读回对账、上架、按货号找要用的格，别的原样留着 */
export const productAttribute = z.looseObject({
	attribute_id: z.coerce.number().int().positive(),
	attribute_values: z.array(z.looseObject({ value_id: z.coerce.number().int().nonnegative() })),
});

// 原生自填属性可只返回 raw_value；读取保留原值，不能替它编一个可提交的 value_id。
const readProductAttribute = z.looseObject({
	attribute_id: z.coerce.number().int().positive(),
	attribute_values: z.array(
		z
			.looseObject({ value_id: z.coerce.number().int().nonnegative().optional(), raw_value: z.string().optional() })
			.refine((value) => value.value_id !== undefined || value.raw_value !== undefined, "属性值缺少 value_id 或 raw_value"),
	),
});

const productInfoShape = z.looseObject({
	name: z.string().nullish(),
	parent_sku: z.string().nullish(),
	status: scalar,
	is_unlisted: z.boolean().nullish(),
	category_path: z.array(z.union([z.number(), z.string()])).nullish(),
	attributes: z.array(readProductAttribute).nullish(),
	weight: z.looseObject({ value: scalar }).nullish(),
	images: z.array(z.unknown()).nullish(),
	size_chart_info: z.looseObject({ size_chart: z.unknown().optional() }).nullish(),
	pre_order_info: z.record(z.string(), z.unknown()).nullish(),
	description_info: z.looseObject({ description: z.string().nullish(), description_type: z.string().nullish() }).nullish(),
	model_list: z
		.array(
			z.looseObject({
				id: idText.pipe(ModelId).optional(),
				name: z.string().nullish(),
				sku_image: z.string().nullish(),
				is_default: z.boolean().nullish(),
				sku: z.string().nullish(),
				tier_index: z.array(z.union([z.number(), z.string()])).nullish(),
				stock_detail: z.looseObject({ total_seller_stock: scalar, seller_stock_info: z.array(z.looseObject({ sellable_stock: scalar })).nullish() }).nullish(),
				price_info: z.looseObject({ input_normal_price: scalar, normal_price: scalar }).nullish(),
			}),
		)
		.nullish(),
	std_tier_variation_list: z
		.array(
			z.looseObject({
				custom_value: z.string().nullish(),
				value_list: z.array(z.looseObject({ custom_value: z.string().nullish(), image_id: z.string().nullish() })).nullish(),
			}),
		)
		.nullish(),
});
export type ProductInfo = z.output<typeof productInfoShape>;

/** Shopee 图片字段是图片 id 或 HTTP(S) URL；空值和无法识别的值保留未知。 */
export function productImageUrl(value: string | null | undefined): string | null {
	const text = value?.trim();
	if (!text) return null;
	if (/^https?:\/\//i.test(text)) {
		try {
			const url = new URL(text);
			return url.hostname ? url.href : null;
		} catch {
			return null;
		}
	}
	return /^[a-z\d_-]+$/i.test(text) ? `${IMAGE}${text}` : null;
}

/** 默认单规格也可能带一层空占位变体；只接受网站明确标记，且不能有实际选项。 */
export function isDefaultProductModel(info: ProductInfo): boolean {
	if (info.model_list?.length !== 1) return false;
	if (info.std_tier_variation_list?.length === 0) return true;
	return (
		info.model_list[0]!.is_default === true &&
		info.std_tier_variation_list?.length === 1 &&
		!info.std_tier_variation_list[0]!.custom_value?.trim() &&
		info.std_tier_variation_list[0]!.value_list?.length === 1 &&
		!info.std_tier_variation_list[0]!.value_list[0]!.custom_value?.trim() &&
		info.model_list[0]!.tier_index?.length === 1 &&
		Number(info.model_list[0]!.tier_index[0]) === 0
	);
}

/** 详情的 sku_image 为空时，仅按第零层 tier_index 取对应 image_id，不按规格名称或商品封面猜图。 */
export function productModelImage(info: ProductInfo, model: NonNullable<ProductInfo["model_list"]>[number]): string | null {
	const direct = productImageUrl(model.sku_image);
	if (direct) return direct;
	const rawIndex = model.tier_index?.[0];
	if (rawIndex === undefined || (typeof rawIndex === "string" && !rawIndex.trim())) return null;
	const index = Number(rawIndex);
	if (!Number.isSafeInteger(index) || index < 0) return null;
	return productImageUrl(info.std_tier_variation_list?.[0]?.value_list?.[index]?.image_id);
}

/** 商品资料（get_product_info）的回包 → product_info（纯函数） */
export const productInfoOf = (raw: unknown): ProductInfo =>
	reply(withData(z.looseObject({ product_info: productInfoShape })), raw, "Shopee /api/v3/product/get_product_info").data.product_info;

export async function productInfo(productId: string): Promise<ProductInfo> {
	return productInfoOf(await seller("/api/v3/product/get_product_info", z.unknown(), { query: { product_id: productId, is_draft: false } }));
}

/** 一个物流渠道：启用没有（enabled）、渠道 id（新旧两种写法 channel_id、channelid） */
export const channel = z.looseObject({ enabled: z.boolean().nullish(), channel_id: scalar, channelid: scalar });
export type Channel = z.output<typeof channel>;

/** 物流渠道（启用哪些、谁付运费）。新商品给 productId 0、叶子类目 id */
export async function channels(productId: string, categoryId: number): Promise<Channel[]> {
	const b = await seller("/api/v3/listing-upload/component/get_product_channel_info", withData(z.looseObject({ list: z.array(channel).nullish() }).nullish()), {
		body: { product_id: Number(productId), category_id: categoryId, is_draft: false },
	});
	return b.data?.list ?? [];
}

const limits = z.looseObject({ current_published: scalar, unlisted_count: scalar, publish_limit: scalar });

export async function countLimit(): Promise<{ used: number; unlisted: number; limit: number }> {
	const b = await seller("/api/v3/opt/mpsku/list/get_product_count_limit", limits.extend({ data: limits.nullish() }));
	const d = b.data ?? b;
	return { used: Number(d.current_published), unlisted: Number(d.unlisted_count), limit: Number(d.publish_limit) };
}

const performanceItem = z.looseObject({
	id: idText.pipe(ItemId),
	name: z.string(),
	status: scalar,
	confirmed_units: z.number().nonnegative().nullish(),
	paid_units: z.number().nonnegative().nullish(),
});
export type Performance = z.output<typeof performanceItem>;
const performanceReply = z.looseObject({ result: z.looseObject({ total: z.union([z.string(), z.number()]), items: z.array(performanceItem) }) });

/** 商品表现：用到的件数先解析；缺失保留，不能把没返回的件数当零 */
export function performanceOf(raw: unknown): { total: number; rows: Performance[] } {
	const b = reply(performanceReply, raw, "Shopee /api/mydata/v4/product/performance/");
	const total = Number(b.result.total);
	if (!Number.isSafeInteger(total) || total < 0) throw new Error("Shopee 商品表现的回包变了：total 不是非负整数");
	return { total, rows: b.result.items };
}

export async function performance(
	start: number,
	end: number,
	period: "past7days" | "past30days" | "day",
	pageNo = 1,
	pageSize = 50,
): Promise<{ total: number; rows: Performance[] }> {
	const b = await seller("/api/mydata/v4/product/performance/", z.unknown(), {
		query: {
			start_time: start,
			end_time: end,
			period,
			keyword: "",
			category_type: "shopee",
			category_id: -1,
			page_size: Math.min(50, pageSize),
			page_num: pageNo,
			order_type: "confirmed",
			order_by: "confirmed_sales.desc",
		},
	});
	return performanceOf(b);
}

export type Category = { id: string; name: string; children: Category[] };

type CategoryNode = { id: string | number; display_name?: string | null; name?: string | null; children?: CategoryNode[] | null };
const categoryNode: z.ZodType<CategoryNode> = z.looseObject({
	id: z.union([z.string(), z.number()]),
	display_name: z.string().nullish(),
	name: z.string().nullish(),
	get children() {
		return z.array(categoryNode).nullish();
	},
});

export async function categoryTree(): Promise<Category[]> {
	const b = await seller("/api/v3/category/get_category_tree", withData(z.looseObject({ list: z.array(categoryNode).nullish() }).nullish()));
	const conv = (n: CategoryNode): Category => ({ id: String(n.id), name: String(n.display_name ?? n.name ?? n.id), children: (n.children ?? []).map(conv) });
	const list = b.data?.list ?? [];
	if (!list.length) throw new Error("Shopee 类目树是空的（没登录，或被风控）");
	return list.map(conv);
}

export type Attribute = { id: string; name: string; mandatory: boolean; maxValues: number; values: { valueId: string; name: string }[] };

const attribute = z.looseObject({
	attribute_id: idText,
	display_name: z.string().nullish(),
	name: z.string().nullish(),
	mandatory: z.unknown().optional(),
	attribute_info: z.looseObject({ max_value_count: scalar }).nullish(),
	children: z.array(z.looseObject({ value_id: idText, display_name: z.string().nullish(), name: z.string().nullish() })).nullish(),
});
const attributeTree = withData(z.looseObject({ list: z.array(z.looseObject({ attribute_tree: z.array(attribute).nullish() })).nullish() }).nullish());

/** 属性树（get_attribute_tree）的回包 → 属性（纯函数） */
export function attributesOf(raw: unknown): Attribute[] {
	const b = reply(attributeTree, raw, "Shopee /api/v3/listing-upload/component/get_attribute_tree");
	return (b.data?.list?.[0]?.attribute_tree ?? []).map((a) => ({
		id: a.attribute_id,
		name: String(a.display_name ?? a.name ?? ""),
		mandatory: Boolean(a.mandatory),
		maxValues: Number(a.attribute_info?.max_value_count ?? 1),
		values: (a.children ?? []).map((c) => ({ valueId: c.value_id, name: String(c.display_name ?? c.name ?? "") })),
	}));
}

/** 叶子类目的属性：必填的决定能不能上架；可选值只能从 values 里挑 */
export async function attributes(categoryId: number): Promise<Attribute[]> {
	return attributesOf(await seller("/api/v3/listing-upload/component/get_attribute_tree", z.unknown(), { body: { category_id: categoryId } }));
}

/** 推荐的类目：第一个最像；类目路径是几级的 id，名字在 category_path_name（旧的叫 display_path、category_name_list） */
export const recommended = z
	.looseObject({
		category_recommend_list: z
			.array(
				z.looseObject({
					category_path: z.array(z.union([z.number(), z.string()])).nullish(),
					category_path_name: z.array(z.unknown()).nullish(),
					display_path: z.array(z.unknown()).nullish(),
					category_name_list: z.array(z.unknown()).nullish(),
				}),
			)
			.nullish(),
	})
	.nullish();
export type Recommended = z.output<typeof recommended>;

export async function recommendedCategory(name: string, imageId = ""): Promise<Recommended> {
	return (
		await seller("/api/v3/category/get_recommended_category", withData(recommended), {
			body: { item_id: 0, name, image: imageId, description: "", description_type: "normal" },
		})
	).data;
}

export async function shippingDays(): Promise<{ inStock: number; rules: { categoryIds: string[]; min: number; max: number }[] }> {
	const b = await seller(
		"/api/v3/product/get_product_constraints/",
		withData(
			z
				.looseObject({
					in_stock_dts: scalar,
					category_dts_setting: z
						.array(z.looseObject({ category_id_list: z.array(z.union([z.number(), z.string()])).nullish(), dts_min: scalar, dts_max: scalar }))
						.nullish(),
				})
				.nullish(),
		),
	);
	return {
		inStock: Number(b.data?.in_stock_dts),
		rules: (b.data?.category_dts_setting ?? []).map((r) => ({
			categoryIds: (r.category_id_list ?? []).map(String),
			min: Number(r.dts_min),
			max: Number(r.dts_max),
		})),
	};
}

/** 写：建商品（create_product_info）。product_info 的样子照卖家中心新增商品页提交的（lilto 2026-09-01 的成功样本）；isDraft 为 true 存成草稿 */
export function createProduct(productInfo: Record<string, unknown>, isDraft = false): Promise<Write> {
	return write("/api/v3/product/create_product_info", { query: { _show_debug_info: 1 }, body: { is_draft: isDraft, product_info: productInfo } });
}

/** 写：改商品的几个字段（name、images、description_info、std_tier_variation_list、model_list、attributes、logistics_channels、pre_order_info、weight、dimension、unlisted、parent_sku）。
 * 改完规格要等几秒才读得到 */
export function updateProduct(productId: string, productInfo: Record<string, unknown>): Promise<Write> {
	return write("/api/v3/product/update_product_info", { body: { product_id: Number(productId), product_info: productInfo, is_draft: false } });
}

export const setUnlisted = (productId: string, unlisted: boolean) => updateProduct(productId, { unlisted });

/** 列表的批量下架走另一个入口；仍然一次只交一个商品，让平台逐件记意图、回读。缺尺码表等校验被拒就原样回，不补商品内容。 */
export const unlistRequest = (productId: ItemId, shopId: string): Req => ({
	query: { version: "3.1.0", source: "seller_center" },
	headers: { "Entrance-Identification": "2" },
	listing: { shopId },
	body: [{ id: Number(productId), unlisted: true }],
});
const unlistReply = z.looseObject({ result: z.array(z.looseObject({ id: idText.pipe(ItemId), code: z.number(), message: z.string().nullish() })) });
export function unlistResult(data: unknown, productId: ItemId): Write {
	const parsed = unlistReply.safeParse(data);
	if (!parsed.success) return { kind: "unknown", why: "Shopee update_product 下架回包变了：没有逐件结果" };
	const rows = parsed.data.result;
	if (rows.length !== 1 || rows[0]?.id !== productId) return { kind: "unknown", why: "Shopee update_product 下架回包商品编号对不上" };
	const row = rows[0];
	return row.code === 0 ? { kind: "done", data } : { kind: "refused", code: row.code, why: row.message ?? "商品下架被拒" };
}
export async function unlistFromList(productId: ItemId, shopId: string): Promise<Write> {
	const w = await write("/api/v3/product/update_product/", unlistRequest(productId, shopId));
	return w.kind === "done" ? unlistResult(w.data, productId) : w;
}

/** 写：删商品。真删，平台没有回收站 */
export function deleteProducts(productIds: string[]): Promise<Write> {
	return write("/api/v3/product/delete_product_info", { body: { product_id_list: productIds.map(Number) } });
}

/** 到新增商品页（传图的 UploadService 只在这页加载）。店铺被限制时这页跳到「權限不足 / 賣場遷移中」：要人处理，不再往下做 */
export async function productPage() {
	const p = await page(ORIGIN);
	if (!/\/portal\/product\/(new|\d+)/.test(await p.run(() => location.pathname))) await p.goto(`${ORIGIN}/portal/product/new`);
	const blocked = await p.run(() => /no-permission/.test(location.href) || /您的權限不足|卖场迁移中|賣場遷移中/.test(String(document.body?.innerText ?? "")));
	if (blocked) throw new NeedsHuman("Shopee 这家店现在不能新增商品（權限不足 / 賣場遷移中）：到卖家中心看一眼");
	return p;
}

/** 写：传一批商品图，回每张的图片 id（顺序同 files）。图片服务的签名只有页面里的 UploadService 算得出：到 webpack 模块里找它，找到记在页面上，一张一张传（隔 0.5 秒）。
 * biz 4207 是商品图。任何一张失败就抛错（传图不收钱、不上架，重来就是）。bytes 经 base64 传进页面 */
// 页面里的 webpack 运行时和 Shopee 的 UploadService：只写传图用到的几样
type WebpackRequire = ((id: string | number) => Record<string, unknown> | null) & {
	u?: (i: number) => unknown;
	e: (i: number) => Promise<unknown>;
	m?: Record<string, unknown>;
};
type WebpackChunks = { push: (chunk: [string[], Record<string, never>, (req: WebpackRequire) => void]) => void };
type Uploader = { uploadImage: (file: File, opts: Record<string, unknown>) => Promise<{ data?: { resourceId?: unknown }; error?: unknown } | null> };
type UploadPreparationError = { name: string; message: string };
type UploadRuntimePreparation = {
	name: string;
	uploadChunks: number[];
	nativeInitializers: string[];
	chunks: { id: number; ok: boolean; error?: UploadPreparationError }[];
	modules: {
		id: string;
		ok: boolean;
		error?: UploadPreparationError;
		moduleType: string;
		keys: string[];
		defaultType: string;
		candidates: { type: string; ownMethods: string[]; prototypeMethods: string[] }[];
	}[];
};
type UploadPreparationStatus = "waiting" | "ready" | "failed";
type UploadInitializerFailure = {
	at: string;
	stage: "initializer" | "uploader";
	runtime: string;
	id: string;
	result: "threw" | "empty-exports" | "no-uploader";
	error?: UploadPreparationError;
};
type UploadPreparation = {
	ready: boolean;
	cached: boolean;
	status: UploadPreparationStatus;
	waitingFor?: string;
	firstFailure?: UploadInitializerFailure;
	runtimes: UploadRuntimePreparation[];
};
type UploadWindow = Record<string, unknown> & { __x2Upload?: Uploader | null; __x2UploadPreparation?: UploadPreparation };

/** 仅查看自有页DOM与已注册模块源码；不加载块、不require模块、不改表单或服务缓存。 */
export async function uploadDiagnostics() {
	const p = await page(ORIGIN);
	return p.run(async () => {
		const safe = (value: string, max = 600) =>
			value
				.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
					try {
						const u = new URL(raw);
						return `${u.origin}${u.pathname}`;
					} catch {
						return "[url]";
					}
				})
				.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]")
				.replace(/\b[A-Za-z0-9_=-]{32,}\b/g, "[token]")
				.replace(/\b\d{7,}\b/g, "[number]")
				.slice(0, max);
		const owned = window.name === "x2";
		const route = { owned, pathname: location.pathname, readyState: document.readyState, hasQuery: Boolean(location.search) };
		if (!owned || location.origin !== "https://seller.shopee.tw" || location.pathname !== "/portal/product/new")
			return { ...route, reason: "仅诊断X2自有新增商品页，未读取其他页面内容" };
		const nodeSummary = (e: Element) => ({ tag: e.tagName, id: safe(e.id, 80), className: safe(e.getAttribute("class") ?? "", 240) });
		const ancestors = (e: Element) => {
			const chain: ReturnType<typeof nodeSummary>[] = [];
			for (let parent = e.parentElement; parent && chain.length < 6; parent = parent.parentElement) chain.push(nodeSummary(parent));
			return chain;
		};
		const inputs = [...document.querySelectorAll("input, textarea")].map((e) => {
			const field = e as HTMLInputElement | HTMLTextAreaElement;
			return {
				tag: field.tagName,
				type: field.type,
				name: safe(field.name, 80),
				id: safe(field.id, 80),
				placeholder: safe(field.placeholder, 160),
				length: field.value.length,
				trimmedLength: field.value.trim().length,
				defaultLength: field.defaultValue.length,
				changed: field.value !== field.defaultValue,
				readOnly: field.readOnly,
				disabled: field.disabled,
				visible: field.getClientRects().length > 0,
				exampleText: safe(field.closest(".example-search-card")?.textContent ?? "", 300),
				files: "files" in field ? (field.files?.length ?? 0) : 0,
				ancestors: ancestors(field),
				editLabel: safe(field.closest(".edit-row")?.querySelector(".edit-label")?.textContent ?? "", 160),
			};
		});
		const editors = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')].map((e) => ({
			tag: e.tagName,
			id: safe(e.id, 80),
			className: safe(e.className, 160),
			textLength: e.innerText.length,
			trimmedLength: e.innerText.trim().length,
			ancestors: ancestors(e),
		}));
		const uploadImages = [
			...document.querySelectorAll<HTMLImageElement>(
				'[class*="upload"] img[src], [class*="Upload"] img[src], [class*="image-manager"] img[src], [class*="imageManager"] img[src]',
			),
		].map((e) => ({
			alt: safe(e.alt, 100),
			src: safe(e.src, 200),
			className: safe(e.className, 160),
			ancestors: ancestors(e),
		}));
		const productRoots = [
			...document.querySelectorAll('main, form, [class*="product-edit"], [class*="product-form"], [class*="product-new"], [class*="basic-info"]'),
		]
			.slice(0, 25)
			.map((e) => ({
				...nodeSummary(e),
				inputCount: e.querySelectorAll("input, textarea").length,
				editRowCount: e.querySelectorAll(".edit-row").length,
				labels: [...e.querySelectorAll(".edit-label")].slice(0, 15).map((label) => safe(label.textContent ?? "", 100)),
			}));
		const w = window as unknown as UploadWindow;
		const names = Object.keys(w).filter((k) => /^(?:webpack|rspack)Chunk/.test(k));
		const reqs: { name: string; req: WebpackRequire }[] = [];
		await Promise.all(
			names.map(
				(name) =>
					new Promise<void>((resolve) => {
						try {
							(w[name] as WebpackChunks).push([
								[`__x2_diag_${Date.now()}_${name}`],
								{},
								(req) => {
									reqs.push({ name, req });
									resolve();
								},
							]);
						} catch {
							resolve();
						}
						setTimeout(resolve, 3000);
					}),
			),
		);
		const runtimes = reqs.map(({ name, req }) => {
			const chunks: { id: number; path: string }[] = [];
			for (let id = 0; id < 2000; id++) {
				try {
					const mapped = String(req.u?.(id) ?? "");
					if (/upload\./.test(mapped)) chunks.push({ id, path: safe(mapped, 160) });
				} catch {}
			}
			const nativeLoaders: { moduleId: string; chunkIds: number[]; initializerId: string; source: string; initializerSource: string }[] = [];
			const serviceModules: { moduleId: string; source: string }[] = [];
			for (const [moduleId, factory] of Object.entries(req.m ?? {})) {
				const source = String(factory);
				for (const group of source.matchAll(/Promise\.all\(\[([^\]]+)\]\)\.then\(\s*[\w$]+\.bind\(\s*[\w$]+\s*,\s*(\d+)\s*\)\s*\)/g)) {
					const chunkIds = [...group[1]!.matchAll(/\.e\(\s*(\d+)\s*\)/g)].map((m) => Number(m[1]));
					if (chunkIds.some((id) => chunks.some((chunk) => chunk.id === id)))
						nativeLoaders.push({
							moduleId,
							chunkIds,
							initializerId: group[2]!,
							source: safe(group[0]),
							initializerSource: safe(String(req.m?.[group[2]!] ?? "")),
						});
				}
				if (/UploadService|uploadImage|uploadapi\/api\/v1\/image/.test(source) && serviceModules.length < 8)
					serviceModules.push({ moduleId, source: safe(source) });
			}
			return {
				name,
				requireSource: safe(String(req), 5000),
				requireProperties: Object.keys(req),
				moduleCount: Object.keys(req.m ?? {}).length,
				chunks,
				nativeLoaders,
				serviceModules,
			};
		});
		return {
			...route,
			title: safe(document.title, 200),
			body: safe(document.body?.innerText ?? "", 2500),
			inputs,
			editors,
			uploadImages,
			productRoots,
			runtimeNames: names,
			runtimes,
			preparation: w.__x2UploadPreparation ?? null,
		};
	});
}

/** 准备页面已有的上传服务，不传图片；动态块须按原生 loader 一并加载依赖，不能只加载 upload 块。 */
export async function prepareUploadService(context?: UploadWindow): Promise<boolean> {
	const w = context ?? (window as unknown as UploadWindow);
	const trace: UploadPreparation = w.__x2UploadPreparation ?? { ready: false, cached: false, status: "waiting", runtimes: [] };
	if (context || w.name === "x2") w.__x2UploadPreparation = trace;
	// 工厂抛错后原生require仍保留空exports；同一文档禁止再次初始化，也不覆盖最初错误。
	if (trace.firstFailure) {
		trace.status = "failed";
		return false;
	}
	trace.ready = trace.cached = false;
	trace.status = "waiting";
	trace.runtimes = [];
	const doc = w.document as { readyState?: string; querySelector?: (selector: string) => { getClientRects: () => { length: number } } | null } | undefined;
	const loc = w.location as { origin?: string; pathname?: string } | undefined;
	// chunk下载完成不等于商品应用已挂载；只观察真实可见表单，不require应用模块来探测。
	if (
		w.name !== "x2" ||
		loc?.origin !== "https://seller.shopee.tw" ||
		!/^\/portal\/product\/(?:new|\d+)\/?$/.test(loc.pathname ?? "") ||
		doc?.readyState !== "complete" ||
		!doc.querySelector?.(".product-edit__main .product-name-editor input")?.getClientRects().length
	) {
		trace.waitingFor = "商品页面与可见标题表单尚未挂载";
		return false;
	}
	if (typeof w.__x2Upload?.uploadImage === "function") {
		trace.ready = trace.cached = true;
		trace.status = "ready";
		delete trace.waitingFor;
		return true;
	}
	trace.waitingFor = "商品原生上传loader尚未完整注册";
	const errorOf = (error: unknown): UploadPreparationError => ({
		name: error instanceof Error ? error.name : typeof error,
		message: (error instanceof Error ? error.message : String(error))
			.replace(/https?:\/\/[^\s"'<>]+/g, (raw) => {
				try {
					const url = new URL(raw);
					return `${url.origin}${url.pathname}`;
				} catch {
					return "[url]";
				}
			})
			.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]")
			.replace(/\b[A-Za-z0-9_=-]{32,}\b/g, "[token]")
			.slice(0, 240),
	});
	const methodsOf = (value: unknown): string[] => {
		try {
			if (!value || (typeof value !== "object" && typeof value !== "function")) return [];
			return Object.entries(Object.getOwnPropertyDescriptors(value))
				.filter(([, descriptor]) => typeof descriptor.value === "function")
				.map(([name]) => name)
				.slice(0, 64);
		} catch {
			return [];
		}
	};
	const reqs: { name: string; req: WebpackRequire }[] = await new Promise((resolve) => {
		const found: { name: string; req: WebpackRequire }[] = [];
		// 商品模块已使用 Rspack，仍暴露兼容的 JSONP runtime；顶层旧 Webpack runtime 不含上传服务。
		const names = Object.keys(w).filter((k) => /^(?:webpack|rspack)Chunk/.test(k));
		let pending = names.length;
		if (!pending) return resolve(found);
		for (const n of names) {
			try {
				(w[n] as WebpackChunks).push([
					[`__x2_up_${n}_${Date.now()}`],
					{},
					(req: WebpackRequire) => {
						found.push({ name: n, req });
						if (--pending <= 0) resolve(found);
					},
				]);
			} catch {
				if (--pending <= 0) resolve(found);
			}
		}
		setTimeout(() => resolve(found), 3000);
	});
	for (const { name, req } of reqs) {
		const runtime: UploadRuntimePreparation = { name, uploadChunks: [], nativeInitializers: [], chunks: [], modules: [] };
		trace.runtimes.push(runtime);
		const uploadChunks = new Set<number>();
		const chunks = new Set<number>();
		const nativeInitializers = new Set<string>();
		// 页面现有 loader 如 Promise.all([r.e(63),r.e(36)])：63 提供 UploadService，36 只创建实例。
		// 必须先完整加载依赖，再 require 模块，避免缺依赖时留下半初始化的 webpack 缓存。
		for (const source of Object.values(req.m ?? {}).map(String)) {
			for (const group of source.matchAll(/Promise\.all\(\[([^\]]+)\]\)\.then\(\s*[\w$]+\.bind\(\s*[\w$]+\s*,\s*(\d+)\s*\)\s*\)/g)) {
				const ids = [...group[1]!.matchAll(/\.e\(\s*(\d+)\s*\)/g)].map((m) => Number(m[1]));
				const uploads = ids.filter((id) => {
					try {
						return /upload\./.test(String(req.u?.(id) ?? ""));
					} catch {
						return false;
					}
				});
				if (uploads.length) {
					for (const id of uploads) uploadChunks.add(id);
					for (const id of ids) chunks.add(id);
					nativeInitializers.add(group[2]!);
				}
			}
		}
		runtime.uploadChunks = [...uploadChunks];
		runtime.nativeInitializers = [...nativeInitializers];
		// 现代商品runtime必须有完整native loader；旧版仅接受明确含$instance的UploadService模块。
		const legacy = nativeInitializers.size
			? []
			: Object.entries(req.m ?? {}).filter(([, factory]) => /UploadService/.test(String(factory)) && /\$instance/.test(String(factory)));
		if (!nativeInitializers.size && (!legacy.length || /^rspackChunkProduct/.test(name))) continue;
		try {
			await Promise.all(
				[...chunks].map(async (id) => {
					try {
						await req.e(id);
						runtime.chunks.push({ id, ok: true });
					} catch (error) {
						runtime.chunks.push({ id, ok: false, error: errorOf(error) });
						throw error;
					}
				}),
			);
		} catch {
			trace.waitingFor = "原生上传loader依赖尚未加载成功";
			continue;
		}
		// 优先只 require 原生 loader 的服务初始化模块；匹配到 uploadImage 的UI模块并非服务，随意初始化可能污染webpack缓存。
		const modules = nativeInitializers.size ? [...nativeInitializers].map((id) => [id, req.m?.[id]] as const) : legacy;
		for (const [id, factory] of modules) {
			if (!factory) continue;
			// UI对话框也可能复用upload块；只有明确导出原生UploadService实例的工厂才可初始化。
			if (nativeInitializers.has(id) && !/[\w$]+\.default\s*=\s*new\s+(?:[\w$]+\.)?UploadService\s*\(/.test(String(factory))) continue;
			const module: UploadRuntimePreparation["modules"][number] = { id, ok: false, moduleType: "unread", keys: [], defaultType: "unread", candidates: [] };
			runtime.modules.push(module);
			let mod: Record<string, unknown> | null;
			try {
				// 与页面原生 req.bind(req, 数字ID) 保持相同的 this 和参数类型。
				mod = nativeInitializers.has(id) ? req.call(req, Number(id)) : req(id);
				module.ok = true;
				module.moduleType = mod === null ? "null" : typeof mod;
			} catch (error) {
				module.error = errorOf(error);
				trace.firstFailure = { at: new Date().toISOString(), stage: "initializer", runtime: name, id, result: "threw", error: module.error };
				trace.status = "failed";
				delete trace.waitingFor;
				return false;
			}
			try {
				module.keys = mod ? Object.keys(mod).slice(0, 64) : [];
				module.defaultType = typeof mod?.default;
				for (const value of mod ? [mod.UploadService, mod.default, mod, ...Object.values(mod)] : []) {
					let prototype: unknown = null;
					try {
						prototype = typeof value === "function" ? Object.getOwnPropertyDescriptor(value, "prototype")?.value : value ? Object.getPrototypeOf(value) : null;
					} catch {}
					module.candidates.push({ type: value === null ? "null" : typeof value, ownMethods: methodsOf(value), prototypeMethods: methodsOf(prototype) });
					const candidate = value as Uploader | { $instance?: Uploader } | null;
					const uploader =
						candidate && typeof (candidate as Uploader).uploadImage === "function"
							? (candidate as Uploader)
							: typeof (candidate as { $instance?: Uploader } | null)?.$instance?.uploadImage === "function"
								? (candidate as { $instance: Uploader }).$instance
								: null;
					if (uploader) {
						w.__x2Upload = uploader;
						trace.ready = true;
						trace.status = "ready";
						delete trace.waitingFor;
						return true;
					}
				}
			} catch (error) {
				module.error = errorOf(error);
				trace.firstFailure = { at: new Date().toISOString(), stage: "uploader", runtime: name, id, result: "threw", error: module.error };
				trace.status = "failed";
				delete trace.waitingFor;
				return false;
			}
			trace.firstFailure = {
				at: new Date().toISOString(),
				stage: "uploader",
				runtime: name,
				id,
				result: module.keys.length ? "no-uploader" : "empty-exports",
			};
			trace.status = "failed";
			delete trace.waitingFor;
			return false;
		}
	}
	return false;
}

/** 正式诊断入口：只准备一次；显式请求且空页守卫通过时才先正常重载，保留首次异常。 */
export async function uploadPrepare(reloadIfEmpty = false, attempts = 1) {
	const p = await page(ORIGIN);
	const allowed = await p.run(() => window.name === "x2" && location.origin === "https://seller.shopee.tw" && location.pathname === "/portal/product/new");
	if (!allowed) return { ready: false, reason: "仅准备X2自有新增商品页，未操作其他页面" };
	if (reloadIfEmpty) {
		const state = await p.run(uploadReloadState);
		const block = uploadPageReloadBlock(state);
		if (block) return { ready: false, reason: block, state };
		await p.goto(`${ORIGIN}/portal/product/new`);
	}
	const history: (UploadPreparation | null)[] = [];
	for (let attempt = 0; attempt < attempts; attempt++) {
		const ready = await p.run(prepareUploadService);
		const preparation = await p.run(() => (window as unknown as UploadWindow).__x2UploadPreparation ?? null);
		history.push(preparation);
		// 一旦真正调用原生初始化模块即返回，不能让后续空缓存覆盖首个异常。
		if (ready || preparation?.runtimes.some((r) => r.modules.length) || attempt === attempts - 1)
			return { ready, reloaded: reloadIfEmpty, preparation, history };
		await new Promise((resolve) => setTimeout(resolve, 2000));
	}
	return { ready: false, reloaded: reloadIfEmpty, preparation: null, history };
}

type UploadReloadState = {
	owned: boolean;
	origin: string;
	pathname: string;
	plainRoute: boolean;
	ready: boolean;
	titleFields: number;
	descriptionFields: number;
	categoryPending?: boolean;
	nonEmptyFields: number;
	selectedFiles: number;
	selectedImages: number;
	changedControls: number;
};

/** 只读表单摘要，不将商品内容、账号或页面查询参数带出浏览器。未识别表单也不能当空页。 */
function uploadReloadState(): UploadReloadState {
	const allInputs = [...document.querySelectorAll("input")];
	// 真页取证确认：隐藏的以图搜货教学卡片预填示例词，不是用户商品或聊聊输入。
	const inputs = allInputs.filter((e) => !(e.type === "text" && e.closest(".example-right-section .example-search-card") && e.getClientRects().length === 0));
	const textareas = [...document.querySelectorAll("textarea")];
	const editors = [...document.querySelectorAll<HTMLElement>('[contenteditable="true"]')];
	const main = document.querySelector<HTMLElement>(".product-edit__main");
	const titleFields = main?.querySelectorAll(".product-name-editor input");
	const descriptionFields = textareas.filter((e) => main?.contains(e) && /商品描述|商品[敘叙]述|description/i.test(`${e.placeholder} ${e.name} ${e.id}`));
	const categoryPending = Boolean(
		main &&
			[...main.querySelectorAll<HTMLElement>(".edit-row")].some(
				(e) => e.querySelector(".edit-label")?.textContent?.replace(/\*/g, "").trim() === "類別" && e.innerText.includes("請選擇商品分類"),
			) &&
			/商品描述\s+點選確認分類後商品資訊將被更新/.test(main.innerText),
	);
	const textInputs = inputs.filter((e) => !/^(hidden|file|checkbox|radio|button|submit|reset|color|range)$/.test(e.type));
	const nonEmptyFields = [...textInputs, ...textareas].filter((e) => e.value.trim()).length + editors.filter((e) => e.innerText.trim()).length;
	return {
		owned: window.name === "x2",
		origin: location.origin,
		pathname: location.pathname,
		plainRoute: !location.search && !location.hash,
		ready: document.readyState === "complete",
		titleFields: titleFields?.length ?? 0,
		descriptionFields: descriptionFields.length + editors.filter((e) => main?.contains(e)).length,
		categoryPending,
		nonEmptyFields,
		selectedFiles: allInputs.reduce((n, e) => n + (e.files?.length ?? 0), 0),
		selectedImages: [
			...document.querySelectorAll(
				'[class*="upload"] img[src], [class*="Upload"] img[src], [class*="image-manager"] img[src], [class*="imageManager"] img[src], [class*="upload"] [style*="background-image"], video[src]',
			),
		].filter(
			(e) =>
				!(
					e instanceof HTMLImageElement &&
					e.alt === "loading" &&
					/^data:image\/gif[;,]/.test(e.src) &&
					e.closest(".image-cropper-content") &&
					e.getClientRects().length === 0
				),
		).length,
		changedControls:
			inputs.filter((e) => (/^(checkbox|radio)$/.test(e.type) ? e.checked !== e.defaultChecked : e.type !== "file" && e.value !== e.defaultValue)).length +
			[...document.querySelectorAll("option")].filter((e) => e.selected !== e.defaultSelected).length,
	};
}

export function uploadPageReloadBlock(state: UploadReloadState): string | null {
	if (!state.owned || state.origin !== ORIGIN || state.pathname !== "/portal/product/new" || !state.plainRoute) return "不是X2自有空白新增商品路由";
	if (!state.ready || !state.titleFields || (!state.descriptionFields && !state.categoryPending)) return "商品表单尚未完整识别";
	if (state.nonEmptyFields || state.selectedFiles || state.selectedImages || state.changedControls) return "页面存在商品内容或已修改表单";
	return null;
}

/** 原生准备失败才尝试一次受守卫保护的正常重载；不删除模块缓存、不重造上传实例。 */
export async function prepareUploadWithRecovery(ops: {
	prepare: () => Promise<UploadPreparationStatus>;
	reload: () => Promise<boolean>;
	pause: () => Promise<void>;
}): Promise<boolean> {
	for (let round = 0; round < 2; round++) {
		for (let attempt = 0; attempt < 20; attempt++) {
			const status = await ops.prepare();
			if (status === "ready") return true;
			if (status === "failed") break;
			// 仅未挂载可等待；等待超时不靠刷新推动页面，终止性失败也不重复require坏模块。
			if (attempt === 19) return false;
			await ops.pause();
		}
		if (round || !(await ops.reload())) return false;
	}
	return false;
}

export async function uploadImages(files: { base64: string; mime: string }[], biz = 4207): Promise<string[]> {
	const p = await productPage();
	let recovery = "";
	let firstFailure: UploadInitializerFailure | undefined;
	let waitingFor = "";
	const ready = await prepareUploadWithRecovery({
		prepare: async () => {
			if (await p.run(prepareUploadService)) return "ready";
			const state = await p.run(() => {
				const trace = (window as unknown as UploadWindow).__x2UploadPreparation;
				return { status: trace?.status ?? "waiting", firstFailure: trace?.firstFailure, waitingFor: trace?.waitingFor };
			});
			firstFailure ??= state.firstFailure;
			waitingFor = state.waitingFor ?? "";
			return state.status;
		},
		pause: () => new Promise((r) => setTimeout(r, 1000)),
		reload: async () => {
			const state = await p.run(uploadReloadState);
			const block = uploadPageReloadBlock(state);
			recovery = `${block ?? "已安全重载一次"}（路径=${state.pathname}；标题栏=${state.titleFields}；描述栏=${state.descriptionFields}；非空字段=${state.nonEmptyFields}；图片=${state.selectedImages}；文件=${state.selectedFiles}；改动控件=${state.changedControls}）`;
			if (block) return false;
			await p.goto(`${state.origin}${state.pathname}`);
			return true;
		},
	});
	if (!ready)
		throw new Error(`页面的 UploadService 未就绪，不发送图片。${firstFailure ? `首次初始化失败=${JSON.stringify(firstFailure)}` : waitingFor}。${recovery}`);
	const ids: string[] = [];
	for (const [i, f] of files.entries()) {
		if (i > 0) await new Promise((r) => setTimeout(r, 500));
		const ext = f.mime === "image/png" ? "png" : f.mime === "image/webp" ? "webp" : "jpg";
		const r = await p.run(
			async (b64: string, filename: string, mime: string, biz: number) => {
				const uploader = (window as unknown as UploadWindow).__x2Upload;
				if (!uploader) return { error: "页面的 UploadService 已失效，请重新读取新增商品页" };
				const bin = atob(b64);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				const res = await uploader.uploadImage(new File([bytes], filename, { type: mime }), { biz, func: ["compress"], useMms: true });
				const id = res?.data?.resourceId;
				return id ? { imageId: String(id) } : { error: `传图没有回图片 id：${JSON.stringify(res?.error ?? res).slice(0, 200)}` };
			},
			f.base64,
			`x2.${ext}`,
			f.mime,
			biz,
		);
		if ("error" in r) throw new Error(r.error);
		ids.push(r.imageId);
	}
	return ids;
}

export async function uploadImage(base64: string, filename = "x2.jpg", mime = "image/jpeg", biz = 4207): Promise<string> {
	void filename;
	return (await uploadImages([{ base64, mime }], biz))[0]!;
}
