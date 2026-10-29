// 经营数据、评价、广告、优惠券、组合购、折扣。广告、折扣的金额是新台币乘 100000。时间是秒（台湾时间，没有夏令时）

const DAY = 86400;
/** 台湾时间某一天零点的秒数：daysAgo 0 是今天 */
export const twMidnight = (daysAgo = 0) => Math.floor((Date.now() / 1000 + 8 * 3600) / DAY) * DAY - 8 * 3600 - daysAgo * DAY;

import { seller, type Write, write } from "./seller.ts";

// ── 经营数据 ──

/** 数据中心的店铺关键指标（成交额 paid_gmv、订单 paid_orders、访客 shop_uv、点击 product_clicks、转化……，每个带 value 和逐日 points）。
 * period：past7days 或 real_time。访客是平台去重的，不能由商品相加 */
export async function shopMetrics(start: number, end: number, period: "past7days" | "real_time"): Promise<any> {
	return (await seller("/api/mydata/v3/dashboard/key-metrics/", { query: { start_time: start, end_time: end, period } })).result;
}

// ── 评价 ──

/** 评价的一页（20 条）。cursor 是上一页最后一条的 comment_id，第一页是 "0"；给了订单号只找它的评价。
 * 回复评价要在「评价管理」页上点它的按钮、填表单（没有写成函数，见同目录的 NOTES.md） */
export async function reviews(pageNo = 1, cursor = "0", orderSn?: string): Promise<{ total: number; rows: any[] }> {
	const b = await seller("/api/v3/settings/search_shop_rating_comments_new/", {
		query: {
			page_number: pageNo,
			page_size: 20,
			cursor,
			from_page_number: Math.max(1, pageNo - 1),
			language: "zh-Hant",
			rating_star: "5,4,3,2,1",
			...(orderSn ? { search_request: orderSn } : {}),
		},
	});
	return { total: Number(b.data?.page_info?.total ?? 0), rows: b.data?.list ?? [] };
}

// ── 广告 ──
// 顺序：账户和余额 → 各类广告能不能开（setup status）→ 计划列表（一页 20）→ 每个计划的详情（店铺广告 shop_auto、shop_manual 没有详情接口，用列表里的）
// → 表现曲线（time graph）→ 自动选品广告（product_gms）里每个商品的表现（一页只能 10，多了被拒）

const pas = (path: string, body: unknown) => seller(`/api/pas/v1/${path}/`, { body });

/** 广告账户（ads_account）和广告余额（ads_credit） */
export const adsAccount = async () => (await pas("meta/get_ads_data", { info_type_list: ["ads_account", "ads_credit"] })).data;

/** 自动、自动选品、手动、多商品各类广告能不能开，已开的计划 id */
export const adsSetup = async () => (await pas("product/get_setup_status", { reference_id: crypto.randomUUID() })).data;

/** 广告计划列表的一页（20 个），带期间内的汇总表现 report。has_report_failure 是 true 时表现不完整。
 * start、end 要对齐台湾时间的整天（start 是零点，end 是某天的 23:59:59），不对齐回 5 invalid request（2026-09-30 查过） */
export async function campaigns(start: number, end: number, offset = 0): Promise<{ total: number; rows: any[]; reportFailed: boolean }> {
	const d = (
		await pas("homepage/query", {
			start_time: start,
			end_time: end,
			filter_list: [{ campaign_type: "cpc_homepage_v3", state: "all", search_term: "", is_valid_rebate_only: false }],
			offset,
			limit: 20,
			use_paid_gmv: false,
		})
	).data;
	return { total: Number(d?.total ?? 0), rows: d?.entry_list ?? [], reportFailed: d?.has_report_failure !== false };
}

/** 一个商品广告计划的详情：campaign（类型、预算、目标 ROAS、期间）和 ads_list */
export const campaign = async (campaignId: string) => (await pas("product/get", { campaign_id: Number(campaignId) })).data;

/** 一个计划在期间内的表现：report_aggregate 汇总、report_by_time 逐日（key 是那天零点的秒）。type 是计划的类型（例 product_gms）。
 * agg_interval 是几个 15 分钟：1 是每 15 分钟（7 天 672 个点、半 MB），96 是一天（2026-10-09 查过） */
export async function campaignGraph(campaignId: string, type: string, start: number, end: number): Promise<any> {
	return (
		await pas("report/get_time_graph", {
			agg_interval: 96,
			agg_type: type,
			campaign_type: type,
			start_time: start,
			end_time: end,
			need_ratio: true,
			filter_params: { campaign_id: Number(campaignId) },
		})
	).data;
}

/** 自动选品广告里各商品的表现，一页 10 个（只能 10）；翻页用回的 next_page_token，空的是到底。
 * withImpressionOnly 为 false 时回的是全店能投的商品，不是这个计划的 */
export async function gmsItems(
	campaignId: string,
	start: number,
	end: number,
	lastToken = "",
	withImpressionOnly = true,
): Promise<{ next: string; rows: any[] }> {
	const d = (
		await pas("product/gms/list_item_product_performance", {
			reference_id: crypto.randomUUID(),
			campaign_id: Number(campaignId),
			start_time: start,
			end_time: end,
			pagination: { last_token: lastToken, limit: 10 },
			sorting: { key: "default_sort_v3", direction: "desc" },
			filter: { item_with_impression_only: withImpressionOnly },
			use_paid_gmv: false,
		})
	).data;
	return { next: String(d?.next_page_token ?? ""), rows: d?.result_list ?? [] };
}

// ── 优惠券、组合购、折扣 ──

/** 优惠券列表的一页（10 张）；voucher() 读一张的详情 */
export async function vouchers(offset = 0): Promise<{ total: number; rows: any[] }> {
	const b = await seller("/api/marketing/v3/voucher/list/", { query: { limit: 10, offset, promotion_type: 0 } });
	return { total: Number(b.data?.total_count ?? 0), rows: b.data?.voucher_list ?? [] };
}
export const voucher = async (voucherId: string) => (await seller("/api/marketing/v3/voucher/", { query: { voucher_id: voucherId } })).data;

/** 组合购（bundle deal）列表的一页（10 个）：只有活动、期间、商品数，没有优惠金额和实际使用 */
export async function bundles(offset = 0): Promise<{ total: number; rows: any[] }> {
	const b = await seller("/api/marketing/v3/public/discount/list/", { body: { discount_type: 3, time_status: 0, offset, limit: 10 } });
	return { total: Number(b.data?.total_count ?? 0), rows: b.data?.discounts ?? [] };
}

/** 折扣活动列表（进行中的，schedule_status 2）；给了活动 id 回这个活动里各规格的折扣价（promotion_price，乘 100000） */
export async function discounts(offset = 0, limit = 100): Promise<any> {
	return (await seller("/api/marketing/v4/discount/get_discount_list/", { body: { schedule_status: 2, need_count: true, need_image: false, offset, limit } }))
		.data;
}
export async function discountItems(promotionId: number, offset = 0, limit = 100): Promise<any> {
	return (await seller("/api/marketing/v4/discount/get_discount_items_aggregated/", { body: { promotion_id: promotionId, offset, limit } })).data;
}

/** 写：改折扣活动里几个规格的折扣价、限购、库存（item_id、model_id、promotion_price 必填，价格乘 100000）。
 * 站点回成功时 data.error_list 里还可能有某几个规格没改成：要回读（没在 x2 里跑过） */
export function updateDiscountItems(
	promotionId: number,
	items: { item_id: number; model_id: number; promotion_price: number; user_item_limit?: number; status?: number; promotion_stock?: number }[],
): Promise<Write> {
	return write("/api/marketing/v4/discount/update_seller_discount_items/", { body: { promotion_id: promotionId, discount_model_list: items } });
}
