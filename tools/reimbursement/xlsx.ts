import { readImageBytes } from "../../connectors/services/image/api.ts";

export type Sheet = {
	name: string;
	columns: { header: string; width: number }[];
	rows: (string | number)[][];
	images?: { row: number; column: number; url: string }[];
};
export type ImageReader = (url: string) => Promise<Uint8Array>;
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
type Picture = { buffer: Buffer; extension: "png" | "jpeg" | "gif"; width: number; height: number };

function pictureOf(bytes: Uint8Array): Picture {
	const buffer = Buffer.from(bytes);
	if (buffer.length > MAX_IMAGE_BYTES) throw new Error("商品图片过大");
	const picture = (extension: Picture["extension"], width: number, height: number) => {
		if (!width || !height) throw new Error("商品图片尺寸无效");
		return { buffer, extension, width, height };
	};
	if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && buffer.toString("ascii", 12, 16) === "IHDR")
		return picture("png", buffer.readUInt32BE(16), buffer.readUInt32BE(20));
	if (buffer.length >= 10 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6)))
		return picture("gif", buffer.readUInt16LE(6), buffer.readUInt16LE(8));
	if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
		let offset = 2;
		while (offset + 4 <= buffer.length && buffer[offset] === 0xff) {
			const marker = buffer[offset + 1]!;
			if (marker === 0xff) {
				offset++;
				continue;
			}
			offset += 2;
			if (marker === 0xda || marker === 0xd9) break;
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
			const length = buffer.readUInt16BE(offset);
			if (length < 2 || offset + length > buffer.length) break;
			if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7)
				return picture("jpeg", buffer.readUInt16BE(offset + 5), buffer.readUInt16BE(offset + 3));
			offset += length;
		}
	}
	throw new Error("商品图片格式不支持");
}

async function readPictures(sheets: Sheet[], readImage: ImageReader): Promise<Map<string, Picture | null>> {
	const urls = [...new Set(sheets.flatMap((sheet) => sheet.images?.map((image) => image.url) ?? []))];
	const pictures = new Map<string, Picture | null>();
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(4, urls.length) }, async () => {
			while (next < urls.length) {
				const url = urls[next++]!;
				try {
					pictures.set(url, pictureOf(await readImage(url)));
				} catch {
					pictures.set(url, null);
				}
			}
		}),
	);
	return pictures;
}

export async function xlsxBuffer(sheets: Sheet[], capturedAt: Date, readImage: ImageReader = (url) => readImageBytes(url, MAX_IMAGE_BYTES)): Promise<Buffer> {
	const { default: ExcelJS } = await import("exceljs");
	const workbook = new ExcelJS.Workbook();
	const pictures = await readPictures(sheets, readImage);
	const imageIds = new Map<string, number>();
	workbook.creator = "x2";
	workbook.created = capturedAt;
	workbook.modified = capturedAt;
	for (const data of sheets) {
		if (data.rows.length > 1_048_575) throw new Error("导出超过 Excel 单表行数上限，请缩小日期或账号范围后重试");
		const sheet = workbook.addWorksheet(data.name, { views: [{ state: "frozen", ySplit: 1 }] });
		sheet.columns = data.columns.map((column) => ({ ...column, style: { numFmt: "@", alignment: { vertical: "middle", wrapText: true } } }));
		sheet.addRows(data.rows.length ? data.rows : [data.columns.map(() => "")]);
		sheet.eachRow({ includeEmpty: true }, (row) => {
			row.height = 84;
			for (let column = 1; column <= data.columns.length; column++) {
				row.getCell(column).border = {
					top: { style: "thin", color: { argb: "FFD0D0D0" } },
					left: { style: "thin", color: { argb: "FFD0D0D0" } },
					bottom: { style: "thin", color: { argb: "FFD0D0D0" } },
					right: { style: "thin", color: { argb: "FFD0D0D0" } },
				};
			}
		});
		const header = sheet.getRow(1);
		header.font = { bold: true, color: { argb: "FF000000" } };
		header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFA6A6A6" } };
		header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
		header.height = 40;
		for (const image of data.images ?? []) {
			if (
				!Number.isInteger(image.row) ||
				image.row < 2 ||
				image.row > sheet.rowCount ||
				!Number.isInteger(image.column) ||
				image.column < 1 ||
				image.column > data.columns.length
			)
				throw new Error("商品图片超出表格范围");
			const picture = pictures.get(image.url);
			if (!picture) {
				sheet.getCell(image.row, image.column).value = "图片暂不可用";
				continue;
			}
			let id = imageIds.get(image.url);
			if (id === undefined) {
				id = workbook.addImage({ base64: picture.buffer.toString("base64"), extension: picture.extension });
				imageIds.set(image.url, id);
			}
			const cellWidth = data.columns[image.column - 1]!.width * 7 + 5;
			const cellHeight = sheet.getRow(image.row).height! * (4 / 3);
			const scale = Math.min((cellWidth - 8) / picture.width, (cellHeight - 8) / picture.height);
			const width = picture.width * scale;
			const height = picture.height * scale;
			const anchor = {
				col: image.column - 1,
				row: image.row - 1,
				nativeCol: image.column - 1,
				nativeRow: image.row - 1,
				nativeColOff: Math.round(((cellWidth - width) / 2) * 9525),
				nativeRowOff: Math.round(((cellHeight - height) / 2) * 9525),
			};
			sheet.addImage(id, { tl: anchor, ext: { width, height }, editAs: "oneCell" });
		}
	}
	return Buffer.from(await workbook.xlsx.writeBuffer());
}
