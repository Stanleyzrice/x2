// 采购记录页面引用固定账号范围；人工报帐标记按订单身份和版本保存，金额仍由服务端返回。
import { z } from "zod";
import { title } from "../../props.ts";

export const description =
	"1688 已付款采购记录：按日期、账号和搜索筛选，汇总全部匹配原实付与待报帐金额；查看逐项商品图片与ID，按版本保存人工已报帐标记；展示装配的后台刷新时间";
export const props = z.strictObject({
	title,
	accounts: z.array(z.string().min(1)).min(1).optional().describe("固定允许查看的采购账号 ID；不给是全部账号"),
	schedule: z
		.object({ hour: z.number().int().min(0).max(23), timeZone: z.string().trim().min(1) })
		.optional()
		.describe("实际注册的后台刷新时间；不给不承诺自动刷新"),
});
export type Props = z.infer<typeof props>;
export const actions = {
	list: "reimbursement.list",
	refresh: "reimbursement.refresh",
	markReported: "reimbursement.mark-reported",
	export: "reimbursement.export",
};
export const inputs = ["account", "search", "paidFrom", "paidTo", "offset", "orderId", "reported", "revision"];
export const examples: z.input<typeof props>[] = [{ title: "采购报账" }];
