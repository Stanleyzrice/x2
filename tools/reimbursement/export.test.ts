// 用内存采购事实生成并读回真实工作簿，核对完整匹配、精确金额、文本ID、公式隔离及导出事务的账号边界，不连接数据库或外站。
import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS, { type Worksheet } from "exceljs";
import type { Sql } from "../../platform/db/index.ts";
import { createExport, type ExportRow, readExportSnapshot } from "./export.ts";

const snapshotAt = new Date("2026-11-06T07:08:09.000Z");
const record = (index: number, originalMinor: string | null = "100"): ExportRow => ({
	account: "A",
	accountName: "采购账号A",
	capturedAt: new Date("2026-11-06T00:00:00.000Z"),
	revision: "current-batch",
	absentFromLatest: false,
	reported: index < 25 || index === 50,
	reportRevision: index < 25 || index === 50 ? 3 : 0,
	reportedAt: index < 25 || index === 50 ? new Date("2026-11-05T00:00:00.000Z") : null,
	fact: {
		orderId: (3012345678901234567n + BigInt(index)).toString(),
		status: "success",
		statusLabel: "交易成功",
		createdAt: "2026-10-01 12:00:00",
		paidAt: null,
		paymentEvidence: null,
		supplier: '=HYPERLINK("https://example.com","外部文本")',
		currency: "CNY",
		goodsMinor: "100",
		freightMinor: null,
		discountMinor: "0",
		paidMinor: "0",
		receipt: { paidAt: "2026-11-01T00:00:00.000Z", originalMinor, revision: "payment-evidence-batch" },
		items: [
			{
				lineId: "900719925474099312345",
				offerId: "720000000001",
				skuId: "0009007199254740993123",
				name: "+SUM(1,2)",
				image: "https://example.com/item.jpg",
				spec: "@外部规格文本",
				quantity: "3",
				unitPriceMinor: "810",
				fulfillment: { specId: "spec-long", status: "waitbuyerreceive", statusLabel: "已发货", refund: null },
			},
		],
	},
});

async function open(base64: string) {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(Uint8Array.from(Buffer.from(base64, "base64")).buffer);
	return workbook;
}

function cell(sheet: Worksheet, row: number, header: string) {
	const column = Array.from({ length: sheet.columnCount }, (_, n) => n + 1).find((n) => sheet.getCell(1, n).value === header);
	assert.ok(column, `缺少列 ${header}`);
	return sheet.getCell(row, column);
}

function metric(sheet: Worksheet, label: string) {
	for (let row = 2; row <= sheet.rowCount; row++) if (sheet.getCell(row, 1).value === label) return sheet.getCell(row, 2).value;
	throw new Error(`缺少汇总 ${label}`);
}

test("导出包含全部52单及商品明细，原付款凭证与人工标记保持独立，金额未知不当零", async () => {
	const rows = Array.from({ length: 52 }, (_, index) => record(index, index === 51 ? null : index === 50 ? "5000" : "100"));
	const result = await createExport({ snapshotAt, rows }, { accounts: ["A"], account: "A", search: "规格", paidFrom: "2026-11-01", paidTo: "2026-11-06" });
	assert.equal(result.orderCount, 52);
	assert.equal(result.itemCount, 52);
	assert.equal(result.summary.amountMinor, "10000");
	assert.equal(result.summary.missingCount, 1);
	assert.equal(result.pendingSummary.amountMinor, "2500");
	assert.equal(result.pendingSummary.orderCount, 26);
	assert.equal(result.pendingSummary.missingCount, 1);
	assert.equal(result.snapshotAt, snapshotAt.toISOString());
	assert.match(result.filename, /20261106150809\.xlsx$/);
	assert.equal(result.mime, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
	const workbook = await open(result.base64);
	assert.deepEqual(
		workbook.worksheets.map((sheet) => sheet.name),
		["订单汇总", "商品规格明细", "筛选与金额汇总"],
	);
	const orders = workbook.getWorksheet("订单汇总")!;
	const items = workbook.getWorksheet("商品规格明细")!;
	const meta = workbook.getWorksheet("筛选与金额汇总")!;
	assert.equal(orders.rowCount, 53);
	assert.equal(items.rowCount, 53);
	assert.equal(cell(orders, 2, "原实付（分，精确文本）").value, "100");
	assert.equal(cell(orders, 2, "本次网站实付（分）").value, "0");
	assert.equal(cell(orders, 2, "原付款证据版本").value, "payment-evidence-batch");
	assert.equal(cell(orders, 2, "人工已报帐").value, "是");
	assert.equal(cell(orders, 53, "人工已报帐").value, "否");
	assert.equal(cell(orders, 53, "原实付（分，精确文本）").value, "未知");
	assert.equal(cell(orders, 53, "原实付（CNY元）").value, "未知");
	assert.equal(metric(meta, "已知原实付合计（分）"), "10000");
	assert.equal(metric(meta, "已知待报帐合计（分）"), "2500");
	assert.equal(metric(meta, "原实付未知订单数"), 1);
	assert.equal(metric(meta, "付款截止日（含）"), "2026-11-06");
	assert.equal(metric(meta, "页面允许的采购账号ID"), "A");
	assert.equal(metric(meta, "搜索"), "规格");
});

test("长订单号、SKU、精确分与外部公式形状的文本读回仍是字符串，全部未知金额单独保留", async () => {
	const rows = [record(0, "900719925474099312345"), record(1, "1"), record(26, null)];
	const result = await createExport({ snapshotAt, rows }, { search: "=1+1" });
	assert.equal(result.summary.amountMinor, "900719925474099312346");
	assert.equal(result.pendingSummary.amountMinor, null);
	const workbook = await open(result.base64);
	const orders = workbook.getWorksheet("订单汇总")!;
	const items = workbook.getWorksheet("商品规格明细")!;
	for (const [actual, expected] of [
		[cell(orders, 2, "1688采购订单号"), "3012345678901234567"],
		[cell(orders, 2, "原实付（分，精确文本）"), "900719925474099312345"],
		[cell(orders, 2, "供应商"), rows[0]!.fact.supplier],
		[cell(items, 2, "1688 SKU ID"), "0009007199254740993123"],
		[cell(items, 2, "商品名称"), "+SUM(1,2)"],
		[cell(items, 2, "规格"), "@外部规格文本"],
	] as const) {
		assert.equal(actual.value, expected);
		assert.equal(actual.type, ExcelJS.ValueType.String);
	}
	const meta = workbook.getWorksheet("筛选与金额汇总")!;
	assert.equal(metric(meta, "搜索"), "=1+1");
	assert.equal(metric(meta, "已知待报帐合计（分）"), "未知");
	assert.equal(metric(meta, "待报帐金额未知订单数"), 1);
});

test("空筛选仍导出三张表与零单汇总；拒绝越界账号和缺少付款时间的记录", async () => {
	const result = await createExport({ snapshotAt, rows: [] }, { accounts: ["A"], search: "" });
	const workbook = await open(result.base64);
	assert.equal(workbook.getWorksheet("订单汇总")!.rowCount, 1);
	assert.equal(workbook.getWorksheet("商品规格明细")!.rowCount, 1);
	assert.equal(result.summary.amountMinor, "0");
	assert.equal(result.pendingSummary.orderCount, 0);
	await assert.rejects(createExport({ snapshotAt, rows: [record(0)] }, { accounts: ["B"], search: "" }), /允许.*账号范围/);
	const missingPayment = record(0);
	missingPayment.fact.receipt.paidAt = null;
	await assert.rejects(createExport({ snapshotAt, rows: [missingPayment] }, { search: "" }), /付款时间证据/);
});

test("导出事务使用只读可重复读快照，全部匹配查询不分页，账号和上海日期边界在同一筛选中", async () => {
	const queries: { text: string; values: unknown[] }[] = [];
	const rows = Array.from({ length: 52 }, (_, index) => record(index));
	const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
		if (!("raw" in strings)) return {};
		const text = strings.join("?").trim();
		queries.push({ text, values });
		if (text.startsWith("select transaction_timestamp")) return [{ snapshotAt }];
		if (text.startsWith("select o.account_id")) return rows;
		return {};
	}) as unknown as Sql;
	let begins = 0;
	const sql = Object.assign(
		() => {
			throw new Error("快照外不能读取");
		},
		{
			begin: async (mode: string, task: (transaction: Sql) => Promise<unknown>) => {
				begins++;
				assert.equal(mode, "isolation level repeatable read read only");
				return task(tx);
			},
		},
	) as unknown as Sql;
	const result = await readExportSnapshot(sql, { accounts: ["A"], account: "A", search: "规格", paidFrom: "2026-11-01", paidTo: "2026-11-01" });
	assert.equal(begins, 1);
	assert.equal(result.rows.length, 52);
	assert.equal(result.snapshotAt, snapshotAt);
	const orderQuery = queries.find((q) => q.text.startsWith("select o.account_id"))!;
	assert.doesNotMatch(orderQuery.text, /\blimit\b|\boffset\b|\binsert\b|\bupdate\b|\bdelete\b/i);
	assert.ok(orderQuery.text.includes("reimbursement_marks"));
	const filter = queries.find((q) => q.text.startsWith("where"))!;
	assert.match(filter.text, /o\.paid_at is not null/);
	assert.ok(queries.some((q) => q.text.includes("o.account_id in")));
	assert.ok(queries.some((q) => q.text.includes("o.account_id =") && q.values.includes("A")));
	assert.ok(queries.some((q) => q.text.includes("o.paid_at >=") && q.values.includes("2026-10-31T16:00:00.000Z")));
	assert.ok(queries.some((q) => q.text.includes("o.paid_at <") && q.values.includes("2026-11-01T16:00:00.000Z")));
	assert.ok(queries.some((q) => q.values.includes("%规格%")));
	await assert.rejects(readExportSnapshot(sql, { accounts: ["A"], account: "B", search: "" }), /允许范围/);
	await assert.rejects(readExportSnapshot(sql, { search: "", paidFrom: "2026-02-30" }), /有效日历日期/);
	assert.equal(begins, 1);
});
