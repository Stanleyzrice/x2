// 选品给网页的表：策略、策略变更记录、选品规矩（只看，改走 x2 selection 的工具）
import type { Table } from "../../platform/web/tables.ts";

export const SELECTION_TABLES: Table[] = [
	{
		name: "strategies",
		title: "策略",
		key: ["name"],
		columns: { name: "策略", status: "状态", version: "版本号", bet: "假设", how: "选品方法", note: "备注", updated_at: "更新时间" },
		views: [{ title: "全部", order: "status = '已停用', created_at desc" }],
	},
	{
		name: "strategy_changes",
		title: "策略变更记录",
		key: ["id"],
		columns: { strategy: "策略", version: "版本号", before: "改之前", after: "改之后", why: "理由", changed_at: "变更时间" },
		views: [{ title: "全部", order: "changed_at desc" }],
	},
	{
		name: "selection_rules",
		title: "选品规矩",
		key: ["id"],
		columns: { id: "编号", rule: "规矩", why: "理由", started_at: "开始时间", ended_at: "结束时间", retire_why: "停用原因" },
		views: [{ title: "全部", order: "ended_at is not null, id" }],
	},
];
