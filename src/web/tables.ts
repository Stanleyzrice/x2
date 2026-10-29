// 网页（x2 web）上的表：库里哪些表、哪些列给人看（中文名、顺序），怎么看（筛选、排序、分组、卡片），人能改哪几格。
// 人能改的只有人定的那几格（AGENTS.md「不许做的」）；别的由 x2 写。值的类型从库里读（information_schema），界面照类型显示、照类型收。
// where、order、when 是这里写死的 SQL 片段，不来自网页

import { listingsCheck } from "../check/index.ts";
import { LISTING_STEPS } from "../check/listings.ts";
import { STEPS } from "../check/orders.ts";
import type { Sql } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { addListings } from "../listing/pick.ts";
import { LABEL, numbered, usedPics } from "../listing/product.ts";
import { isSingle, removedOf, specsOf, specsTable } from "../listing/variants.ts";
import { IMAGE } from "../site/shopee/seller.ts";

/** 人能改的一格：options 是可选的值；when 是这一行能改的条件（例 结果未知的写入才能改状态）；set 不是改一列（例 删图） */
export type Edit = { options?: readonly string[]; when?: string; set?: (sql: Sql, key: Key, value: unknown) => Promise<void> };
/** 一个视图：where 筛选，order 排序，group 按这一列分组（values 是组的顺序），cards 一行一张卡片（不给是表格），empty 是空的时候说的话 */
export type View = { title: string; where?: string; order: string; group?: { col: string; values?: readonly string[] }; cards?: boolean; empty?: string };
/** 人填一行新的：fields 是列和它的说明，insert 不是直接插一行（例 添加货源） */
export type Form = {
	title: string;
	fields: Record<string, string>;
	required: string[];
	options?: Record<string, (sql: Sql) => Promise<string[]>>;
	insert?: (sql: Sql, values: Record<string, string>) => Promise<string>;
};
/** 一张表：key 是主键的列；columns 是给人看的列 → 中文名（也是顺序），computed 是算出来的列（库里没有）；images、links 显示成图、链接；
 * edit 是人能改的；recheck 是人改之前、改之后 x2 马上重算这一行（例 商品稿的当前步骤） */
export type Table = {
	name: string;
	title: string;
	key: string[];
	columns: Record<string, string>;
	views: View[];
	computed?: Record<string, { type: ColumnType; of: (row: Row) => unknown }>;
	images?: string[];
	links?: string[];
	edit?: Record<string, Edit>;
	recheck?: (sql: Sql, key: Key) => Promise<unknown>;
	form?: Form;
};
export type Row = Record<string, any>;
export type Key = Record<string, string>;
export type ColumnType = "bool" | "number" | "time" | "text" | "json" | "image" | "link" | "pics" | "specs";

/** 给网页的：一张表的列（类型、能不能改、可选的值）、视图、表单 */
export type Meta = {
	name: string;
	title: string;
	key: string[];
	views: View[];
	columns: { name: string; label: string; type: ColumnType; edit?: { options?: readonly string[] } }[];
	form?: { title: string; fields: { name: string; label: string; hint: string; type: ColumnType; required: boolean; options?: readonly string[] }[] };
};

/** 商品稿的图（算出来的「图」）：主图、详情图（号和 x2 listing keep 认的一样）、规格图；state：用的、人删了的、x2 去掉的（drop 写着原因）、超出张数的 */
export type Pic = { id: string; url: string; label: string; role: "main" | "detail" | "option"; state: "used" | "removed" | "dropped" | "extra"; why?: string };

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

/** 删图、放回人删的图（主图、详情图）：记进、移出已删除的图，再做商品稿也不用它。x2 去掉的图要用，告诉 agent（x2 listing keep） */
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

/** 选用：一个商品只用一个货源，勾上这一个就去掉同一个商品别的货源的勾 */
async function choose(sql: Sql, key: Key, value: unknown): Promise<void> {
	if (typeof value !== "boolean") throw new Usage("选用：要 true 或 false");
	await sql.begin(async (tx) => {
		if (value) await tx`update sources set chosen = false, chosen_at = null where item_id = ${key.item_id!} and offer_id <> ${key.offer_id!} and chosen`;
		await tx`update sources set chosen = ${value}, chosen_at = ${value ? new Date() : null} where item_id = ${key.item_id!} and offer_id = ${key.offer_id!}`;
	});
}

/** 商品稿的规格和价格（算出来的「规格和价格」）：规格表，规格图传好了用 Shopee 的地址；还没做商品稿的是 null */
function specsRows(l: Row) {
	const s = specsOf(l.variants);
	if (!s) return null;
	const shopee = new Map(((l.images?.options ?? []) as any[]).filter((p) => p.imageId).map((p) => [p.from as string, `${IMAGE}${p.imageId}`]));
	return specsTable(s, removedOf(l.offer, l.removed_variants), (from) => shopee.get(from) ?? from);
}

const shops = async (sql: Sql) => (await sql`select shop from shop_settings order by shop`).map((r) => r.shop as string);

/** 侧栏从上到下的顺序；每张表的第一个视图是默认的 */
export const TABLES: Table[] = [
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
		computed: { pics: { type: "pics", of: picsOf }, specs: { type: "specs", of: specsRows } },
		edit: {
			nickname: {},
			note: {},
			title: {},
			description: {},
			weight_kg: {},
			freight_rmb: {},
			// 放弃：建了商品的是下架，不是放弃
			cancelled: { when: "product_id is null and listed_at is null" },
			pics: { set: setPic },
		},
		// 改完重算当前步骤（重量、国内运费改了重新核价）
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
		name: "writes",
		title: "写入",
		key: ["id"],
		columns: {
			id: "编号",
			batch: "批次",
			op: "操作",
			display: "内容",
			status: "状态",
			error: "原因",
			host: "执行电脑",
			created_at: "准备时间",
			finished_at: "结束时间",
			cost: "费用",
		},
		// 结果未知、不一致的：人到站点上看过，改成已核对（做成了）或被拒（没做成）
		edit: { status: { options: ["已核对", "被拒"], when: "status in ('结果未知', '不一致')" } },
		views: [{ title: "全部", order: "id desc" }],
	},
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
