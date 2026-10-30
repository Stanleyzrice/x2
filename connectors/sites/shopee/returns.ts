// 售后：退货、退款、不成立（卖家中心「退貨/退款/不成立」，2026-09-10 的列表）。外壳是 { error, error_msg, data }
import { z } from "zod";
import { row, seller, withData } from "./seller.ts";

// 没有 exceptional_case_list 不能当成没有案件：是「回包变了」
const list = withData(
	z.looseObject({
		exceptional_case_list: z.array(row),
		total: z.union([z.number(), z.string()]).nullish(),
		pagination_info: z.looseObject({ has_more: z.boolean().nullish() }).nullish(),
	}),
);

export async function cases(pageNo = 1): Promise<{ total: number; hasMore: boolean; rows: Record<string, unknown>[] }> {
	const b = await seller("/api/v4/seller_center/return/return_list/get_exceptional_case_list", list, {
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
	return { total: Number(b.data.total ?? 0), hasMore: b.data.pagination_info?.has_more === true, rows: b.data.exceptional_case_list };
}
