// 尺码图的正式本地预览入口：显式数值与单位逐行绑定当前源 SKU，不推断、不换算、不上传；审核后交 size-chart 保存。
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { inspect } from "../../connectors/services/image/api.ts";
import { page } from "../../platform/browser/browser.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { flag, parseJson } from "../../platform/tool.ts";
import { inShopQueued } from "./queue.ts";
import { ListingId, type ListingRow, type ShopSettingsRow } from "./row.ts";
import { sizeChartEditable, sizeChartScope } from "./size-chart.ts";
import { specsOf, toTw } from "./variants.ts";

const text = z.string().trim().min(1).max(240);
const number = z.number().positive().finite();
const value = z.union([number, z.tuple([number, number]).refine(([min, max]) => min <= max, "区间下限不能大于上限")]).nullable();
const column = z.object({ title: text, unit: z.enum(["cm", "mm", "市斤", "kg", "號"]) });
const chartRow = z.object({
	label: text.describe("本行供买家阅读的尺码/款式名"),
	sourceOption: text.describe("对应 sourceTier 的1688原始选项文字，逐字保留"),
	sourceSkuIds: z.array(z.string().trim().min(1)).min(1).max(50),
	values: z.array(value).min(1).max(8),
	evidence: z.string().trim().min(1).max(4000).describe("本行数值及单位的已审核源依据，含原始链接或原字段位置"),
});

export const chartTableSchema = z
	.object({
		offerId: z.string().regex(/^\d+$/),
		sourceTier: text.describe("1688的原始尺码层名，例如尺码"),
		kind: z.enum(["recommendation", "measurement", "size-label"]),
		title: text.describe("图片标题，自动转台湾繁体；不覆盖强制来源说明"),
		columns: z.array(column).min(1).max(8),
		rows: z.array(chartRow).min(1).max(50),
		note: z.string().trim().max(1000).optional().describe("原始量测方法、误差等已核说明；未提供不补"),
		evidence: z.string().trim().min(1).max(8000).describe("全表审核依据和原始来源"),
	})
	.superRefine((table, ctx) => {
		if (table.kind === "size-label" && (table.columns.length !== 1 || table.columns[0]!.unit !== "號"))
			ctx.addIssue({ code: "custom", path: ["columns"], message: "size-label只列一栏供货商标示鞋码，单位须为號，不补量测或体重" });
		for (const [index, row] of table.rows.entries()) {
			if (row.values.length !== table.columns.length) ctx.addIssue({ code: "custom", path: ["rows", index, "values"], message: "每行数值数须与列数一致" });
			if (row.values.every((v) => v === null)) ctx.addIssue({ code: "custom", path: ["rows", index], message: "每行至少一项真实有单位数值，不能只放尺码占位" });
		}
		for (const [index, col] of table.columns.entries()) {
			if (table.kind !== "size-label" && col.unit === "號")
				ctx.addIssue({ code: "custom", path: ["columns", index], message: "號仅用于size-label标示鞋码，不能冒充量测或建议数值" });
			if (table.rows.every((row) => row.values[index] == null))
				ctx.addIssue({ code: "custom", path: ["columns", index], message: "整列缺少数值，不生成占位列" });
			if (table.kind === "measurement" && (col.unit === "市斤" || col.unit === "kg"))
				ctx.addIssue({ code: "custom", path: ["columns", index], message: "体重单位须使用recommendation，不能冒充成衣平量" });
		}
	});
export type ChartTable = z.output<typeof chartTableSchema>;

const origin = z
	.url()
	.refine((value) => {
		const u = new URL(value);
		return (
			["http:", "https:"].includes(u.protocol) &&
			["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) &&
			!u.username &&
			!u.password &&
			u.pathname === "/" &&
			!u.search &&
			!u.hash
		);
	}, "渲染页须为X2本地loopback origin，不使用外部站点或用户标签页")
	.transform((value) => new URL(value).origin);
export const chartRenderParams = z.object({
	id: ListingId,
	table: z.preprocess(parseJson, chartTableSchema).describe("已审核的列、单位、逐行源SKU和原始数值JSON；写 - 从stdin读"),
	origin: origin.default("http://127.0.0.1:5170").describe("已运行的X2本地网页origin，仅用X2自有标签页的离屏Canvas"),
	replace: flag("已保存尺码图时仅允许显式准备替换预览；本工具不覆盖保存图").default(false),
});
type Input = z.output<typeof chartRenderParams>;
type ScopeRow = Pick<ListingRow, "shop" | "offer_id" | "offer" | "variants">;

/** 只读取源选项开头的标示码；括号或「适合」之后的建议、内长不拿来换算标示鞋码。 */
function markedShoeSize(source: string): number | [number, number] | null {
	const match = /^\s*(?:鞋底\s*)?(\d+(?:\.\d+)?)(?:\s*[-/–—~～]\s*(\d+(?:\.\d+)?))?(?:\s*[碼码號号])?(?=\s*(?:$|[【（[(]|适合|適合|建议|建議))/.exec(source);
	if (!match) return null;
	return match[2] === undefined ? Number(match[1]) : [Number(match[1]), Number(match[2])];
}

/** 先核对全量覆盖、原始尺码与源SKU，再产可读表；价格、译名不参与绑定，不修改输入。 */
export function chartPlan(row: ScopeRow, input: ChartTable) {
	const table = chartTableSchema.parse(input);
	if (table.offerId !== row.offer_id) throw new Usage("尺码图的货源与商品稿不一致");
	const scope = sizeChartScope(row),
		specs = specsOf(row.variants)!;
	const tier = row.offer!.props.findIndex((p) => p.name === table.sourceTier);
	if (tier < 0) throw new Usage(`货源没有原始规格层 ${table.sourceTier}`);
	const selected = new Map(specs.variants.map((v) => [v.skuId as string, v]));
	const bound = new Set<string>(),
		labels = new Set<string>();
	const bindings = table.rows.flatMap((r) => {
		const label = toTw(r.label);
		if (labels.has(label)) throw new Usage(`尺码图行名重复：${label}；分款式数值须明确区分`);
		labels.add(label);
		if (table.kind === "size-label") {
			const marked = markedShoeSize(r.sourceOption);
			if (marked === null || JSON.stringify(r.values[0]) !== JSON.stringify(marked))
				throw new Usage(`标示鞋码须与原始SKU开头数值完全一致，不换算脚长或取括号内建议：${r.sourceOption}`);
		}
		return r.sourceSkuIds.map((id) => {
			if (!selected.has(id)) throw new Usage(`尺码图包含未选源 SKU ${id}`);
			if (bound.has(id)) throw new Usage(`尺码图重复绑定源 SKU ${id}`);
			const source = row.offer!.skus.find((s) => s.skuId === id)!;
			if (source.specId !== selected.get(id)!.specId) throw new Usage(`源 SKU ${id} 的规格编号已变化，请重做商品稿`);
			if (source.attrs[tier] !== r.sourceOption) throw new Usage(`源 SKU ${id} 的原始尺码不符：${r.sourceOption}`);
			bound.add(id);
			return { skuId: id, specId: source.specId, sourceName: source.name, sourceAttrs: source.attrs, label, sourceOption: r.sourceOption };
		});
	});
	const missing = [...selected.keys()].filter((id) => !bound.has(id));
	if (missing.length) throw new Usage(`尺码图未覆盖已选源 SKU：${missing.join("、")}`);
	const format = (v: z.output<typeof value>) => (v === null ? "未提供" : Array.isArray(v) ? `${v[0]}–${v[1]}` : String(v));
	return {
		table,
		scope,
		bindings,
		title: toTw(table.title),
		subtitle:
			table.kind === "size-label"
				? "供貨商標示鞋碼，非腳長或鞋內長量測"
				: table.kind === "recommendation"
					? "供貨商建議，非成衣平量"
					: "供貨商成衣量測資料，非本店實測",
		headers: ["尺碼／款式", ...table.columns.map((c) => `${toTw(c.title)}\n${c.unit}`)],
		rows: table.rows.map((r) => [toTw(r.label), ...r.values.map(format)]),
		notes: [
			...(table.columns.some((c) => c.unit === "市斤") ? ["體重單位：中國市斤（1市斤＝0.5公斤，非台斤）。"] : []),
			...(table.note ? [toTw(table.note)] : []),
			table.kind === "size-label"
				? "僅列供貨商原始標示鞋碼，未換算腳長、公分或其他尺碼系統；選碼時請參照商品頁說明。"
				: table.kind === "recommendation"
					? "體重僅供選碼參考，請綜合身形及穿著偏好選擇。"
					: "請與平常穿著合適的衣物尺寸比對。",
		],
	};
}
type Plan = ReturnType<typeof chartPlan>;

/** 不插入DOM、不取外站图；函数自给自足，交给X2拥有的本地页执行。 */
export function chartCanvas(plan: Pick<Plan, "title" | "subtitle" | "headers" | "rows" | "notes">): string {
	const canvas = document.createElement("canvas"),
		ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("本地浏览器无法创建Canvas");
	const width = 1400,
		pad = 56,
		font = 29,
		line = 42,
		first = 300;
	const cellWidth = (width - pad * 2 - first) / (plan.headers.length - 1);
	const widths = [first, ...plan.headers.slice(1).map(() => cellWidth)];
	const fontOf = (size: number, bold = false) => `${bold ? "600 " : ""}${size}px "PingFang TC", "Microsoft JhengHei", sans-serif`;
	ctx.font = fontOf(font);
	const wrap = (text: string, max: number) => {
		const lines: string[] = [];
		let current = "";
		for (const char of text) {
			if (char === "\n" || (current && ctx.measureText(current + char).width > max)) {
				lines.push(current);
				current = char === "\n" ? "" : char;
			} else current += char;
		}
		if (current) lines.push(current);
		return lines.length ? lines : [""];
	};
	const wrapped = [plan.headers, ...plan.rows].map((r, index) => {
		ctx.font = fontOf(font, index === 0);
		return r.map((cell, i) => wrap(cell, widths[i]! - 32));
	});
	const heights = wrapped.map((r) => Math.max(...r.map((cell) => cell.length)) * line + 36);
	ctx.font = fontOf(font);
	const notes = plan.notes.flatMap((note) => wrap(note, width - 2 * pad));
	ctx.font = fontOf(font + 6, true);
	const title = wrap(plan.title, width - 2 * pad);
	const top = 112 + title.length * line + 76;
	const height = Math.max(600, top + heights.reduce((sum, h) => sum + h, 0) + 56 + notes.length * line + pad);
	if (width * height > 40_000_000) throw new Error("尺码图过大，请拆分清晰的源规格行");
	canvas.width = width;
	canvas.height = height;
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, width, height);
	ctx.textBaseline = "top";
	ctx.textAlign = "left";
	ctx.font = fontOf(font + 6, true);
	ctx.fillStyle = "#16211c";
	title.forEach((s, i) => {
		ctx.fillText(s, pad, pad + i * line);
	});
	ctx.font = fontOf(font);
	ctx.fillStyle = "#43584b";
	ctx.fillText(plan.subtitle, pad, pad + title.length * line + 24);
	let y = top;
	for (const [ri, row] of wrapped.entries()) {
		const h = heights[ri]!;
		ctx.fillStyle = ri === 0 ? "#e8efe9" : ri % 2 === 0 ? "#f6f8f6" : "#ffffff";
		ctx.fillRect(pad, y, width - 2 * pad, h);
		ctx.font = fontOf(font, ri === 0);
		ctx.fillStyle = "#16211c";
		let x = pad;
		for (const [ci, cell] of row.entries()) {
			cell.forEach((s, li) => {
				ctx.fillText(s, x + 16, y + 18 + li * line);
			});
			x += widths[ci]!;
		}
		y += h;
		ctx.strokeStyle = "#d9e1db";
		ctx.beginPath();
		ctx.moveTo(pad, y);
		ctx.lineTo(width - pad, y);
		ctx.stroke();
	}
	ctx.font = fontOf(font - 3);
	ctx.fillStyle = "#43584b";
	notes.forEach((s, i) => {
		ctx.fillText(s, pad, y + 40 + i * line);
	});
	return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
}

export async function renderListingChart(sql: Sql, p: Input) {
	const [row] = await sql<ListingRow[]>`select * from listings where id = ${p.id}`;
	if (!row) throw new Usage(`没有商品稿 ${p.id}`);
	sizeChartEditable(row, p.replace);
	const plan = chartPlan(row, p.table),
		before = JSON.stringify([plan.scope, row.size_chart ?? null]);
	const [shop] = await sql<Pick<ShopSettingsRow, "shop_id">[]>`select shop_id from shop_settings where shop = ${row.shop}`;
	if (!shop) throw new Usage(`没有店铺设置 ${row.shop}`);
	const base64 = await inShopQueued(shop.shop_id, async () => (await page(p.origin)).run(chartCanvas, plan));
	const image = inspect(new Uint8Array(Buffer.from(base64, "base64")), "X2尺码图预览");
	if (image.mime !== "image/png" || !image.width || !image.height) throw new Error("尺码图预览没有生成有效PNG");
	const [fresh] = await sql<ListingRow[]>`select * from listings where id = ${p.id}`;
	if (!fresh) throw new Usage(`商品稿 ${p.id} 已不存在`);
	sizeChartEditable(fresh, p.replace);
	if (JSON.stringify([sizeChartScope(fresh), fresh.size_chart ?? null]) !== before) throw new Usage("渲染期间源规格或人工尺码图已变化，请重新核对生成");
	const dir = await mkdtemp(join(tmpdir(), "x2-size-chart-")),
		file = join(dir, `listing-${p.id}.png`),
		evidenceFile = join(dir, "evidence.json");
	const evidence = {
		version: 1,
		id: p.id,
		shop: row.shop,
		offerId: row.offer_id,
		itemUrl: row.offer!.url,
		scope: plan.scope,
		at: new Date().toISOString(),
		table: plan.table,
		bindings: plan.bindings,
		image: { source: file, sha256: image.sha256, width: image.width, height: image.height },
		inputSha256: createHash("sha256").update(JSON.stringify(plan.table)).digest("hex"),
	};
	await writeFile(file, image.bytes);
	await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
	return {
		id: p.id,
		shop: row.shop,
		offerId: row.offer_id,
		file,
		evidenceFile,
		scope: plan.scope,
		sha256: image.sha256,
		width: image.width,
		height: image.height,
		selectedSourceSkuCount: plan.bindings.length,
		uploaded: false,
		saved: false,
		next: { tool: "listing.size-chart", params: { id: p.id, source: file, evidence: JSON.stringify(evidence), expectedScope: plan.scope, replace: p.replace } },
	};
}
