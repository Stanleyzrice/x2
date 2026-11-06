// 导出全部匹配的已付款采购记录：同一只读数据库快照包含订单和人工标记，三个工作表由同一结果生成，不刷新外站或改报帐状态。
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { money, paymentRange, type StoredPurchase, summarizeOriginalAmounts } from "./facts.ts";
import { checkScope, type RecordQuery, recordFilter } from "./query.ts";
import { type Sheet, XLSX_MIME, xlsxBuffer } from "./xlsx.ts";

export type ExportRow = {
	account: string;
	accountName: string;
	fact: StoredPurchase;
	capturedAt: Date;
	revision: string;
	absentFromLatest: boolean;
	reported: boolean;
	reportRevision: number;
	reportedAt: Date | null;
};
type Snapshot = { snapshotAt: Date; rows: ExportRow[] };
const known = (value: string | null | undefined) => value ?? "未知";
const localTime = (value: string | Date | null) => (value ? new Date(value).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai", hour12: false }) : "未知");
const columns = (values: [string, number][]) => values.map(([header, width]) => ({ header, width }));

export async function readExportSnapshot(sql: Sql, p: RecordQuery): Promise<Snapshot> {
	checkScope(p);
	paymentRange(p.paidFrom, p.paidTo);
	return sql.begin("isolation level repeatable read read only", async (tx) => {
		const [clock] = await tx<{ snapshotAt: Date }[]>`select transaction_timestamp() as "snapshotAt"`;
		if (!clock) throw new Error("数据库没有返回导出快照时间");
		const filter = recordFilter(tx, p);
		const rows = await tx<ExportRow[]>`select o.account_id as account, a.name as "accountName", o.fact, o.captured_at as "capturedAt",
 o.revision, o.revision <> a.revision as "absentFromLatest", coalesce(m.reported, false) as reported,
 coalesce(m.revision, 0) as "reportRevision", case when m.reported then m.updated_at end as "reportedAt"
 from reimbursement_orders o join reimbursement_accounts a on a.account_id = o.account_id
 left join reimbursement_marks m on m.account_id = o.account_id and m.order_id = o.order_id ${filter}
 order by o.paid_at desc, o.account_id, o.order_id`;
		return { snapshotAt: clock.snapshotAt, rows };
	});
}

export async function createExport(snapshot: Snapshot, p: RecordQuery) {
	checkScope(p);
	for (const row of snapshot.rows) {
		if ((p.accounts && !p.accounts.includes(row.account)) || (p.account && p.account !== row.account)) throw new Usage("导出记录超出当前允许的采购账号范围");
		if (!row.fact.receipt.paidAt) throw new Usage("导出记录缺少明确的付款时间证据，不能列为已付款采购订单");
	}
	const summary = summarizeOriginalAmounts(snapshot.rows.map((row) => row.fact.receipt.originalMinor));
	const pendingSummary = summarizeOriginalAmounts(snapshot.rows.filter((row) => !row.reported).map((row) => row.fact.receipt.originalMinor));
	const orders: Sheet = {
		name: "订单汇总",
		columns: columns([
			["采购账号ID", 24],
			["采购账号名称", 24],
			["1688采购订单号", 26],
			["付款时间（Asia/Shanghai）", 24],
			["供应商", 28],
			["原实付（CNY元）", 24],
			["原实付（分，精确文本）", 28],
			["商品金额（分）", 24],
			["运费（分）", 18],
			["优惠（分）", 18],
			["币种", 12],
			["整单状态码", 24],
			["整单状态", 22],
			["人工已报帐", 16],
			["标记版本", 14],
			["已报帐时间（Asia/Shanghai）", 26],
			["商品行数", 14],
			["采集时间（Asia/Shanghai）", 24],
			["采购记录版本", 40],
			["原付款证据版本", 40],
			["本次网站实付（分）", 26],
			["不在最近成功批次", 22],
			["1688订单链接", 60],
		]),
		rows: snapshot.rows.map((r) => {
			const f = r.fact;
			return [
				r.account,
				r.accountName,
				f.orderId,
				localTime(f.receipt.paidAt),
				known(f.supplier),
				known(money(f.receipt.originalMinor)),
				known(f.receipt.originalMinor),
				known(f.goodsMinor),
				known(f.freightMinor),
				known(f.discountMinor),
				f.currency,
				known(f.status),
				known(f.statusLabel),
				r.reported ? "是" : "否",
				r.reportRevision,
				localTime(r.reportedAt),
				f.items.length,
				localTime(r.capturedAt),
				r.revision,
				known(f.receipt.revision),
				known(f.paidMinor),
				r.absentFromLatest ? "是" : "否",
				`https://trade.1688.com/order/new_step_order_detail.htm?orderId=${encodeURIComponent(f.orderId)}`,
			];
		}),
	};
	const items: Sheet = {
		name: "商品规格明细",
		columns: columns([
			["采购账号ID", 24],
			["采购账号名称", 24],
			["1688采购订单号", 26],
			["采购行ID", 26],
			["1688商品ID", 26],
			["1688 SKU ID", 26],
			["规格ID", 36],
			["商品名称", 48],
			["规格", 48],
			["数量", 16],
			["单价（CNY元）", 24],
			["单价（分，精确文本）", 28],
			["行状态码", 24],
			["行状态", 24],
			["退款单号", 28],
			["退款阶段", 16],
			["退款状态", 24],
			["商品图片URL", 60],
			["人工已报帐", 16],
		]),
		rows: snapshot.rows.flatMap((r) =>
			r.fact.items.map((i) => [
				r.account,
				r.accountName,
				r.fact.orderId,
				known(i.lineId),
				known(i.offerId),
				known(i.skuId),
				known(i.fulfillment?.specId),
				known(i.name),
				known(i.spec),
				known(i.quantity),
				known(money(i.unitPriceMinor)),
				known(i.unitPriceMinor),
				known(i.fulfillment?.status),
				known(i.fulfillment?.statusLabel),
				known(i.fulfillment?.refund?.id),
				known(i.fulfillment?.refund?.stage),
				known(i.fulfillment?.refund?.status),
				known(i.image),
				r.reported ? "是" : "否",
			]),
		),
	};
	const meta: Sheet = {
		name: "筛选与金额汇总",
		columns: columns([
			["项目", 30],
			["内容", 110],
		]),
		rows: [
			["导出快照时间（Asia/Shanghai）", localTime(snapshot.snapshotAt)],
			["导出快照时间（UTC）", snapshot.snapshotAt.toISOString()],
			["快照一致性", "同一数据库只读可重复读事务读取订单与人工标记；三个工作表使用同一份全部匹配结果"],
			["页面允许的采购账号ID", p.accounts?.join("、") ?? "全部账号"],
			["当前筛选采购账号ID", p.account ?? "允许范围内全部账号"],
			["搜索", p.search],
			["付款起始日（含）", p.paidFrom || "不限"],
			["付款截止日（含）", p.paidTo || "不限"],
			["日期筛选时区", "Asia/Shanghai"],
			["全部匹配订单数", summary.orderCount],
			["原实付已知订单数", summary.knownCount],
			["原实付未知订单数", summary.missingCount],
			["已知原实付合计（CNY元）", known(summary.amountDisplay)],
			["已知原实付合计（分）", known(summary.amountMinor)],
			["原实付汇总完整", summary.complete ? "是" : "否，存在金额未知订单"],
			["待报帐订单数", pendingSummary.orderCount],
			["待报帐金额已知订单数", pendingSummary.knownCount],
			["待报帐金额未知订单数", pendingSummary.missingCount],
			["已知待报帐合计（CNY元）", known(pendingSummary.amountDisplay)],
			["已知待报帐合计（分）", known(pendingSummary.amountMinor)],
			["待报帐汇总完整", pendingSummary.complete ? "是" : "否，存在金额未知订单"],
			["金额口径", "原付款凭证实付，CNY；不扣减退款，未知不补零；金额、订单号和SKU保存为精确文本"],
			["人工标记含义", "人工已报帐仅为本地跟踪，不代表外部报账提交、批准或付款；导出不刷新采购记录、不修改任何标记"],
		],
	};
	const bytes = await xlsxBuffer([orders, items, meta], snapshot.snapshotAt);
	return {
		filename: `1688采购报账_${localTime(snapshot.snapshotAt).replace(/[-: ]/g, "")}.xlsx`,
		mime: XLSX_MIME,
		base64: bytes.toString("base64"),
		snapshotAt: snapshot.snapshotAt.toISOString(),
		orderCount: snapshot.rows.length,
		itemCount: items.rows.length,
		summary,
		pendingSummary,
	};
}

export async function exportRecords(sql: Sql, p: RecordQuery) {
	return createExport(await readExportSnapshot(sql, p), p);
}
