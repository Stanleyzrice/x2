// 钱：卖家中心「我的進帳」。金额是新台币乘 100000（例 12345600000 = NT$123456）。
// 财务区可能要求再输入一次登录密码：回 401、403，或消息里有密碼、驗證——请人在浏览器里验证，不代输密码
import { seller } from "./seller.ts";

/** 金额换成新台币 */
export const twd = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v) / 100000);

/** 已拨款的订单收入的一页（income_category 2 = 已拨款），按拨款日期（YYYY-MM-DD，台湾时间）筛。
 * 翻页用上一页回的 nextCursor，空字符串是到底了。入账后还会有调整（adjustment_income_amount） */
export async function income(startDate: string, endDate: string, cursor = "", limit = 50): Promise<{ nextCursor: string; rows: any[] }> {
	const b = await seller("/api/v4/accounting/pc/seller_income/income_overview/get_income_detail", {
		body: {
			source_type: 0,
			income_category: 2,
			pagination_info: { direction: 0, limit: Math.min(50, limit), ...(cursor ? { cursor } : {}) },
			local_query_condition: { start_date: startDate, end_date: endDate },
		},
	});
	return { nextCursor: String(b.data?.next_page?.cursor ?? ""), rows: b.data?.list ?? [] };
}

/** 一张订单的收入明细：分两次读（components [2,3,4] 和 [5]），各自原样回。汇总和子项不要重复相加 */
export async function incomeComponents(orderId: string): Promise<any[]> {
	const out = [];
	for (const components of [[2, 3, 4], [5]]) {
		const b = await seller("/api/v4/accounting/pc/seller_income/income_detail/get_order_income_components", {
			body: { order_id: Number(orderId), components },
		});
		if (String(b.data?.order_info?.order_id) !== orderId) throw new Error(`Shopee 回的收入明细不是订单 ${orderId}`);
		out.push({ components, data: b.data });
	}
	return out;
}
