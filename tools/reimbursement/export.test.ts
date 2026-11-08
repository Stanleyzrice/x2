// 用内存采购事实生成并读回真实工作簿，核对完整匹配、精确金额、文本ID、公式隔离及导出事务的账号边界，不连接数据库或外站。
import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS, { type Worksheet } from "exceljs";
import type { Sql } from "../../platform/db/index.ts";
import { createExport, type ExportRow, readExportSnapshot } from "./export.ts";
import { xlsxBuffer } from "./xlsx.ts";

const snapshotAt = new Date("2026-11-06T07:08:09.000Z");
const testPng = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM3sAAAAASUVORK5CYII=", "base64"));
const createTestExport = (snapshot: Parameters<typeof createExport>[0], query: Parameters<typeof createExport>[1]) =>
	createExport(snapshot, query, async () => testPng);
const record = (index: number, originalMinor: string | null = "100"): ExportRow => ({
	account: "A",
	accountName: "采购账号A",
	capturedAt: new Date("2026-11-06T00:00:00.000Z"),
	revision: "current-batch",
	absentFromLatest: false,
	reported: false,
	reportRevision: 0,
	reportedAt: null,
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

const headers = ["订单截图", "总价", "产品成本单价", "购买数量（精确到单个）", "实际付款", "订单号", "报账金额总计"];

test("52单中仅导出26个未报帐订单及图片，原实付金额未知不当零，不改报帐标记", async () => {
	const rows = Array.from({ length: 52 }, (_, index) => {
		const row = record(index, index === 51 ? null : index === 50 ? "5000" : "100");
		row.reported = index < 25 || index === 50;
		row.reportRevision = row.reported ? 3 : 0;
		row.reportedAt = row.reported ? new Date("2026-11-05T00:00:00.000Z") : null;
		row.fact.items[0]!.image = `https://example.com/item-${index}.png`;
		return row;
	});
	const originalRows = structuredClone(rows);
	const pending = rows.filter((row) => !row.reported);
	const calls: string[] = [];
	const result = await createExport(
		{ snapshotAt, rows },
		{ accounts: ["A"], account: "A", search: "规格", paidFrom: "2026-11-01", paidTo: "2026-11-06" },
		async (url) => {
			calls.push(url);
			return testPng;
		},
	);
	assert.equal(result.orderCount, 26);
	assert.equal(result.itemCount, 26);
	assert.equal(result.summary.amountMinor, "2500");
	assert.equal(result.summary.missingCount, 1);
	assert.equal(result.pendingSummary.amountMinor, "2500");
	assert.equal(result.pendingSummary.orderCount, 26);
	assert.equal(result.pendingSummary.missingCount, 1);
	assert.deepEqual(result.summary, result.pendingSummary);
	assert.deepEqual(rows, originalRows);
	assert.equal(calls.length, 26);
	assert.deepEqual(new Set(calls), new Set(pending.map((row) => row.fact.items[0]!.image)));
	assert.equal(result.snapshotAt, snapshotAt.toISOString());
	assert.match(result.filename, /20261106150809\.xlsx$/);
	assert.equal(result.mime, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
	const workbook = await open(result.base64);
	assert.deepEqual(
		workbook.worksheets.map((sheet) => sheet.name),
		["采购报账"],
	);
	const sheet = workbook.getWorksheet("采购报账")!;
	assert.equal(sheet.columnCount, 7);
	assert.deepEqual(
		headers.map((_, index) => sheet.getCell(1, index + 1).value),
		headers,
	);
	assert.equal(sheet.rowCount, 27);
	assert.equal(cell(sheet, 2, "总价").value, "¥1.00");
	assert.equal(cell(sheet, 2, "实际付款").value, "¥1.00");
	assert.equal(cell(sheet, 2, "产品成本单价").value, "¥8.10");
	assert.equal(cell(sheet, 2, "购买数量（精确到单个）").value, "3");
	assert.equal(cell(sheet, 27, "实际付款").value, "未知");
	assert.equal(cell(sheet, 2, "报账金额总计").value, "金额不全（缺1单；已知合计¥25.00）");
	const images = sheet.getImages();
	assert.equal(images.length, 26);
	for (const [index, row] of pending.entries()) {
		assert.equal(cell(sheet, index + 2, "订单号").value, row.fact.orderId);
		assert.ok([null, ""].includes(cell(sheet, index + 2, "订单截图").value as string | null));
		assert.equal(images[index]!.range.tl.nativeRow, index + 1);
		assert.equal(images[index]!.range.tl.nativeCol, 0);
		if (index > 0) assert.ok([null, ""].includes(cell(sheet, index + 2, "报账金额总计").value as string | null));
	}
});

test("长订单号、金额与公式形状订单号读回仍是精确文本，未知金额单独保留", async () => {
	const rows = [record(0, "900719925474099312345"), record(1, "1"), record(26, null)];
	rows[2]!.fact.orderId = '=HYPERLINK("https://example.com","外部文本")';
	rows[0]!.fact.goodsMinor = "900719925474099312345";
	const result = await createTestExport({ snapshotAt, rows }, { search: "=1+1" });
	assert.equal(result.summary.amountMinor, "900719925474099312346");
	assert.equal(result.pendingSummary.amountMinor, "900719925474099312346");
	const workbook = await open(result.base64);
	const sheet = workbook.getWorksheet("采购报账")!;
	for (const [actual, expected] of [
		[cell(sheet, 2, "订单号"), "3012345678901234567"],
		[cell(sheet, 2, "总价"), "¥9,007,199,254,740,993,123.45"],
		[cell(sheet, 2, "实际付款"), "¥9,007,199,254,740,993,123.45"],
		[cell(sheet, 2, "报账金额总计"), "金额不全（缺1单；已知合计¥9,007,199,254,740,993,123.46）"],
		[cell(sheet, 3, "实际付款"), "¥0.01"],
		[cell(sheet, 4, "订单号"), rows[2]!.fact.orderId],
	] as const) {
		assert.equal(actual.value, expected);
		assert.equal(actual.type, ExcelJS.ValueType.String);
	}
	assert.equal(cell(sheet, 4, "实际付款").value, "未知");
	assert.equal(result.pendingSummary.missingCount, 1);
	const allUnknown = await createTestExport({ snapshotAt, rows: [record(0, null)] }, { search: "" });
	const unknownSheet = (await open(allUnknown.base64)).getWorksheet("采购报账")!;
	assert.equal(cell(unknownSheet, 2, "报账金额总计").value, "金额不全（缺1单）");
});

test("空筛选或全部已报帐仅保留空模板且不读取图片；拒绝越界账号和缺少付款时间的记录", async () => {
	const marked = [record(0), record(1)];
	for (const row of marked) row.reported = true;
	for (const rows of [[], marked]) {
		const calls: string[] = [];
		const result = await createExport({ snapshotAt, rows }, { accounts: ["A"], search: "" }, async (url) => {
			calls.push(url);
			return testPng;
		});
		const workbook = await open(result.base64);
		assert.equal(workbook.worksheets.length, 1);
		const sheet = workbook.getWorksheet("采购报账")!;
		assert.equal(sheet.rowCount, 2);
		assert.equal(sheet.columnCount, 7);
		assert.equal(sheet.getImages().length, 0);
		for (const header of headers.slice(0, 6)) assert.ok([null, ""].includes(cell(sheet, 2, header).value as string | null));
		assert.equal(cell(sheet, 2, "报账金额总计").value, "¥0.00");
		assert.equal(result.orderCount, 0);
		assert.equal(result.itemCount, 0);
		assert.equal(result.summary.amountMinor, "0");
		assert.equal(result.pendingSummary.orderCount, 0);
		assert.equal(result.pendingSummary.amountMinor, "0");
		assert.deepEqual(calls, []);
	}
	assert.ok(marked.every((row) => row.reported));
	await assert.rejects(createTestExport({ snapshotAt, rows: [record(0)] }, { accounts: ["B"], search: "" }), /允许.*账号范围/);
	const missingPayment = record(0);
	missingPayment.fact.receipt.paidAt = null;
	await assert.rejects(createTestExport({ snapshotAt, rows: [missingPayment] }, { search: "" }), /付款时间证据/);
});

test("多规格逐行保留单价与数量但整单总价只写一次，无明细订单也不遗漏", async () => {
	const multiple = record(0, "2560");
	multiple.fact.goodsMinor = "2400";
	multiple.fact.items.push({ ...multiple.fact.items[0]!, lineId: "second-line", quantity: "2.5", unitPriceMinor: null });
	const noItems = record(1, "1234");
	noItems.fact.goodsMinor = "1200";
	noItems.fact.items = [];
	const result = await createTestExport({ snapshotAt, rows: [multiple, noItems] }, { search: "" });
	assert.equal(result.orderCount, 2);
	assert.equal(result.itemCount, 2);
	assert.equal(result.summary.amountMinor, "3794");
	const sheet = (await open(result.base64)).getWorksheet("采购报账")!;
	assert.equal(sheet.rowCount, 4);
	assert.equal(cell(sheet, 2, "总价").value, "¥24.00");
	assert.equal(cell(sheet, 2, "实际付款").value, "¥25.60");
	assert.equal(cell(sheet, 2, "报账金额总计").value, "¥37.94");
	assert.ok([null, ""].includes(cell(sheet, 3, "总价").value as string | null));
	assert.ok([null, ""].includes(cell(sheet, 3, "实际付款").value as string | null));
	assert.ok([null, ""].includes(cell(sheet, 3, "报账金额总计").value as string | null));
	assert.ok([null, ""].includes(cell(sheet, 4, "报账金额总计").value as string | null));
	assert.equal(cell(sheet, 2, "订单号").value, multiple.fact.orderId);
	assert.equal(cell(sheet, 3, "订单号").value, multiple.fact.orderId);
	assert.equal(cell(sheet, 2, "产品成本单价").value, "¥8.10");
	assert.equal(cell(sheet, 2, "购买数量（精确到单个）").value, "3");
	assert.equal(cell(sheet, 3, "产品成本单价").value, "未知");
	assert.equal(cell(sheet, 3, "购买数量（精确到单个）").value, "2.5");
	assert.equal(cell(sheet, 4, "总价").value, "¥12.00");
	assert.equal(cell(sheet, 4, "实际付款").value, "¥12.34");
	assert.equal(cell(sheet, 4, "订单号").value, noItems.fact.orderId);
	assert.equal(cell(sheet, 4, "产品成本单价").value, "未知");
	assert.equal(cell(sheet, 4, "购买数量（精确到单个）").value, "未知");
	assert.equal(sheet.getImages().length, 2);
});

test("商品图片读取失败保留失败标记，金额和订单信息仍完整", async () => {
	const row = record(0, "3567");
	row.fact.goodsMinor = "3300";
	const result = await createExport({ snapshotAt, rows: [row] }, { search: "" }, async () => {
		throw new Error("模拟图片读取失败");
	});
	const sheet = (await open(result.base64)).getWorksheet("采购报账")!;
	assert.equal(sheet.getImages().length, 0);
	assert.match(String(cell(sheet, 2, "订单截图").value), /图片.*(?:失败|不可用)/);
	assert.equal(cell(sheet, 2, "总价").value, "¥33.00");
	assert.equal(cell(sheet, 2, "实际付款").value, "¥35.67");
	assert.equal(cell(sheet, 2, "报账金额总计").value, "¥35.67");
	assert.equal(cell(sheet, 2, "产品成本单价").value, "¥8.10");
	assert.equal(cell(sheet, 2, "购买数量（精确到单个）").value, "3");
	assert.equal(cell(sheet, 2, "订单号").value, row.fact.orderId);
	assert.equal(result.summary.amountMinor, "3567");
});

test("相同图片URL只读取一次，仍嵌入每个指定单元格", async () => {
	const calls: string[] = [];
	const url = "https://example.com/shared.png";
	const bytes = await xlsxBuffer(
		[
			{
				name: "图片",
				columns: [{ header: "订单截图", width: 38 }],
				rows: [[""], [""]],
				images: [
					{ row: 2, column: 1, url },
					{ row: 3, column: 1, url },
				],
			},
		],
		snapshotAt,
		async (imageUrl) => {
			calls.push(imageUrl);
			return testPng;
		},
	);
	assert.deepEqual(calls, [url]);
	const images = (await open(bytes.toString("base64"))).getWorksheet("图片")!.getImages();
	assert.equal(images.length, 2);
	assert.deepEqual(
		images.map((image) => [image.range.tl.nativeRow, image.range.tl.nativeCol]),
		[
			[1, 0],
			[2, 0],
		],
	);
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
	assert.match(orderQuery.text, /and\s+coalesce\(m\.reported,\s*false\)\s*=\s*false/i);
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
