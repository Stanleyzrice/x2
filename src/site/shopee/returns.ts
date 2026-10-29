// 售后：退货、退款、不成立（卖家中心「退貨/退款/不成立」，2026-09-10 的列表）。外壳是 { error, error_msg, data }
import { seller } from "./seller.ts";

/** 售后列表的一页（40 个）。每个案件：entity_id_str、order_sn、状态 header.status_text、原因、要的解决方式、退款金额、商品 */
export async function cases(pageNo = 1): Promise<{ total: number; hasMore: boolean; rows: any[] }> {
	const b = await seller("/api/v4/seller_center/return/return_list/get_exceptional_case_list", {
		body: {
			language: "zh-Hant",
			platform_type: "sc",
			page_number: pageNo,
			page_size: 40,
			flow_tab: 1,
			case_tab: 0,
			sorting_field: 1,
			is_reverse_sorting_order: false,
			keyword: null,
			pending_action: null,
			request_solution: null,
			forward_logistics_statuses: [],
			reverse_logistics_statuses: [],
			return_reasons: [],
			seller_request_statuses: [],
			create_time_range: { lower_value: null, upper_value: null },
			refund_amount_range: { lower_value: null, upper_value: null },
			key_action_due_time_range: { lower_value: null, upper_value: null },
			compensation_amount_option: null,
			advanced_fulfilment_option: null,
			validation_type_option: null,
			request_adjusted: null,
		},
	});
	if (!Array.isArray(b.data?.exceptional_case_list)) throw new Error("Shopee 售后列表的格式变了（没有 exceptional_case_list）");
	return { total: Number(b.data.total ?? 0), hasMore: b.data.pagination_info?.has_more === true, rows: b.data.exceptional_case_list };
}
