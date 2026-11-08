// 只导出未勾选已报帐的采购报账表：逐行放下单商品图，每单金额只写一次，本批报账总计放在末列首行。
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { money, paymentRange, type StoredPurchase, summarizeOriginalAmounts } from "./facts.ts";
import { checkScope, type RecordQuery, recordFilter } from "./query.ts";
import { type ImageReader, type Sheet, XLSX_MIME, xlsxBuffer } from "./xlsx.ts";

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
 and coalesce(m.reported, false) = false
 order by o.paid_at desc, o.account_id, o.order_id`;
		return { snapshotAt: clock.snapshotAt, rows };
	});
}

export async function createExport(snapshot: Snapshot, p: RecordQuery, readImage?: ImageReader) {
	checkScope(p);
	for (const row of snapshot.rows) {
		if ((p.accounts && !p.accounts.includes(row.account)) || (p.account && p.account !== row.account)) throw new Usage("导出记录超出当前允许的采购账号范围");
		if (!row.fact.receipt.paidAt) throw new Usage("导出记录缺少明确的付款时间证据，不能列为已付款采购订单");
	}
	const rows = snapshot.rows.filter((row) => !row.reported);
	const summary = summarizeOriginalAmounts(rows.map((row) => row.fact.receipt.originalMinor));
	const orders: Sheet = {
		name: "采购报账",
		columns: columns([
			["订单截图", 38],
			["总价", 24],
			["产品成本单价", 34],
			["购买数量（精确到单个）", 32],
			["实际付款", 24],
			["订单号", 38],
			["报账金额总计", 36],
		]),
		rows: [],
		images: [],
	};
	for (const { fact } of rows) {
		for (const [index, item] of (fact.items.length ? fact.items : [null]).entries()) {
			if (item?.image) orders.images!.push({ row: orders.rows.length + 2, column: 1, url: item.image });
			orders.rows.push([
				"",
				index === 0 ? known(money(fact.goodsMinor)) : "",
				known(item ? money(item.unitPriceMinor) : null),
				known(item?.quantity),
				index === 0 ? known(money(fact.receipt.originalMinor)) : "",
				fact.orderId,
				"",
			]);
		}
	}
	if (!orders.rows.length) orders.rows.push(orders.columns.map(() => ""));
	orders.rows[0]![6] = summary.complete
		? known(summary.amountDisplay)
		: `金额不全（缺${summary.missingCount}单${summary.amountDisplay ? `；已知合计${summary.amountDisplay}` : ""}）`;
	const bytes = await xlsxBuffer([orders], snapshot.snapshotAt, readImage);
	return {
		filename: `1688采购报账_${localTime(snapshot.snapshotAt).replace(/[-: ]/g, "")}.xlsx`,
		mime: XLSX_MIME,
		base64: bytes.toString("base64"),
		snapshotAt: snapshot.snapshotAt.toISOString(),
		orderCount: rows.length,
		itemCount: rows.reduce((count, row) => count + row.fact.items.length, 0),
		summary,
		pendingSummary: summary,
	};
}

export async function exportRecords(sql: Sql, p: RecordQuery) {
	return createExport(await readExportSnapshot(sql, p), p);
}
