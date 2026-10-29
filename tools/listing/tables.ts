// 上品给网页的表：商品稿（审稿、删图、添加货源）、店铺设置。人能改的只有人定的那几格；改完马上重算当前步骤
import { IMAGE } from "../../connectors/sites/shopee/seller.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import type { Grid, Key, Pic, Row, Table } from "../../platform/web/tables.ts";
import { LISTING_STEPS } from "./check.ts";
import { addListings } from "./pick.ts";
import { LABEL, numbered, usedPics } from "./product.ts";
import { listingsCheck } from "./status.ts";
import { isSingle, removedOf, type SpecsTable, specsOf, specsTable } from "./variants.ts";

function picsOf(l: Row): Pic[] {
	if (!l.images?.main) return [];
	const removed = new Set<string>(l.removed_images ?? []);
	const out: Pic[] = [];
	for (const role of ["main", "detail"] as const) {
		const used = new Set(usedPics(l.images, role, removed).map(({ pic }) => pic.imageId));
		for (const { pic, n } of numbered(l.images, role)) {
			const id = pic.imageId!;
			const state = removed.has(id) ? "removed" : pic.drop ? "dropped" : used.has(id) ? "used" : "extra";
			out.push({ id, url: `${IMAGE}${id}`, label: `${LABEL[role]} ${n}`, role, state, ...(pic.drop ? { why: pic.drop } : {}) });
		}
	}
	const specs = specsOf(l.variants);
	const option = new Map(((l.images.options ?? []) as any[]).filter((p) => !p.drop && p.imageId).map((p) => [p.from as string, p.imageId as string]));
	if (specs && !isSingle(specs))
		for (const o of specs.tiers[0]!.options) {
			const id = o.image ? option.get(o.image) : undefined;
			if (id) out.push({ id, url: `${IMAGE}${id}`, label: `规格图：${o.name}`, role: "option", state: "used" });
		}
	return out;
}

async function setPic(sql: Sql, key: Key, value: unknown): Promise<void> {
	const v = value as { id?: unknown; removed?: unknown };
	if (typeof v?.id !== "string" || typeof v.removed !== "boolean") throw new Usage("图：要 { id, removed }");
	const [l] = await sql`select images, variants, removed_images from listings where id = ${key.id!}`;
	if (!l) throw new Usage(`没有商品稿 ${key.id}`);
	if (!picsOf(l).some((p) => p.id === v.id && p.role !== "option")) throw new Usage(`商品稿 ${key.id} 的主图、详情图里没有这张图`);
	const removed = new Set<string>(l.removed_images ?? []);
	if (v.removed) removed.add(v.id);
	else removed.delete(v.id);
	await sql`update listings set removed_images = ${sql.json([...removed])}, updated_at = now() where id = ${key.id!}`;
}

type SpecRow = SpecsTable["rows"][number];
const price = (p: number | null) => (p === null ? "未定价" : `NT$${p}`);
const FIELDS: { label: string; of: (r: SpecRow) => string }[] = [
	{ label: "售价", of: (r) => price(r.priceTwd) },
	{ label: "进价", of: (r) => `¥${r.costRmb}` },
	{ label: "库存", of: (r) => String(r.stock) },
	{ label: "重量", of: (r) => (r.weightKg === null ? "缺重量" : `${r.weightKg} kg`) },
];

/** 规格和价格给网页的小表格：每层一列；售价、进价、库存、重量都一样的写在表上面，不一样的才成列 */
export function specsGrid({ tiers, rows, removed }: SpecsTable): Grid {
	const same = FIELDS.filter((f) => new Set(rows.map(f.of)).size <= 1);
	const varying = FIELDS.filter((f) => !same.includes(f));
	const prices = [...new Set(rows.map((r) => r.priceTwd))].filter((p) => p !== null) as number[];
	const range = prices.length ? (prices.length === 1 ? price(prices[0]!) : `${price(Math.min(...prices))}–${Math.max(...prices)}`) : "未定价";
	return {
		summary: `${rows.length > 1 || tiers.length ? `${rows.length} 个规格 · ` : ""}${range}`,
		caption: [`${rows.length} 个规格`, ...same.map((f) => `${f.label}${rows.length > 1 ? "都是" : ""} ${rows[0] ? f.of(rows[0]) : "—"}`)].join(" · "),
		columns: tiers.length ? [...tiers.map((label) => ({ label })), ...varying.map((f) => ({ label: f.label, numeric: true }))] : [],
		rows: rows.map((r) => ({ key: r.sku, image: r.image, cells: [...r.options, ...varying.map((f) => f.of(r))] })),
		note: removed.length ? `已移除：${removed.map((x) => `${x.name}（${x.count} 个规格）`).join("、")}` : null,
	};
}

function specsRows(l: Row): Grid | null {
	const s = specsOf(l.variants);
	if (!s) return null;
	const shopee = new Map(((l.images?.options ?? []) as any[]).filter((p) => p.imageId).map((p) => [p.from as string, `${IMAGE}${p.imageId}`]));
	return specsGrid(specsTable(s, removedOf(l.offer, l.removed_variants), (from) => shopee.get(from) ?? from));
}

const shops = async (sql: Sql) => (await sql`select shop from shop_settings order by shop`).map((r) => r.shop as string);

export const LISTING_TABLES: Table[] = [
	{
		name: "listings",
		title: "商品稿",
		key: ["id"],
		columns: {
			nickname: "简称",
			step: "当前步骤",
			step_detail: "说明",
			note: "备注",
			shop: "店铺",
			pics: "图",
			specs: "规格和价格",
			title: "标题",
			description: "描述",
			category_name: "类目",
			attributes_text: "属性",
			problems: "待补充",
			weight_kg: "重量（kg，1688 没给时用）",
			freight_rmb: "国内运费（元/件，读不到时用）",
			days_to_ship: "备货天数",
			cancelled: "放弃",
			strategy: "策略",
			pick_why: "选品理由",
			pick_evidence: "依据",
			offer_id: "货源",
			product_id: "Shopee 商品 id",
			listed_at: "上架时间",
			id: "编号",
		},
		computed: { pics: { type: "pics", of: picsOf }, specs: { type: "grid", of: specsRows } },
		edit: {
			nickname: {},
			note: {},
			title: {},
			description: {},
			weight_kg: {},
			freight_rmb: {},
			cancelled: { when: "product_id is null and listed_at is null" },
			pics: { set: setPic },
		},
		recheck: (sql, key) => listingsCheck(sql, [key.id!]),
		views: [
			{ title: "审稿", where: "step in ('待批准', '待补充')", order: "id", cards: true, empty: "没有等你看的商品稿" },
			{ title: "全部", order: "id", group: { col: "step", values: LISTING_STEPS } },
		],
		form: {
			title: "添加货源",
			fields: { shop: "上品的店铺", offer_id: "1688 商品链接（完整粘贴）", pick_why: "为什么选它（可以不写）" },
			required: ["shop", "offer_id"],
			options: { shop: shops },
			insert: async (sql, v) => (await addListings(sql, { shop: v.shop!, links: [v.offer_id!], why: v.pick_why || undefined })).added[0]!.id,
		},
	},
	{
		name: "shop_settings",
		title: "店铺设置",
		key: ["shop"],
		columns: {
			shop: "店铺",
			paused: "暂停上品原因",
			watermark_text: "水印文字",
			watermark_size: "水印字号",
			watermark_opacity: "水印不透明度",
			watermark_position: "水印位置",
			min_margin_rate: "最低毛利率（按进账）",
			min_margin_rmb: "最低毛利（元）",
			fx: "汇率（台币/元）",
			price_per_kg_rmb: "每公斤运费（元）",
			label_fee_rmb: "贴单费（元/单）",
			weight_rounding_kg: "重量取整（kg）",
			return_loss_rate: "退货损耗（按售价）",
			commission_rate: "成交手续费",
			pre_order_rate: "预售服务费",
			payment_rate: "金流费",
			coin_rate: "虾币回馈",
			free_shipping_rate: "免运方案费",
			free_shipping_min_twd: "免运方案费每单最低（台币）",
			shipping_net_twd: "运费净额（台币）",
			pre_order: "预售",
			min_purchase: "起购量",
			stock_cap: "库存上限",
			channels: "物流渠道（id，逗号分隔）",
			shop_id: "Shopee 店铺 id",
		},
		edit: {
			...Object.fromEntries(
				[
					"paused",
					"watermark_text",
					"watermark_size",
					"watermark_opacity",
					"min_margin_rate",
					"min_margin_rmb",
					"fx",
					"price_per_kg_rmb",
					"label_fee_rmb",
					"weight_rounding_kg",
					"return_loss_rate",
					"commission_rate",
					"pre_order_rate",
					"payment_rate",
					"coin_rate",
					"free_shipping_rate",
					"free_shipping_min_twd",
					"shipping_net_twd",
					"pre_order",
					"min_purchase",
					"stock_cap",
					"channels",
				].map((c) => [c, {}]),
			),
			watermark_position: { options: ["bottom-right", "bottom-left", "top-right", "top-left", "center"] },
		},
		views: [{ title: "设置", order: "shop", cards: true }],
	},
];
