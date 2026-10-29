// 订单给网页的表：订单（进度看板）、货源（人勾「选用」、写规格例外）、到货问题（表单上报）、订单设置
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import type { Key, Table } from "../../platform/web/tables.ts";
import { STEPS } from "./check.ts";

/** 选用：一个商品只用一个货源，勾上这一个就去掉同一个商品别的货源的勾 */
async function choose(sql: Sql, key: Key, value: unknown): Promise<void> {
	if (typeof value !== "boolean") throw new Usage("选用：要 true 或 false");
	await sql.begin(async (tx) => {
		if (value) await tx`update sources set chosen = false, chosen_at = null where item_id = ${key.item_id!} and offer_id <> ${key.offer_id!} and chosen`;
		await tx`update sources set chosen = ${value}, chosen_at = ${value ? new Date() : null} where item_id = ${key.item_id!} and offer_id = ${key.offer_id!}`;
	});
}

export const ORDER_TABLES: Table[] = [
	{
		name: "orders",
		title: "订单",
		key: ["sn"],
		columns: {
			sn: "订单号",
			shop: "店铺",
			ship_by: "出货期限",
			days_left: "剩余天数",
			step: "当前步骤",
			step_detail: "说明",
			items_text: "商品",
			platform_status: "平台状态",
			chanboss_status: "chanboss 状态",
			problem: "问题单",
			destination: "收货地址",
			created_at: "下单时间",
			cancelled_at: "取消时间",
			checked_at: "检查时间",
		},
		views: [{ title: "全部", order: "ship_by nulls last", group: { col: "step", values: STEPS } }],
	},
	{
		name: "sources",
		title: "货源",
		key: ["item_id", "offer_id"],
		links: ["url"],
		images: ["image", "item_image"],
		columns: {
			item_name: "店里的商品",
			item_image: "店里的图",
			chosen: "选用",
			image: "货源的图",
			title: "货源",
			url: "链接",
			sku_exceptions: "规格例外",
			score: "相似度",
			missing: "未匹配的规格",
			sure: "明显匹配",
			origin: "来源",
			broken: "不可用",
			chosen_at: "选定时间",
		},
		edit: { chosen: { set: choose }, sku_exceptions: {} },
		// 一组里没勾「选用」的就是还没选
		views: [{ title: "全部", order: "chosen desc, score desc nulls last", group: { col: "item_name" } }],
	},
	{
		name: "arrival_issues",
		title: "到货问题",
		key: ["id"],
		columns: {
			sn: "订单号",
			item: "商品和规格",
			kind: "问题类型",
			qty: "件数",
			note: "备注",
			resolution: "处理方式",
			done: "已处理",
			reported_at: "上报时间",
			done_at: "处理时间",
		},
		edit: {
			sn: {},
			item: {},
			kind: { options: ["错货", "少件", "损坏", "其他"] },
			qty: {},
			note: {},
			resolution: { options: ["退换", "重新采购", "无需处理"] },
			done: {},
		},
		views: [{ title: "全部", order: "done, reported_at desc" }],
		form: {
			title: "上报到货问题",
			required: ["sn", "kind"],
			fields: { sn: "订单号（拣货单上的）", item: "例：红T L", kind: "", qty: "", note: "看到的情况；照片存放位置", resolution: "已确定就选，未确定留空" },
		},
	},
	{
		name: "order_settings",
		title: "订单设置",
		key: ["id"],
		columns: {
			buy_account: "采购账号（1688 会员名）",
			late_days: "快到期提醒（天）",
			ship_wait_hours: "未发货提醒（付款后小时数）",
			channel: "发货线路",
			sendway_id: "发货线路代码",
			line_id: "线路 id",
			warehouse_id: "仓库 id",
		},
		edit: Object.fromEntries(["buy_account", "late_days", "ship_wait_hours", "channel", "sendway_id", "line_id", "warehouse_id"].map((c) => [c, {}])),
		views: [{ title: "设置", order: "id", cards: true }],
	},
];
