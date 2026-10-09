// NocoDB：收件箱，团队看进度和结果，人填、选、批准。x2 nocodb 按 docs/loop.md「视图」建好它：连上库、表和列的中文名、侧栏顺序、视图（筛选、排序、分组、隐藏的列）。
// 可以重复跑：同名的视图删了重建。NocoDB 只读写库，不碰站点。
// NocoDB 对外部的库「改名」就是改表名，改列会按它的理解重写列定义（2026-10-09 试过：改一个列的标题，去掉了 NOT NULL）。所以：
// - 库在 NocoDB 里设成「表结构只读」：表的结构只由 schema.sql 改
// - 中文名、侧栏顺序、显示成链接直接写 NocoDB 自己的元数据库（nc_models_v2、nc_columns_v2），再清它的缓存
// 环境变量：X2_NOCODB_URL（例 http://localhost:8080）、X2_NOCODB_EMAIL、X2_NOCODB_PASSWORD（管理员）、X2_NOCODB_META_URL（NocoDB 自己的元数据库）、
// X2_NOCODB_DB_URL（NocoDB 那台机器怎么连 x2 的库；不给就用 X2_DATABASE_URL）
import postgres from "postgres";
import { createHash } from "node:crypto";
import { STEPS } from "./check/orders.ts";
import { CHANBOSS_STATUS } from "./sync/orders.ts";
import type { Sql } from "./db/index.ts";
import { NeedsHuman } from "./errors.ts";

type Cond = { col: string; op: string; value?: string | number; sub?: string };
/** 一个条件，或几个「或」起来的条件；最外层的几项「且」起来 */
type Filter = Cond | { or: Cond[] };
/** kanban：看板，按这一列分列（这一列要在 selects 里）；form：表单（人填一行新的），fields 是表单上的列和它的说明，required 是必填的。看板、表单不能是第一个（默认视图是表格） */
type View = { title: string; kanban?: string; form?: { heading: string; fields: Record<string, string>; required?: string[] }; filters?: Filter[]; sorts?: [string, "asc" | "desc"][]; group?: [string, "asc" | "desc"][]; hide?: string[] };
/** columns：列名 → 中文名，也是视图里列的顺序；links：显示成链接的列；selects：显示成单选的列和它的取值（按这个顺序，看板的列也是这个顺序） */
type Table = { name: string; title: string; columns: Record<string, string>; links?: string[]; selects?: Record<string, readonly string[]>; views: View[] };

const COLORS = ["#cfdffe", "#d0f1fd", "#c2f5e9", "#d1f7c4", "#ffeab6", "#fee2d5", "#ffdce5", "#ffdaf6", "#ede2fe", "#eeeeee"];

const OPEN_ORDER: Filter[] = [{ col: "platform_status", op: "eq", value: "待出货" }, { col: "chanboss_status", op: "neq", value: "已打包" }, { col: "chanboss_status", op: "neq", value: "已出库" }];

/** 侧栏从上到下的顺序；每张表的第一个视图是默认视图 */
export function tables(lateDays: number): Table[] {
	return [
		{
			name: "inbox", title: "收件箱", links: ["link"],
			columns: {
				kind: "类别", title: "事情", detail: "详情", approve: "批准", done: "处理好了", due: "期限", role: "谁做", shop: "店铺", link: "去哪做", snooze_until: "推迟到", note: "备注",
				key: "key", open: "开着", opened_at: "开始于", closed_at: "关掉于", updated_at: "更新于",
			},
			views: [
				{
					title: "要我做的", filters: [{ col: "open", op: "checked" }, { or: [{ col: "snooze_until", op: "blank" }, { col: "snooze_until", op: "lt", sub: "today" }] }],
					sorts: [["due", "asc"]], group: [["kind", "asc"]], hide: ["key", "open", "opened_at", "closed_at", "updated_at"],
				},
				{ title: "最近关掉的", filters: [{ col: "open", op: "notchecked" }, { col: "closed_at", op: "isWithin", sub: "pastWeek" }], sorts: [["closed_at", "desc"]], hide: ["key", "open", "approve", "done", "snooze_until"] },
			],
		},
		{
			name: "orders", title: "订单",
			selects: { step: STEPS, chanboss_status: Object.values(CHANBOSS_STATUS) },
			columns: {
				sn: "订单号", shop: "店铺", ship_by: "出货期限", days_left: "剩几天", step: "卡在哪一步", step_detail: "细节", platform_status: "平台状态", chanboss_status: "chanboss 状态", items_text: "商品",
				problem: "问题单", destination: "寄到哪", sourced: "货源齐了", carted: "加购了", paid: "付款了", arrived: "到齐了", created_at: "下单时间", cancelled_at: "取消时间",
				items: "商品（JSON）", shop_id: "店铺 id", chanboss_id: "chanboss id", chanboss_time: "chanboss 下单时间", synced_at: "同步于", checked_at: "检查于",
			},
			views: [
				{ title: "全部", sorts: [["created_at", "desc"]], hide: ["items", "chanboss_id", "chanboss_time"] },
				// 看板：一列一步，卡片上是订单号、店铺、出货期限、剩几天、细节、商品
				{
					title: "待出货", kanban: "step", filters: OPEN_ORDER, sorts: [["ship_by", "asc"]],
					hide: ["platform_status", "chanboss_status", "problem", "destination", "sourced", "carted", "paid", "arrived", "created_at", "cancelled_at", "items", "shop_id", "chanboss_id", "chanboss_time", "synced_at", "checked_at"],
				},
				{ title: "快到期", filters: [...OPEN_ORDER, { col: "days_left", op: "lt", value: lateDays }], sorts: [["ship_by", "asc"]], hide: ["items", "shop_id", "chanboss_id", "chanboss_time", "synced_at", "checked_at", "cancelled_at", "sourced", "carted", "paid", "arrived"] },
			],
		},
		{
			name: "arrival_issues", title: "到货问题",
			selects: { kind: ["错货", "少件", "坏了", "其他"], resolution: ["退换", "重新买", "不用管"] },
			columns: { sn: "订单号", item: "哪件", kind: "问题", qty: "几件", note: "备注", resolution: "怎么处理", done: "处理好了", reported_at: "报的时间", done_at: "处理好的时间", id: "编号" },
			views: [
				{ title: "没处理好的", filters: [{ col: "done", op: "notchecked" }], sorts: [["reported_at", "asc"]], hide: ["id", "done_at"] },
				{
					title: "报到货问题",
					form: {
						heading: "打包时发现错货、少件、坏了，填一行",
						fields: { sn: "订单号（拣货单上的）", item: "哪件：商品和规格，例 红T L", kind: "", qty: "", note: "看到了什么；拍了照片写在哪", resolution: "知道怎么处理就选，不知道空着" },
						required: ["sn", "kind"],
					},
				},
			],
		},
		{
			name: "source_options", title: "货源候选", links: ["sku_image", "image"],
			columns: {
				sku_name: "店里的规格", chosen: "用这个", name: "1688 规格", offer_title: "货源", price: "价格", stock: "库存", missing: "缺", score: "像不像", sure: "明显对得上", origin: "从哪来",
				image: "1688 的图", sku_image: "店里的图", model_id: "规格 id", offer_id: "货源 id", offer_sku_id: "1688 规格 id", found_at: "找到于",
			},
			views: [{ title: "选货源", sorts: [["score", "desc"]], group: [["sku_name", "asc"]], hide: ["model_id", "offer_id", "offer_sku_id", "found_at", "sku_name"] }],
		},
		{
			name: "cart", title: "购物车",
			columns: { should_buy: "该不该买", offer_id: "货源", offer_sku_id: "1688 规格", qty: "件数", orders: "订单", account: "1688 账号", synced_at: "同步于" },
			views: [{ title: "购物车", group: [["should_buy", "asc"]] }],
		},
		{
			name: "purchases", title: "采购单",
			columns: {
				order_id: "采购单号", account: "1688 账号", offer_id: "货源", offer_sku_id: "1688 规格", qty: "件数", price: "单价", paid: "实付", status_label: "状态", paid_at: "付款时间",
				to_chanboss: "寄到 chanboss", address: "收货地址", tracking_no: "快递单号", logistics: "物流", signed: "签收了", shipped_at: "发货时间", created_at: "下单时间",
				line: "行", spec_id: "specId", status: "状态码", raw: "原样", synced_at: "同步于",
			},
			views: [
				{ title: "在路上", filters: [{ col: "paid_at", op: "notblank" }, { col: "signed", op: "notchecked" }], sorts: [["paid_at", "asc"]], hide: ["line", "spec_id", "status", "raw", "synced_at"] },
				{ title: "全部", sorts: [["created_at", "desc"]], hide: ["raw"] },
			],
		},
		{
			name: "writes", title: "写入",
			columns: {
				id: "编号", batch: "批次", op: "操作", display: "内容", include: "做", status: "状态", error: "原因", target: "对象", key: "防重复", params: "参数", response: "站点的回应",
				readback: "回读", host: "电脑", created_at: "准备于", started_at: "开始于", finished_at: "结束于", cost: "费用",
			},
			views: [
				{ title: "全部", sorts: [["id", "desc"]], hide: ["target", "key", "params", "response", "readback"] },
				{ title: "待批准", filters: [{ col: "status", op: "eq", value: "待批准" }], sorts: [["id", "asc"]], group: [["batch", "asc"]], hide: ["target", "key", "params", "response", "readback", "started_at", "finished_at"] },
				{ title: "结果未知", filters: [{ or: [{ col: "status", op: "eq", value: "结果未知" }, { col: "status", op: "eq", value: "不一致" }, { col: "status", op: "eq", value: "已提交" }] }], sorts: [["id", "asc"]] },
			],
		},
		{
			name: "syncs", title: "同步",
			columns: { name: "读什么", scope: "店铺或账号", last_ok_at: "上次读到", result: "结果", error: "原因", blocked: "要人处理", max_minutes: "目标多新（分钟）", last_at: "上次读", rows: "行数", host: "电脑" },
			views: [{ title: "数据新不新", sorts: [["last_ok_at", "asc"]] }],
		},
		{
			name: "skus", title: "规格", links: ["image"],
			columns: {
				item_name: "商品", name: "规格", offer_id: "货源", offer_sku_id: "1688 规格", status: "状态", price: "价格", stock: "库存", image: "图", model_id: "规格 id", item_id: "商品 id",
				shop_id: "店铺 id", sourced_at: "定货源于", synced_at: "同步于",
			},
			views: [{ title: "全部", sorts: [["item_name", "asc"]] }, { title: "在售没货源", filters: [{ col: "status", op: "eq", value: "在售" }, { col: "offer_id", op: "blank" }], sorts: [["item_name", "asc"]] }],
		},
		{
			name: "offers", title: "货源", links: ["url", "image"],
			columns: { title: "标题", live: "在售", min_qty: "起订量", unit: "单位", url: "链接", image: "图", offer_id: "货源 id", props: "属性", skus: "1688 规格", read_at: "读到于" },
			views: [{ title: "全部", sorts: [["read_at", "desc"]], hide: ["props", "skus"] }],
		},
		{
			name: "shops", title: "店铺",
			columns: {
				account: "账号名", name: "店名", enabled: "启用", shop_id: "店铺 id", user_id: "账号 id", browser: "浏览器", target_margin: "目标利润率", min_profit: "最低利润额", fx_rate: "汇率",
				forwarder_per_kg: "货代每公斤", weight_step: "计重步长", order_fee: "每单固定费", platform_fee_rate: "平台费率", risk_reserve: "风险预留", watermark: "水印", watermark_text: "水印文字",
			},
			views: [{ title: "设置" }],
		},
		{
			name: "order_settings", title: "订单设置",
			columns: {
				buy_account: "采购账号（1688 userId）", late_days: "快到期提前几天", ship_wait_hours: "付款后几小时没发货算异常", forecast_needs_approval: "预报要批准", channel: "发货线路", chanboss_address: "chanboss 的收货地址",
				sendway_id: "发货线路代码", line_id: "线路 id", warehouse_id: "仓库 id", id: "id",
			},
			views: [{ title: "设置", hide: ["id"] }],
		},
		{ name: "inbox_roles", title: "谁做", columns: { kind: "类别", role: "谁做" }, views: [{ title: "设置" }] },
		{ name: "accounts_1688", title: "1688 账号", columns: { login_id: "会员名", user_id: "userId", seen_at: "上次见到" }, views: [{ title: "全部" }] },
	];
}

const env = (name: string) => {
	const v = process.env[name];
	if (!v) throw new NeedsHuman(`没有设 ${name}（见 src/nocodb.ts 开头）`);
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

		const [{ late_days }] = await sql`select late_days from order_settings where id = 1` as any;
		const specs = tables(Number(late_days));
		// 重新读表结构是 NocoDB 的后台任务：等到要的表都出来（最多 60 秒）
		let all: any[] = [];
		for (let i = 0; i < 40; i++) {
			all = (await api<{ list: any[] }>("GET", `/bases/${base.id}/tables`)).list;
			if (specs.every((t) => all.some((m) => m.table_name === t.name))) break;
			await new Promise((r) => setTimeout(r, 1500));
		}
		let views = 0;
		for (const [order, t] of specs.entries()) {
			const model = all.find((m) => m.table_name === t.name);
			if (!model) { log(`NocoDB 里没有表 ${t.name}：跳过`); continue; }
			// 2. 中文名、侧栏顺序、链接：写元数据库
			await meta`update nc_models_v2 set title = ${t.title}, "order" = ${order + 1} where id = ${model.id}`;
			for (const [col, title] of Object.entries(t.columns)) {
				await meta`update nc_columns_v2 set title = ${title} where fk_model_id = ${model.id} and column_name = ${col}`;
				if (t.links?.includes(col)) await meta`update nc_columns_v2 set uidt = 'URL' where fk_model_id = ${model.id} and column_name = ${col}`;
			}
			// 单选：库里还是 text，只在 NocoDB 的元数据里标成单选，取值按顺序（看板的列也是这个顺序）
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
		await api("DELETE", "/cache");

		// 3. 视图：第一个是默认视图（改名、清掉原来的筛选和排序），其余同名的删了重建
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
			for (const v of existing) if (!isDef(v) && t.views.some((s) => s.title === v.title)) await api("DELETE", `/views/${v.id}`);
			for (const [i, spec] of t.views.entries()) {
				let viewId: string;
				if (i === 0 && def) {
					viewId = def.id;
					await api("PATCH", `/views/${viewId}`, { title: spec.title });
					for (const f of (await api<{ list: any[] }>("GET", `/views/${viewId}/filters`)).list) await api("DELETE", `/filters/${f.id}`);
					for (const s of (await api<{ list: any[] }>("GET", `/views/${viewId}/sorts`)).list) await api("DELETE", `/sorts/${s.id}`);
				} else if (spec.form) viewId = (await api<any>("POST", `/tables/${model.id}/forms`, { title: spec.title, heading: spec.form.heading })).id;
				else if (spec.kanban) viewId = (await api<any>("POST", `/tables/${model.id}/kanbans`, { title: spec.title, fk_grp_col_id: colId(spec.kanban) })).id;
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
				if (spec.kanban) {
					// 看板：卡片上显示哪些列、什么顺序
					for (const vc of (await api<{ list: any[] }>("GET", `/views/${viewId}/columns`)).list) {
						const name = nameOf(vc.fk_column_id);
						if (!name) continue;
						await api("PATCH", `/views/${viewId}/columns/${vc.id}`, { show: !(spec.hide ?? []).includes(name), order: order.includes(name) ? order.indexOf(name) + 1 : order.length + 1 });
					}
					views++;
					continue;
				}
				// 列的顺序、隐藏、分组
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
