// chanboss（c.chanboss.com，货代）：订单、退件、库存、扣款流水（读）；预报（写，只经订单的写工具）。
// 凭证是 localStorage 的 __tk，放进 x-wh-sessionkey 请求头（没有 cookie）；外壳 { code, data, message }，code 10000 是成功，90000 是会话失效。
// 这个站不按登录的账号过滤：每个列表都要带 seller_id，换一个 id 能读到别的卖家（lilto 查到的越权）。所以 seller_id 只用 identity() 读到的自己的 id。
// 频率：两次请求隔 2 秒以上（lilto 的上限每秒 0.5 次）
import { page } from "../../../platform/browser/browser.ts";
import { NeedsHuman } from "../../../platform/errors.ts";

const ORIGIN = "https://c.chanboss.com";
const API = "/api/v2/common/cangboss";

let last = 0;
async function call(path: string, req: { query?: Record<string, string | number | boolean>; body?: unknown } = {}): Promise<any> {
	const wait = last + 2000 - Date.now();
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	last = Date.now();
	const p = await page(ORIGIN);
	return p.run(
		async (path: string, query: Record<string, string>, body: string | null) => {
			const token = localStorage.getItem("__tk") ?? "";
			if (!token) return { code: 90000, message: "没有登录" };
			const url = new URL(path, location.origin);
			for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
			try {
				const r = await fetch(url.href, {
					method: body === null ? "GET" : "POST",
					headers: { "x-wh-sessionkey": token, ...(body === null ? {} : { "content-type": "application/json" }) },
					body: body ?? undefined,
				});
				return r.json().catch(() => (r.status >= 500 ? { unknown: `HTTP ${r.status}` } : { code: -1, message: `HTTP ${r.status}` }));
			} catch (e) {
				return { unknown: String((e as Error)?.message ?? e) };
			}
		},
		`${API}${path}`,
		Object.fromEntries(Object.entries(req.query ?? {}).map(([k, v]) => [k, String(v)])),
		req.body === undefined ? null : JSON.stringify(req.body),
	);
}

const signedOut = (b: any) => Number(b?.code) === 90000 || /失效|session/i.test(String(b?.message ?? ""));

async function api<T = any>(path: string, req: { query?: Record<string, string | number | boolean>; body?: unknown } = {}): Promise<T> {
	const b = await call(path, req);
	if (b?.unknown) throw new Error(`chanboss ${path}：${b.unknown}`);
	if (signedOut(b)) throw new NeedsHuman("chanboss 没有登录（或会话失效）：在浏览器里登录 c.chanboss.com");
	if (Number(b?.code) !== 10000) throw new Error(`chanboss ${path} 回 ${b?.code}：${b?.message ?? ""}`);
	return b.data as T;
}

/** 登录着的账号：userId 就是各个列表要带的 seller_id */
export async function identity(): Promise<{ userId: number; account: string; accountType: string }> {
	const d = await api("/sso/check", { body: {} });
	if (!d?.user_id) throw new Error("chanboss 没有回账号");
	return { userId: Number(d.user_id), account: String(d.account ?? ""), accountType: String(d.account_type ?? "") };
}

const me = async () => (await identity()).userId;
const list = (d: any) => ({ total: Number(d?.total ?? d?.items?.length ?? 0), pageCount: Number(d?.pageCount ?? 1), rows: (d?.items ?? []) as any[] });

/** 订单（两家店的 Shopee 订单在 chanboss 的进度）的一页，按下单时间（秒）筛；给了 Shopee 订单号（最多 100 个）只读这几张 */
export async function orders(from: number, to: number, pageIndex = 1, orderSns: string[] = [], pageSize = 50) {
	return list(
		await api("/order/list_order", {
			body: {
				page_index: pageIndex,
				page_size: pageSize,
				is_paging: true,
				seller_key: "",
				search_key_1: "",
				search_key_2: "",
				shop_key: "",
				order_type: "",
				platform_status: "",
				from,
				to,
				purchase_sn: "",
				time_type: "create_time",
				is_sn_like: false,
				__keyword_type: "sns_key_1",
				nodis_platform_status: "",
				order_status: "",
				rack_area_id: "",
				warn_filter_type: null,
				expire_hour: 24,
				is_order_by_ship_deadline_time: false,
				is_group: false,
				sns: orderSns,
				check_miss: false,
				seller_id: await me(),
			},
		}),
	);
}

const paged = async (path: string, pageIndex: number, extra: Record<string, string | number | boolean>) =>
	list(await api(path, { query: { page_index: pageIndex, page_size: 50, is_paging: true, seller_id: await me(), ...extra } }));

export const stock = (pageIndex = 1) =>
	paged("/stock/list_stock", pageIndex, { seller_key: "", shop_key: "", search_key: "", stock_key: "", show_empty: true, is_analyse: false });

export const returns = (pageIndex = 1) =>
	paged("/return_v2/list", pageIndex, { return_status: "", time_type: "get_report_time", ignore_not_match_lose: "1", is_simple: false });

/** 退件在库（上架 shelf、分拣中 sorting、已分出 sort_out）的一页，按时间（秒）筛 */
export const putaway = (status: "shelf" | "sorting" | "sort_out", from: number, to: number, pageIndex = 1) =>
	paged("/return_putaway/list", pageIndex, {
		search_keys: "",
		return_status: status,
		time_type: "",
		from,
		to,
		__sku_type: "model_name",
		sort_field: "",
		sort_order: "",
	});

export const returnChanges = (pageIndex = 1) => paged("/return_change/list", pageIndex, {});

export async function balance(from: number, to: number, pageIndex = 1) {
	const id = await me();
	return list(
		await api("/balancelog/list", {
			query: { page_index: pageIndex, page_size: 50, is_paging: true, user_type: "seller", user_id: id, seller_id: id, from, to },
		}),
	);
}

export type Write = { kind: "done"; data: any } | { kind: "refused"; why: string } | { kind: "blocked"; why: string } | { kind: "unknown"; why: string };

/** 「无单号」预报的快递单号：chanboss 页面上的常量（打拣货单时的自动预报就填它），站上存成 reserved 开头的一串 */
export const NO_TRACKING = "reserved";

export async function ordersBySn(sns: string[]): Promise<Map<string, any>> {
	const now = Math.floor(Date.now() / 1000);
	const r = await orders(now - 90 * 86400, now, 1, sns, 100);
	return new Map(r.rows.map((o: any) => [String(o.sn), o]));
}

export type Forecast = {
	orderId: string;
	orderTime: number;
	/** 发货线路（海快 752）、线路、仓库：已预报的订单上是 752、1111、5176 */
	sendwayId: number;
	lineId: number;
	warehouseId: number;
	/** 每个规格一行：platformModelId 是 Shopee 的规格 id，modelId 是 chanboss 的；trackNum 是快递单号，无单号填 NO_TRACKING */
	lines: { platformModelId: string; modelId: string; count: number; trackNum: string }[];
};

/** 预报一张订单（/pack/add_report_new）。请求体照 chanboss 页面的 JS 拼（2026-10-09 读的：打拣货单时的「自动预报」和批量预报对话框，见同目录的 NOTES.md） */
export async function forecast(f: Forecast): Promise<Write> {
	const b = await call("/pack/add_report_new", {
		body: {
			report_type: "order",
			warehouse_id: f.warehouseId,
			line_id: f.lineId,
			sendway_id: f.sendwayId,
			order_id: f.orderId,
			order_time: f.orderTime,
			consumable_list: [],
			detail: f.lines.map((l) => ({
				type: "express",
				depend_id: l.platformModelId,
				model_id: l.modelId,
				note: "",
				track_num: l.trackNum,
				purchase_price: 0,
				express_code_type: 0,
				purchase_sn: "",
				count: l.count,
			})),
		},
	});
	if (b?.unknown) return { kind: "unknown", why: b.unknown };
	if (signedOut(b)) return { kind: "blocked", why: "chanboss 没有登录" };
	return Number(b?.code) === 10000 ? { kind: "done", data: b.data } : { kind: "refused", why: `${b?.code}：${b?.message ?? ""}` };
}
