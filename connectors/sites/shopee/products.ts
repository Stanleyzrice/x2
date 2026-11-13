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
	period: "past7days" | "past30days",
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
type WebpackRequire = ((id: string) => Record<string, unknown> | null) & {
	u?: (i: number) => unknown;
	e: (i: number) => Promise<unknown>;
	m?: Record<string, unknown>;
};
type WebpackChunks = { push: (chunk: [string[], Record<string, never>, (req: WebpackRequire) => void]) => void };
type Uploader = { uploadImage: (file: File, opts: Record<string, unknown>) => Promise<{ data?: { resourceId?: unknown }; error?: unknown } | null> };
type UploadWindow = Record<string, unknown> & { __x2Upload?: Uploader | null };

/** 准备页面已有的上传服务，不传图片；动态块须按原生 loader 一并加载依赖，不能只加载 upload 块。 */
export async function prepareUploadService(context?: UploadWindow): Promise<boolean> {
	const w = context ?? (window as unknown as UploadWindow);
	if (typeof w.__x2Upload?.uploadImage === "function") return true;
	const reqs: WebpackRequire[] = await new Promise((resolve) => {
		const found: WebpackRequire[] = [];
		const names = Object.keys(w).filter((k) => /^webpackChunk/.test(k));
		let pending = names.length;
		if (!pending) return resolve(found);
		for (const n of names) {
			try {
				(w[n] as WebpackChunks).push([
					[`__x2_up_${n}_${Date.now()}`],
					{},
					(req: WebpackRequire) => {
						found.push(req);
						if (--pending <= 0) resolve(found);
					},
				]);
			} catch {
				if (--pending <= 0) resolve(found);
			}
		}
		setTimeout(() => resolve(found), 3000);
	});
	for (const req of reqs) {
		const uploadChunks = new Set<number>();
		for (let i = 0; i < 600; i++) {
			try {
				if (/upload\./.test(String(req.u?.(i) ?? ""))) uploadChunks.add(i);
			} catch {}
		}
		const chunks = new Set(uploadChunks);
		// 页面现有 loader 如 Promise.all([r.e(63),r.e(36)])：63 提供 UploadService，36 只创建实例。
		// 必须先完整加载依赖，再 require 模块，避免缺依赖时留下半初始化的 webpack 缓存。
		for (const source of Object.values(req.m ?? {}).map(String)) {
			for (const group of source.matchAll(/Promise\.all\(\[([^\]]+)\]\)/g)) {
				const ids = [...group[1]!.matchAll(/\.e\(\s*(\d+)\s*\)/g)].map((m) => Number(m[1]));
				if (ids.some((id) => uploadChunks.has(id))) for (const id of ids) chunks.add(id);
			}
		}
		try {
			await Promise.all([...chunks].map((id) => req.e(id)));
		} catch {
			continue;
		}
		for (const [id, factory] of Object.entries(req.m ?? {})) {
			if (!/UploadService|uploadImage|uploadapi\/api\/v1\/image/.test(String(factory))) continue;
			let mod: Record<string, unknown> | null;
			try {
				mod = req(id);
			} catch {
				continue;
			}
			for (const value of mod ? [mod.UploadService, mod.default, mod, ...Object.values(mod)] : []) {
				const candidate = value as Uploader | { $instance?: Uploader } | null;
				const uploader =
					candidate && typeof (candidate as Uploader).uploadImage === "function"
						? (candidate as Uploader)
						: typeof (candidate as { $instance?: Uploader } | null)?.$instance?.uploadImage === "function"
							? (candidate as { $instance: Uploader }).$instance
							: null;
				if (uploader) {
					w.__x2Upload = uploader;
					return true;
				}
			}
		}
	}
	return false;
}

export async function uploadImages(files: { base64: string; mime: string }[], biz = 4207): Promise<string[]> {
	const p = await productPage();
	let ready = false;
	for (let i = 0; i < 5 && !ready; i++) {
		ready = await p.run(prepareUploadService);
		if (!ready) await new Promise((r) => setTimeout(r, 2000));
	}
	if (!ready) throw new Error("没找到页面的 UploadService：先在浏览器里打开一次新增商品页");
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
