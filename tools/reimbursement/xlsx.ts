// 工作簿只写字符串和普通数字：订单号、金额文本及外部商品名称不转换成公式或可执行链接。
export type Sheet = { name: string; columns: { header: string; width: number }[]; rows: (string | number)[][] };
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function xlsxBuffer(sheets: Sheet[], capturedAt: Date): Promise<Buffer> {
	const { default: ExcelJS } = await import("exceljs");
	const workbook = new ExcelJS.Workbook();
	workbook.creator = "x2";
	workbook.created = capturedAt;
	workbook.modified = capturedAt;
	for (const data of sheets) {
		if (data.rows.length > 1_048_575) throw new Error("导出超过 Excel 单表行数上限，请缩小日期或账号范围后重试");
		const sheet = workbook.addWorksheet(data.name, { views: [{ state: "frozen", ySplit: 1 }] });
		sheet.columns = data.columns.map((column) => ({ ...column, style: { numFmt: "@", alignment: { vertical: "top", wrapText: true } } }));
		sheet.addRows(data.rows);
		sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: sheet.rowCount, column: data.columns.length } };
		const header = sheet.getRow(1);
		header.font = { bold: true, color: { argb: "FFFFFFFF" } };
		header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF243B53" } };
		header.height = 32;
	}
	return Buffer.from(await workbook.xlsx.writeBuffer());
}
