// NocoDB：收件箱，团队看进度和结果，人填、选、批准。x2 nocodb 按 docs/loop.md「视图」建好它：连上库、表和列的中文名、侧栏顺序、视图（筛选、排序、分组、隐藏的列、行高），
// x2 用的表（图）从侧栏藏起来。一张表一个表格视图（到货问题、商品稿另有一个表单）。可以重复跑：默认视图改成第一个，别的视图删了重建。NocoDB 只读写库，不碰站点。
// NocoDB 对外部的库「改名」就是改表名，改列会按它的理解重写列定义（2026-10-09 试过：改一个列的标题，去掉了 NOT NULL）。所以：
// - 库在 NocoDB 里设成「表结构只读」：表的结构只由 schema.sql 改
// - 中文名、侧栏顺序、显示成链接、显示值直接写 NocoDB 自己的元数据库（nc_models_v2、nc_columns_v2），再清它的缓存
// 环境变量：X2_NOCODB_URL（例 http://localhost:8080）、X2_NOCODB_EMAIL、X2_NOCODB_PASSWORD（管理员）、X2_NOCODB_META_URL（NocoDB 自己的元数据库）、
// X2_NOCODB_DB_URL（NocoDB 那台机器怎么连 x2 的库；不给就用 X2_DATABASE_URL）
import postgres from "postgres";
import { createHash } from "node:crypto";
import { LISTING_STEPS } from "./check/listings.ts";
import { STEPS } from "./check/orders.ts";
import { CHANBOSS_STATUS } from "./read.ts";
import type { Sql } from "./db/index.ts";
import { NeedsHuman } from "./errors.ts";

type Cond = { col: string; op: string; value?: string | number; sub?: string };
/** 一个条件，或几个「或」起来的条件；最外层的几项「且」起来 */
type Filter = Cond | { or: Cond[] };
/** 不给 form 是表格：group 分组（单选列的组按取值的顺序排），rowHeight 行高（0 矮、1 中、2 高、3 很高）。
 * form：表单（人填一行新的），fields 是表单上的列和它的说明，required 是必填的；表单不能是第一个（默认视图是表格） */
type View = { title: string; form?: { heading: string; fields: Record<string, string>; required?: string[] }; filters?: Filter[]; sorts?: [string, "asc" | "desc"][]; group?: [string, "asc" | "desc"][]; hide?: string[]; rowHeight?: number };
/** columns：列名 → 中文名，也是视图里列的顺序；links：显示成链接的列；attachments：显示成附件的列（库里是 JSON 文本）；
 * selects：显示成单选的列和它的取值（按这个顺序，分组也是这个顺序）；primary：显示值（主列，表格的第一列），关联里看到的是它 */
type Table = { name: string; title: string; columns: Record<string, string>; links?: string[]; attachments?: string[]; selects?: Record<string, readonly string[]>; primary?: string; views: View[] };

/** 商品稿里给 x2 用的列（JSON、hash……）：视图里都藏起来 */
const LISTING_HIDDEN = ["offer", "images", "variants", "pricing", "audit", "attributes", "category_path", "category_id", "removed_images", "removed_variants", "kept_images", "offer_read_at",
	"pick_snapshot", "approved_hash", "content_hash", "unapproved_why", "noted", "step"];

/** x2 用的表：库里留着，NocoDB 的侧栏里藏起来（标成多对多的中间表，NocoDB 默认不显示） */
export const HIDDEN_TABLES = ["images", "shop_images"];

const COLORS = ["#cfdffe", "#d0f1fd", "#c2f5e9", "#d1f7c4", "#ffeab6", "#fee2d5", "#ffdce5", "#ffdaf6", "#ede2fe", "#eeeeee"];

/** 侧栏从上到下的顺序；每张表的第一个视图是默认视图。只放人要看、要填的：要人做的都在收件箱里，站点上有的不存 */
export function tables(): Table[] {
	return [
		{
			name: "inbox", title: "收件箱", links: ["link"],
			columns: {
				kind: "类别", title: "事项", detail: "详情", approve: "批准", done: "已处理", due: "期限", role: "负责人", shop: "店铺", link: "链接", snooze_until: "推迟至", note: "备注",
				key: "key", open: "未关闭", opened_at: "创建时间", closed_at: "关闭时间", updated_at: "更新时间",
			},
			views: [
				{
					title: "待处理", filters: [{ col: "open", op: "checked" }, { or: [{ col: "snooze_until", op: "blank" }, { col: "snooze_until", op: "lt", sub: "today" }] }],
					sorts: [["due", "asc"]], group: [["kind", "asc"]], hide: ["key", "open", "opened_at", "closed_at", "updated_at"],
				},
			],
		},
		{
			name: "orders", title: "订单",
			selects: { step: STEPS, chanboss_status: Object.values(CHANBOSS_STATUS) },
			columns: {
				sn: "订单号", shop: "店铺", ship_by: "出货期限", days_left: "剩余天数", step: "当前步骤", step_detail: "说明", items_text: "商品", platform_status: "平台状态", chanboss_status: "chanboss 状态",
				problem: "问题单", destination: "收货地址", created_at: "下单时间", cancelled_at: "取消时间", checked_at: "检查时间",
				items: "商品（JSON）", shop_id: "店铺 id", chanboss_id: "chanboss id", chanboss_time: "chanboss 下单时间",
			},
			// 按当前步骤分组（按流程，已打包、已取消在最后），出货期限近的在前
			views: [{ title: "全部", group: [["step", "asc"]], sorts: [["ship_by", "asc"]], hide: ["items", "shop_id", "chanboss_id", "chanboss_time"] }],
		},
		{
			name: "arrival_issues", title: "到货问题",
			selects: { kind: ["错货", "少件", "损坏", "其他"], resolution: ["退换", "重新采购", "无需处理"] },
			columns: { sn: "订单号", item: "商品和规格", kind: "问题类型", qty: "件数", note: "备注", resolution: "处理方式", done: "已处理", reported_at: "上报时间", done_at: "处理时间", id: "编号" },
			views: [
				{ title: "全部", sorts: [["done", "asc"], ["reported_at", "desc"]], hide: ["id"] },
				{
					title: "上报到货问题",
					form: {
						heading: "打包时发现错货、少件、损坏：每个问题填一行",
						fields: { sn: "订单号（拣货单上的）", item: "例：红T L", kind: "", qty: "", note: "看到的情况；照片存放位置", resolution: "已确定就选，未确定留空" },
						required: ["sn", "kind"],
					},
				},
			],
		},
		{
			name: "listings", title: "商品稿", attachments: ["main_images", "detail_images", "option_images"], primary: "nickname",
			// 当前步骤显示的是 step_group（照 step 算的 enum，组按 LISTING_STEPS 的顺序排）；step 是 x2 写的文本，藏起来
			selects: { step_group: LISTING_STEPS, shop: ["cheeroutdoor", "ni1206"] },
			columns: {
				nickname: "简称", approve: "批准上架", step_group: "当前步骤", step_detail: "说明", note: "备注", shop: "店铺", main_images: "主图", variants_text: "规格和价格", option_images: "规格图", detail_images: "详情图",
				title: "标题", description: "描述", category_name: "类目", attributes_text: "属性", problems: "待补充", weight_kg: "重量（kg，1688 没给时用）", freight_rmb: "国内运费（元/件，读不到时用）", days_to_ship: "备货天数",
				cancelled: "放弃", strategy: "策略", pick_why: "选品理由", pick_evidence: "依据", offer_id: "货源（1688 链接）", product_id: "Shopee 商品 id", approved_at: "批准时间", listed_at: "上架时间", id: "编号", created_at: "创建时间", updated_at: "更新时间",
				pick_snapshot: "选品快照", offer: "货源快照", images: "图（JSON）", variants: "规格（JSON）", pricing: "核价参数", audit: "Gemini 文字检查", attributes: "属性（JSON）", category_path: "类目路径", category_id: "类目 id",
				removed_images: "已删除的图", removed_variants: "已移除的规格", kept_images: "保留的图", offer_read_at: "货源读取时间", approved_hash: "批准时的内容（hash）", content_hash: "内容（hash）", unapproved_why: "去掉勾的原因", noted: "看过的备注", step: "当前步骤（文本）",
			},
			views: [
				// 按当前步骤分组：待批准、待补充在最前，已上架、已放弃在最后。行调高，主图、规格图、详情图看得见缩略图；删掉不要的图就是在「主图」「详情图」里删附件（「规格图」只看，删了下一轮写回去）
				{ title: "全部", group: [["step_group", "asc"]], sorts: [["id", "asc"]], hide: LISTING_HIDDEN, rowHeight: 2 },
				{
					title: "添加货源",
					form: { heading: "添加 1688 货源", fields: { shop: "上品的店铺", offer_id: "1688 商品链接（完整粘贴）", note: "补充说明（例：选它的理由）" }, required: ["shop", "offer_id"] },
				},
			],
		},
		{
			name: "strategies", title: "策略", selects: { status: ["试验中", "使用中", "已停用"] },
			columns: { name: "策略", status: "状态", version: "版本号", bet: "假设", how: "选品方法", note: "备注", created_at: "创建时间", updated_at: "更新时间" },
			views: [{ title: "全部", sorts: [["created_at", "desc"]] }],
		},
		{
			// 改之前、改之后只有改了的列（JSON：status 状态、bet 假设、how 选品方法、note 备注）
			name: "strategy_changes", title: "策略变更记录",
			columns: { strategy: "策略", version: "版本号", before: "改之前", after: "改之后", why: "理由", changed_at: "变更时间", id: "编号" },
			views: [{ title: "全部", sorts: [["changed_at", "desc"]], hide: ["id"] }],
		},
		{
			name: "selection_rules", title: "选品规矩",
			columns: { id: "编号", rule: "规矩", why: "理由", started_at: "开始时间", ended_at: "结束时间", retire_why: "停用原因" },
			views: [{ title: "全部", sorts: [["id", "asc"]] }],
		},
		{
			name: "sources", title: "货源", links: ["url", "image", "item_image"],
			columns: {
				item_name: "店里的商品", chosen: "选用", title: "货源", url: "链接", sku_exceptions: "规格例外", score: "相似度", missing: "未匹配的规格", sure: "明显匹配", origin: "来源", broken: "不可用",
				image: "货源的图", item_image: "店里的图", site: "站点", read_at: "读取时间", skus: "货源的规格（快照）", offer_id: "货源 id", item_id: "商品 id", found_at: "发现时间", chosen_at: "选定时间",
			},
			views: [
				// 按店里的商品分组，选用的在前；定了货源以后剩下的候选删掉：一组里没有勾「选用」的就是还没选
				{ title: "全部", group: [["item_name", "asc"]], sorts: [["chosen", "desc"], ["score", "desc"]], hide: ["skus", "offer_id", "item_id", "found_at", "read_at", "site"] },
			],
		},
		{
			name: "writes", title: "写入",
			columns: {
				id: "编号", batch: "批次", op: "操作", display: "内容", include: "执行", status: "状态", error: "原因", target: "对象", key: "防重复", params: "参数", response: "站点响应",
				readback: "回读", host: "执行电脑", created_at: "准备时间", started_at: "开始时间", finished_at: "结束时间", cost: "费用",
			},
			views: [{ title: "全部", sorts: [["id", "desc"]], hide: ["target", "key", "params", "response", "readback"] }],
		},
		{
			name: "order_settings", title: "订单设置",
			columns: {
				buy_account: "采购账号（1688 会员名）", late_days: "快到期提醒（天）", ship_wait_hours: "未发货提醒（付款后小时数）", forecast_needs_approval: "预报要批准",
				channel: "发货线路", sendway_id: "发货线路代码", line_id: "线路 id", warehouse_id: "仓库 id", id: "id",
			},
			views: [{ title: "设置", hide: ["id"] }],
		},
		{
			name: "shop_settings", title: "店铺设置",
			selects: { watermark_position: ["bottom-right", "bottom-left", "top-right", "top-left", "center"] },
			columns: {
				shop: "店铺", paused: "暂停上品原因", watermark_text: "水印文字", watermark_size: "水印字号", watermark_opacity: "水印不透明度", watermark_position: "水印位置",
				min_margin_rate: "最低毛利率（按进账）", min_margin_rmb: "最低毛利（元）", fx: "汇率（台币/元）", price_per_kg_rmb: "每公斤运费（元）", label_fee_rmb: "贴单费（元/单）", weight_rounding_kg: "重量取整（kg）",
				return_loss_rate: "退货损耗（按售价）", commission_rate: "成交手续费", pre_order_rate: "预售服务费", payment_rate: "金流费", coin_rate: "虾币回馈", free_shipping_rate: "免运方案费",
				free_shipping_min_twd: "免运方案费每单最低（台币）", shipping_net_twd: "运费净额（台币）", pre_order: "预售", min_purchase: "起购量", stock_cap: "库存上限", channels: "物流渠道（id，逗号分隔）",
				categories: "允许的类目（JSON）", shop_id: "Shopee 店铺 id", updated_at: "更新时间",
			},
			views: [{ title: "设置", hide: ["categories"] }],
		},
	];
}

const env = (name: string) => {
	const v = process.env[name];
	if (!v) throw new NeedsHuman(`没有设 ${name}：写进仓库根目录的 .env（一行 ${name}=…），或者在环境变量里设（见 src/nocodb.ts 开头）`);
	return v;
};

/** NocoDB 的接口：用管理员登录拿到的令牌（清缓存不收 API token） */
async function client() {
	const base = (process.env.X2_NOCODB_URL ?? "http://localhost:8080").replace(/\/$/, "");
	const signin = await fetch(`${base}/api/v1/auth/user/signin`, {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: env("X2_NOCODB_EMAIL"), password: env("X2_NOCODB_PASSWORD") }),
	}).catch((e) => { throw new NeedsHuman(`连不上 NocoDB（${base}）：${(e as Error).message}`); });
	const { token } = (await signin.json()) as { token?: string };
	if (!token) throw new NeedsHuman("NocoDB 登录不了：看 X2_NOCODB_EMAIL、X2_NOCODB_PASSWORD");
	return async <T = any>(method: string, path: string, body?: unknown): Promise<T> => {
		const r = await fetch(`${base}/api/v2/meta${path}`, { method, headers: { "xc-auth": token, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
		const text = await r.text();
		if (!r.ok) throw new Error(`NocoDB ${method} ${path}：HTTP ${r.status} ${text.slice(0, 300)}`);
		return (text ? JSON.parse(text) : null) as T;
	};
}

/** NocoDB 那台机器连 x2 的库用的连接 */
function connection() {
	const u = new URL(process.env.X2_NOCODB_DB_URL ?? env("X2_DATABASE_URL"));
	return { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username || process.env.USER || ""), password: decodeURIComponent(u.password), database: u.pathname.slice(1) };
}

export async function setup(sql: Sql, log: (s: string) => void = console.error): Promise<{ base: string; tables: number; views: number }> {
	const api = await client();
	const meta = postgres(env("X2_NOCODB_META_URL"), { onnotice: () => {}, max: 1 });
	try {
		// 1. base 和库
		let base = (await api<{ list: any[] }>("GET", "/bases")).list.find((b) => b.title === "x2");
		if (!base) {
			log("建 base x2，连上库");
			base = await api("POST", "/bases", {
				title: "x2", external: true,
				sources: [{ type: "pg", config: { client: "pg", connection: connection(), searchPath: ["public"] }, inflection_column: "none", inflection_table: "none", is_schema_readonly: true }],
			});
		}
		const source = (await api<any>("GET", `/bases/${base.id}`)).sources.find((s: any) => !s.is_meta);
		// 库里加了表、列：让 NocoDB 重新读一遍
		await api("PATCH", `/bases/${base.id}/sources/${source.id}`, { is_schema_readonly: false });
		await api("POST", `/bases/${base.id}/meta-diff/${source.id}`).catch((e) => log(`重新读表结构：${(e as Error).message}`));
		await api("PATCH", `/bases/${base.id}/sources/${source.id}`, { is_schema_readonly: true });

		const specs = tables();
		// 重新读表结构是 NocoDB 的后台任务：等到要的表和列都出来（最多 60 秒；库里新加的列也要等）
		let all: any[] = [];
		const ready = async () => {
			all = (await api<{ list: any[] }>("GET", `/bases/${base.id}/tables`)).list;
			for (const t of specs) {
				const m = all.find((x) => x.table_name === t.name);
				if (!m) return false;
				const cols = new Set(((await api<any>("GET", `/tables/${m.id}`)).columns as any[]).map((c) => c.column_name));
				if (!Object.keys(t.columns).every((c) => cols.has(c))) return false;
			}
			return true;
		};
		for (let i = 0; i < 40 && !(await ready()); i++) await new Promise((r) => setTimeout(r, 1500));
		let views = 0;
		for (const [order, t] of specs.entries()) {
			const model = all.find((m) => m.table_name === t.name);
			if (!model) { log(`NocoDB 里没有表 ${t.name}：跳过`); continue; }
			// 2. 中文名、侧栏顺序、链接：写元数据库
			await meta`update nc_models_v2 set title = ${t.title}, "order" = ${order + 1} where id = ${model.id}`;
			for (const [col, title] of Object.entries(t.columns)) {
				await meta`update nc_columns_v2 set title = ${title} where fk_model_id = ${model.id} and column_name = ${col}`;
				if (t.links?.includes(col)) await meta`update nc_columns_v2 set uidt = 'URL' where fk_model_id = ${model.id} and column_name = ${col}`;
				if (t.attachments?.includes(col)) await meta`update nc_columns_v2 set uidt = 'Attachment' where fk_model_id = ${model.id} and column_name = ${col}`;
			}
			// 显示值（主列）：卡片、关联里看到的是它
			if (t.primary) await meta`update nc_columns_v2 set pv = (column_name = ${t.primary}) where fk_model_id = ${model.id}`;
			// 单选：库里是 text（商品稿的当前步骤是 enum），只在 NocoDB 的元数据里标成单选，取值按顺序。NocoDB 按值排组，不按取值的顺序
			for (const [col, values] of Object.entries(t.selects ?? {})) {
				const [c] = await meta`select id from nc_columns_v2 where fk_model_id = ${model.id} and column_name = ${col}`;
				if (!c) continue;
				await meta`update nc_columns_v2 set uidt = 'SingleSelect' where id = ${c.id}`;
				await meta`delete from nc_col_select_options_v2 where fk_column_id = ${c.id}`;
				for (const [i, v] of values.entries()) {
					const id = `sl${createHash("md5").update(`${c.id}:${v}`).digest("hex").slice(0, 14)}`;
					await meta`insert into nc_col_select_options_v2 (id, fk_column_id, title, color, "order", base_id, fk_workspace_id, created_at, updated_at)
						values (${id}, ${c.id}, ${v}, ${COLORS[i % COLORS.length]!}, ${i + 1}, ${model.base_id}, ${model.fk_workspace_id ?? null}, now(), now())`;
				}
			}
		}
		// x2 用的表从侧栏藏起来（NocoDB 不显示多对多的中间表）；库里的表不动
		await meta`update nc_models_v2 set mm = true where base_id = ${base.id} and table_name in ${meta(HIDDEN_TABLES)}`;
		await api("DELETE", "/cache");

		// 3. 视图：第一个是默认视图（改名、清掉原来的筛选和排序），别的视图都删了，按 spec 重建
		for (const t of specs) {
			const model = all.find((m) => m.table_name === t.name);
			if (!model) continue;
			const full = await api<any>("GET", `/tables/${model.id}`);
			const colId = (name: string) => {
				const c = full.columns.find((x: any) => x.column_name === name);
				if (!c) throw new Error(`表 ${t.name} 没有列 ${name}`);
				return c.id as string;
			};
			const existing = (await api<{ list: any[] }>("GET", `/tables/${model.id}/views`)).list;
			// 默认视图：NocoDB 不标 is_default，是排在最前的那个（建表时自带）
			const def = [...existing].sort((a, b) => Number(a.order) - Number(b.order))[0];
			const isDef = (v: any) => v.id === def?.id;
			for (const v of existing) if (!isDef(v)) await api("DELETE", `/views/${v.id}`);
			for (const [i, spec] of t.views.entries()) {
				let viewId: string;
				if (i === 0 && def) {
					viewId = def.id;
					await api("PATCH", `/views/${viewId}`, { title: spec.title });
					for (const f of (await api<{ list: any[] }>("GET", `/views/${viewId}/filters`)).list) await api("DELETE", `/filters/${f.id}`);
					for (const s of (await api<{ list: any[] }>("GET", `/views/${viewId}/sorts`)).list) await api("DELETE", `/sorts/${s.id}`);
				} else if (spec.form) viewId = (await api<any>("POST", `/tables/${model.id}/forms`, { title: spec.title, heading: spec.form.heading })).id;
				else viewId = (await api<any>("POST", `/tables/${model.id}/grids`, { title: spec.title })).id;
				for (const f of spec.filters ?? []) {
					const cond = (c: Cond, extra: object = {}) => ({ fk_column_id: colId(c.col), comparison_op: c.op, comparison_sub_op: c.sub, value: c.value, ...extra });
					if ("or" in f) {
						const group = await api<any>("POST", `/views/${viewId}/filters`, { is_group: true, logical_op: "and" });
						for (const c of f.or) await api("POST", `/views/${viewId}/filters`, cond(c, { fk_parent_id: group.id, logical_op: "or" }));
					} else await api("POST", `/views/${viewId}/filters`, cond(f, { logical_op: "and" }));
				}
				for (const [col, direction] of spec.sorts ?? []) await api("POST", `/views/${viewId}/sorts`, { fk_column_id: colId(col), direction });
				const order = Object.keys(t.columns);
				const nameOf = (columnId: string) => full.columns.find((c: any) => c.id === columnId)?.column_name as string | undefined;
				if (spec.form) {
					// 表单：只放 fields 里的列，按它的顺序，带说明
					await api("PATCH", `/forms/${viewId}`, { heading: spec.form.heading, submit_another_form: true, show_blank_form: true });
					const keys = Object.keys(spec.form.fields);
					for (const fc of (await api<any>("GET", `/forms/${viewId}`)).columns ?? []) {
						const name = nameOf(fc.fk_column_id);
						if (!name) continue;
						const i = keys.indexOf(name);
						await api("PATCH", `/form-columns/${fc.id}`, {
							show: i >= 0, order: i >= 0 ? i + 1 : keys.length + 1, label: t.columns[name] ?? name, description: spec.form.fields[name] ?? "", required: (spec.form.required ?? []).includes(name),
						});
					}
					views++;
					continue;
				}
				// 行高、列的顺序、隐藏、分组
				await api("PATCH", `/grids/${viewId}`, { row_height: spec.rowHeight ?? 0 });
				const gridCols = await api<any[]>("GET", `/grids/${viewId}/grid-columns`);
				for (const gc of gridCols) {
					const name = nameOf(gc.fk_column_id);
					if (!name) continue;
					const g = (spec.group ?? []).findIndex(([c]) => c === name);
					await api("PATCH", `/grid-columns/${gc.id}`, {
						show: !(spec.hide ?? []).includes(name), order: order.includes(name) ? order.indexOf(name) + 1 : order.length + 1,
						group_by: g >= 0, ...(g >= 0 ? { group_by_order: g + 1, group_by_sort: spec.group![g]![1] } : {}),
					});
				}
				views++;
			}
			log(`${t.title}：${t.views.map((v) => v.title).join("、")}`);
		}
		await api("DELETE", "/cache");
		return { base: base.id, tables: specs.length, views };
	} finally {
		await meta.end();
	}
}
