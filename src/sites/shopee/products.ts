// 商品：在售列表、状态、详情、类目、属性、上架用的读取；写：建、改、上下架、删、传图。
// 查过的事实（lilto 旧工作台，真店上踩过）：
// - 「我的商品 / 架上商品」是 opt/mpsku/list/v2/get_product_list?list_type=live_all，一页最多 48；search_product_list_v2?source=attribute_tool 是补属性工具，不是它
// - 商品状态（list_type=all）：0 删除、1 在售、2 审核中、3 禁卖、8 下架；别的值不猜
// - 属性树走 listing-upload/component/get_attribute_tree（POST）：可选值在 children，value_list 恒空；值要一字不差取自 children 的名字，编的值发布被拒
// - 类目推荐是 get_recommended_category（标题 + 已传的图 id）；get_image_category 已坏
// - 规格最多两层（tier）；一个商品最多 100 个规格，规格之间价差不超过 5 倍
// - 1000100256 是通用的字段校验失败码（缺尺码表也回它），不等于重复
// - 直接开卖的发布路径回 10025；成功的配方是先发成下架（unlisted: true），人看过再上架

import { NeedsHuman } from "../../core/errors.ts";
import { page } from "../browser.ts";
import { IMAGE, ORIGIN, seller, type Write, write } from "./seller.ts";

const image = (id: unknown) => (!id ? "" : /^https?:\/\//.test(String(id)) ? String(id) : `${IMAGE}${id}`);

export type Model = { modelId: string; sku: string; name: string; price: number | null; stock: number | null; sold: number | null; tierIndex: number[] };
export type Product = { productId: string; parentSku: string; name: string; cover: string; createdAt: string | null; models: Model[] };

/** 在售商品的一页（一页最多 48） */
export async function liveProducts(pageNo = 1, pageSize = 48): Promise<{ total: number; rows: Product[] }> {
	const b = await seller("/api/v3/opt/mpsku/list/v2/get_product_list", {
		query: { page_size: Math.min(48, pageSize), page_number: pageNo, list_type: "live_all", need_ads: false },
	});
	const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
	return {
		total: Number(b.data?.page_info?.total ?? 0),
		rows: ((b.data?.products ?? []) as any[]).map((p) => ({
			productId: String(p.id),
			parentSku: String(p.parent_sku ?? ""),
			name: String(p.name ?? ""),
			cover: image(p.cover_image),
			createdAt: Number(p.create_time) > 0 ? new Date(Number(p.create_time) * 1000).toISOString() : null,
			models: ((p.model_list ?? []) as any[]).map((m) => ({
				modelId: String(m.id),
				sku: String(m.sku ?? ""),
				name: String(m.name ?? ""),
				price: n(m.price_detail?.origin_price),
				stock: n(m.stock_detail?.total_seller_stock),
				sold: n(m.statistics?.sold_count),
				// 改商品的 model_list 必须带 tier_index
				tierIndex: ((m.tier_index ?? []) as unknown[]).map(Number),
			})),
		})),
	};
}

export const STATUS: Record<number, string> = { 0: "删除", 1: "在售", 2: "审核中", 3: "禁卖", 8: "下架" };

/** 全部商品（含下架、审核中）的一页：id、名字、状态码 */
export async function allProducts(
	pageNo = 1,
	pageSize = 48,
): Promise<{ total: number; rows: { productId: string; name: string; status: number; cover: string }[] }> {
	const b = await seller("/api/v3/opt/mpsku/list/v2/search_product_list", {
		query: { page_size: Math.min(48, pageSize), page_number: pageNo, list_type: "all", need_ads: false },
	});
	return {
		total: Number(b.data?.page_info?.total ?? 0),
		rows: ((b.data?.products ?? []) as any[]).map((p) => ({
			productId: String(p.id),
			name: String(p.name ?? ""),
			status: Number(p.status),
			cover: image(p.cover_image),
		})),
	};
}

/** 一个商品的完整资料（原样的 product_info：名字、描述、图、类目路径、属性、规格、重量、尺寸……）。改商品前先读它 */
export async function productInfo(productId: string): Promise<any> {
	const b = await seller("/api/v3/product/get_product_info", { query: { product_id: productId, is_draft: false } });
	if (!b.data?.product_info) throw new Error(`Shopee 没有回商品 ${productId} 的资料`);
	return b.data.product_info;
}

/** 物流渠道（启用哪些、谁付运费）。新商品给 productId 0、叶子类目 id */
export async function channels(productId: string, categoryId: number): Promise<any[]> {
	const b = await seller("/api/v3/listing-upload/component/get_product_channel_info", {
		body: { product_id: Number(productId), category_id: categoryId, is_draft: false },
	});
	return b.data?.list ?? [];
}

/** 商品额度：已发布、下架的、上限 */
export async function countLimit(): Promise<{ used: number; unlisted: number; limit: number }> {
	const b = await seller("/api/v3/opt/mpsku/list/get_product_count_limit");
	const d = b.data ?? b;
	return { used: Number(d.current_published), unlisted: Number(d.unlisted_count), limit: Number(d.publish_limit) };
}

/** 数据中心「商品表现」的一页（一页最多 50）：销售额、订单、件数、曝光、点击、访客、加购、转化。period 是 past7days 或 past30days，时间是秒 */
export async function performance(
	start: number,
	end: number,
	period: "past7days" | "past30days",
	pageNo = 1,
	pageSize = 50,
): Promise<{ total: number; rows: any[] }> {
	const b = await seller("/api/mydata/v4/product/performance/", {
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
	return { total: Number(b.result?.total ?? 0), rows: b.result?.items ?? [] };
}

export type Category = { id: string; name: string; children: Category[] };

/** Shopee 的类目树（台湾站，全店共用） */
export async function categoryTree(): Promise<Category[]> {
	const b = await seller("/api/v3/category/get_category_tree");
	const conv = (n: any): Category => ({ id: String(n.id), name: String(n.display_name ?? n.name ?? n.id), children: (n.children ?? []).map(conv) });
	const list = (b.data?.list ?? []) as any[];
	if (!list.length) throw new Error("Shopee 类目树是空的（没登录，或被风控）");
	return list.map(conv);
}

export type Attribute = { id: string; name: string; mandatory: boolean; maxValues: number; values: { valueId: string; name: string }[] };

/** 叶子类目的属性：必填的决定能不能上架；可选值只能从 values 里挑 */
export async function attributes(categoryId: number): Promise<Attribute[]> {
	const b = await seller("/api/v3/listing-upload/component/get_attribute_tree", { body: { category_id: categoryId } });
	return ((b.data?.list?.[0]?.attribute_tree ?? []) as any[]).map((a) => ({
		id: String(a.attribute_id),
		name: String(a.display_name ?? a.name ?? ""),
		mandatory: Boolean(a.mandatory),
		maxValues: Number(a.attribute_info?.max_value_count ?? 1),
		values: ((a.children ?? []) as any[]).map((c) => ({ valueId: String(c.value_id), name: String(c.display_name ?? c.name ?? "") })),
	}));
}

/** Shopee 推荐的类目：商品名 + 一张已传的图的 id。原样回 data */
export async function recommendedCategory(name: string, imageId = ""): Promise<any> {
	return (
		await seller("/api/v3/category/get_recommended_category", { body: { item_id: 0, name, image: imageId, description: "", description_type: "normal" } })
	).data;
}

/** 各类目的备货天数范围（较长备货）和现货的备货天数 */
export async function shippingDays(): Promise<{ inStock: number; rules: { categoryIds: string[]; min: number; max: number }[] }> {
	const b = await seller("/api/v3/product/get_product_constraints/");
	return {
		inStock: Number(b.data?.in_stock_dts),
		rules: ((b.data?.category_dts_setting ?? []) as any[]).map((r) => ({
			categoryIds: (r.category_id_list ?? []).map(String),
			min: Number(r.dts_min),
			max: Number(r.dts_max),
		})),
	};
}

// ── 写（建商品、上下架在 x2 里跑过；改别的字段、删商品还没跑过：lilto 旧工作台跑通过的做法，第一次用时人确认后再跑） ──

/** 写：建商品（create_product_info）。product_info 的样子照卖家中心新增商品页提交的（lilto 2026-09-01 的成功样本）；isDraft 为 true 存成草稿 */
export function createProduct(productInfo: Record<string, unknown>, isDraft = false): Promise<Write> {
	return write("/api/v3/product/create_product_info", { query: { _show_debug_info: 1 }, body: { is_draft: isDraft, product_info: productInfo } });
}

/** 写：改商品的几个字段（name、images、description_info、std_tier_variation_list、model_list、attributes、logistics_channels、pre_order_info、weight、dimension、unlisted、parent_sku）。
 * 改完规格要等几秒才读得到 */
export function updateProduct(productId: string, productInfo: Record<string, unknown>): Promise<Write> {
	return write("/api/v3/product/update_product_info", { body: { product_id: Number(productId), product_info: productInfo, is_draft: false } });
}

/** 写：上架（unlisted false）或下架（true） */
export const setUnlisted = (productId: string, unlisted: boolean) => updateProduct(productId, { unlisted });

/** 写：删商品。真删，平台没有回收站 */
export function deleteProducts(productIds: string[]): Promise<Write> {
	return write("/api/v3/product/delete_product_info", { body: { product_id_list: productIds.map(Number) } });
}

/** 到新增商品页（传图的 UploadService 只在这页加载）。店铺被限制时这页跳到「權限不足 / 賣場遷移中」：要人处理，不再往下做 */
export async function productPage() {
	const p = await page(ORIGIN);
	if (!/\/portal\/product\/(new|\d+)/.test(await p.run(() => location.pathname))) await p.goto(`${ORIGIN}/portal/product/new`);
	const blocked = await p.run(() => /no-permission/.test(location.href) || /您的權限不足|卖场迁移中|賣場遷移中/.test(String(document.body?.innerText ?? "")));
	if (blocked)
		throw new NeedsHuman("Shopee 这家店现在不能新增商品（權限不足 / 賣場遷移中）：到卖家中心看一眼；要暂停上品就在「店铺设置」的「暂停上品原因」里写原因");
	return p;
}

/** 写：传一批商品图，回每张的图片 id（顺序同 files）。图片服务的签名只有页面里的 UploadService 算得出：到 webpack 模块里找它，找到记在页面上，一张一张传（隔 0.5 秒）。
 * biz 4207 是商品图。任何一张失败就抛错（传图不收钱、不上架，重来就是）。bytes 经 base64 传进页面 */
export async function uploadImages(files: { base64: string; mime: string }[], biz = 4207): Promise<string[]> {
	const p = await productPage();
	const ids: string[] = [];
	for (const [i, f] of files.entries()) {
		if (i > 0) await new Promise((r) => setTimeout(r, 500));
		const ext = f.mime === "image/png" ? "png" : f.mime === "image/webp" ? "webp" : "jpg";
		const r = await p.run(
			async (b64: string, filename: string, mime: string, biz: number) => {
				const w = window as any;
				const find = async () => {
					const reqs: any[] = await new Promise((resolve) => {
						const found: any[] = [];
						const names = Object.keys(w).filter((k) => /^webpackChunk/.test(k));
						let pending = names.length;
						if (!pending) return resolve(found);
						for (const n of names) {
							try {
								w[n].push([
									[`__x2_up_${n}_${Date.now()}`],
									{},
									(req: any) => {
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
						// 上传模块在按需加载的代码块里：先把名字里带 upload. 的代码块都加载了
						for (let i = 0; i < 600; i++) {
							let u: unknown;
							try {
								u = req.u?.(i);
							} catch {
								continue;
							}
							if (u && /upload\./.test(String(u))) {
								try {
									await req.e(i);
								} catch {
									/* 没有这一块 */
								}
							}
						}
						for (const id in req.m ?? {}) {
							if (!/uploadImage|uploadapi\/api\/v1\/image/.test(String(req.m[id]))) continue;
							let mod: any;
							try {
								mod = req(id);
							} catch {
								continue;
							}
							for (const v of mod ? [mod.UploadService, mod.default, mod, ...Object.values(mod)] : []) {
								if (typeof v === "function" && typeof v.prototype?.uploadImage === "function" && typeof v.$instance?.uploadImage === "function")
									return v.$instance;
							}
						}
					}
					return null;
				};
				for (let i = 0; i < 5 && !w.__x2Upload; i++) {
					w.__x2Upload = await find();
					if (!w.__x2Upload) await new Promise((r) => setTimeout(r, 2000));
				}
				if (!w.__x2Upload) return { error: "没找到页面的 UploadService：先在浏览器里打开一次新增商品页" };
				const bin = atob(b64);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				const res = await w.__x2Upload.uploadImage(new File([bytes], filename, { type: mime }), { biz, func: ["compress"], useMms: true });
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

/** 写：传一张商品图，回图片 id */
export async function uploadImage(base64: string, filename = "x2.jpg", mime = "image/jpeg", biz = 4207): Promise<string> {
	void filename;
	return (await uploadImages([{ base64, mime }], biz))[0]!;
}
