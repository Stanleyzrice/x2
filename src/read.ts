// 现读：x2 status 每次经浏览器把要用的站点数据读进内存，不存库（只有订单写回库，给 NocoDB 里看进度）。
// 读什么：chanboss 的订单（两家店都在）；每个登录着的 1688 账号的购物车、采购单（带物流、进行中的退款）。
// 哪一样读不了就记下来（results）：检查照常算，靠它关的收件箱这一轮不关（漏读不算做完）。
// 同一个进程里 2 分钟内读过的复用（x2 run 一批几项加购、x2 source 找完再检查，不用每次整套重读：1688 对频率敏感，读多了弹滑块）
import { alibabaAccounts, buyAccount, in1688, shopNames } from "./accounts.ts";
import type { CartLine, Purchase } from "./check/reconcile.ts";
import { type Sql } from "./db/index.ts";
import { NeedsHuman } from "./errors.ts";
import { type BuyerOrder, buyerOrders, cart as readCart, type Refund, refund as readRefund, traces } from "./site/1688.ts";
import { orders as chanbossOrders } from "./site/chanboss.ts";
import { refreshChosen } from "./source.ts";

/** chanboss 状态：站上的代码 → chanboss 的词。paid、arrive 是推断的（2026-10-09 没有这两种状态的订单可核对） */
export const CHANBOSS_STATUS: Record<string, string> = { paid: "待处理", pre_report: "已预报", arrive: "已到齐", packaged: "已打包", delivery: "已出库", other: "其他" };

/** 平台状态：chanboss 转来的 Shopee 订单状态 → Shopee 的词 */
export const PLATFORM_STATUS: Record<string, string> = {
	UNPAID: "待付款", READY_TO_SHIP: "待出货", PROCESSED: "待出货", RETRY_SHIP: "待出货",
	SHIPPED: "已出货", TO_CONFIRM_RECEIVE: "已出货", COMPLETED: "已完成", IN_CANCEL: "取消中", CANCELLED: "不成立", TO_RETURN: "退货退款",
};

export type Item = { itemId: string; modelId: string; chanbossModelId: string; name: string; spec: string; qty: number; image: string };

const time = (seconds: unknown) => (Number(seconds) > 0 ? new Date(Number(seconds) * 1000) : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 1688 的时间：毫秒数或日期字符串；认不出是 null */
const date = (v: unknown) => {
	if (v === null || v === undefined || v === "") return null;
	const d = new Date(/^\d+$/.test(String(v)) ? Number(v) : String(v));
	return Number.isNaN(d.getTime()) ? null : d;
};

/** chanboss 订单列表的一行 → orders 的一行。只有一个规格的商品，chanboss 的 platform_model_id 是商品 id */
export function orderRow(r: any) {
	const items: Item[] = ((r.item_detail_new ?? []) as any[]).map((i) => ({
		itemId: String(i.platform_item_id ?? ""), modelId: String(i.platform_model_id ?? ""), chanbossModelId: String(i.model_id ?? ""),
		name: String(i.item_name ?? ""), spec: String(i.model_name ?? ""), qty: Number(i.count ?? 0), image: String(i.image ?? ""),
	}));
	const platform = String(r.platform_status ?? "");
	return {
		sn: String(r.sn),
		shop_id: String(r.platform_shop_id ?? ""),
		shop_name: String(r.shop_name ?? ""),
		created_at: time(r.platform_create_time),
		ship_by: time(r.ship_deadline_time),
		platform_status: PLATFORM_STATUS[platform] ?? platform,
		chanboss_status: CHANBOSS_STATUS[String(r.status)] ?? String(r.status ?? ""),
		chanboss_id: String(r.id),
		chanboss_time: Number(r.platform_create_time ?? 0),
		items,
		items_text: items.map((i) => `${i.name} / ${i.spec || "（单规格）"} × ${i.qty}`).join("\n"),
		problem: Number(r.problem) ? String(r.problem_note || `问题（${r.problem_type}）`) : null,
		cancelled_at: platform === "CANCELLED" ? time(r.cancel_time) : null,
	};
}

/** 1688 的物流状态里有「签收」就算签收了 */
export const signedOf = (status: string) => /签收/.test(status);

/** 一个 1688 账号的采购单（最近 pages 页 + 「退款售后」里更早的）→ 采购单分给订单用的行。有进行中退款的行再读退款详情 */
export async function readPurchases(account: string, pages = 3): Promise<Purchase[]> {
	return in1688(account, async () => {
		const byId = new Map<string, BuyerOrder>();
		for (let n = 1; n <= pages; n++) {
			const r = await buyerOrders(n);
			for (const o of r.rows) byId.set(o.orderId, o);
			if (n >= r.pages || r.rows.length === 0) break;
		}
		for (const o of (await buyerOrders(1, 50, "dispute")).rows) byId.set(o.orderId, o);
		const orders = [...byId.values()];
		const shipped = orders.filter((o) => o.items.some((i) => i.trackingNo));
		const trace = new Map((await traces(shipped.map((o) => ({ orderId: o.orderId, trackingNos: o.items.map((i) => i.trackingNo).filter(Boolean) })))).map((t) => [t.orderId, t]));
		const refunds = new Map<string, Refund>();
		for (const i of orders.flatMap((o) => o.items)) {
			if (!i.refund || i.refund.status === "refundsuccess" || i.refund.status === "refundclose" || refunds.has(i.refund.id)) continue;
			await sleep(1500);
			refunds.set(i.refund.id, await readRefund(i.refund.id, i.refund.stage));
		}
		return orders.flatMap((o) => o.items.map((i): Purchase => {
			const logistics = trace.get(o.orderId)?.traces.find((x) => x.trackingNo === i.trackingNo)?.status ?? null;
			const r = i.refund ? refunds.get(i.refund.id) : undefined;
			return {
				account, orderId: o.orderId, offerId: i.offerId,
				// 每一行自带 skuId（2026-10-09 核对过）；只有一个规格的货源没有，用货源 id
				offerSkuId: i.skuId || (i.specId ? null : i.offerId),
				qty: i.quantity, createdAt: date(o.createdAt), paidAt: date(o.paidAt), status: i.status || o.status,
				// 采购单都寄到 1688 的默认地址，就是我们这里
				toChanboss: false, trackingNo: i.trackingNo || null,
				// 签收了：这一行 1688 上是「已收货」、收够了件，或者物流里有「签收」
				signed: i.status === "success" || i.received >= i.quantity || (logistics !== null && signedOf(logistics)),
				refund: i.refund ? { status: r?.status ?? i.refund.status, label: r?.statusLabel ?? (i.refund.status === "refundsuccess" ? "退款成功" : i.refund.status === "refundclose" ? "退款关闭" : "退款中"), kind: r?.kind ?? null } : null,
			};
		}));
	});
}

export type Read = { what: string; who: string; ok: boolean; rows?: number; error?: string; blocked?: boolean };
export type Reads = {
	cart: CartLine[]; purchases: Purchase[];
	/** 登录着的 1688 账号：userId → 会员名 */
	accounts: Map<string, string>;
	/** 采购账号的 userId（没设是 null） */
	buyAccount: string | null;
	results: Read[];
};

const REUSE_MS = 2 * 60_000;
const memo = new Map<string, { at: number; value: Promise<unknown> }>();
const fresh = (key: string, maxAge: number) => { const m = memo.get(key); return m && Date.now() - m.at < maxAge ? m : null; };

/** 同一个进程里 maxAge 以内读过的（key 一样）复用，不再发请求；读失败的不留，下次再读 */
export function reuse<T>(key: string, fn: () => Promise<T>, maxAge = REUSE_MS): Promise<T> {
	const m = fresh(key, maxAge);
	if (m) return m.value as Promise<T>;
	const value = fn();
	memo.set(key, { at: Date.now(), value });
	value.catch(() => { if (memo.get(key)?.value === value) memo.delete(key); });
	return value;
}
const again = (key: string) => (fresh(key, REUSE_MS) ? "（2 分钟内读过，复用）" : "");

async function attempt<T>(results: Read[], what: string, who: string, fn: () => Promise<T>, rows: (v: T) => number): Promise<T | null> {
	try {
		const v = await fn();
		results.push({ what, who, ok: true, rows: rows(v) });
		return v;
	} catch (e) {
		results.push({ what, who, ok: false, error: (e as Error).message, blocked: e instanceof NeedsHuman });
		return null;
	}
}

/** 现读一遍：chanboss 订单写回 orders（NocoDB 里看进度），要买的商品的货源更新快照，1688 的购物车、采购单留在内存里 */
export async function readAll(sql: Sql, log: (s: string) => void = console.error): Promise<Reads> {
	const results: Read[] = [];
	log(`读 chanboss 订单${again("订单")}`);
	await attempt(results, "订单", "chanboss", () => reuse("订单", () => writeOrders(sql)), (n) => n);
	// 要买的商品（chanboss 上待处理的订单里的）：现读它选用的货源，更新快照，规格才配得准、下架了才知道
	const toBuy = (await sql`select distinct i->>'itemId' as id from orders o, jsonb_array_elements(o.items) i where o.platform_status = '待出货' and o.chanboss_status = '待处理'`).map((r) => r.id as string);
	if (toBuy.length) {
		const key = `货源:${[...toBuy].sort().join(",")}`;
		log(`读要买的商品的货源（${toBuy.length} 个商品）${again(key)}`);
		await attempt(results, "货源", "1688", () => reuse(key, () => refreshChosen(sql, toBuy)), (n) => n);
	}
	return read1688(sql, log, results);
}

/** 1688：每个登录着的账号的购物车、采购单（带物流、进行中的退款）。x2 propose、x2 run 加购前只读这些：订单、货源用库里的 */
export async function read1688(sql: Sql, log: (s: string) => void = console.error, results: Read[] = []): Promise<Reads> {
	const accounts = new Map((await alibabaAccounts().catch(() => [])).map((a) => [a.userId, a.loginId]));
	const buy = await attempt(results, "采购账号", "1688", () => buyAccount(sql), () => 1);
	const cart: CartLine[] = [], purchases: Purchase[] = [];
	for (const [userId, loginId] of accounts) {
		log(`读 1688 ${loginId} 的购物车、采购单${again(`采购单:${userId}`)}`);
		const c = await attempt(results, "购物车", userId, () => reuse(`购物车:${userId}`, () => in1688(userId, () => readCart())), (v) => v.length);
		if (c) cart.push(...c.map((l) => ({ account: userId, offerId: l.offerId, skuId: l.skuId, qty: l.quantity })));
		const p = await attempt(results, "采购单", userId, () => reuse(`采购单:${userId}`, () => readPurchases(userId)), (v) => v.length);
		if (p) purchases.push(...p);
	}
	return { cart, purchases, accounts, buyAccount: buy?.userId ?? null, results };
}

/** chanboss 最近 60 天下单的订单，读全了才整份写进 orders（读到一半出错就不写）。店铺用账号名（登录着的店读得到），读不到用 chanboss 上的店名 */
async function writeOrders(sql: Sql): Promise<number> {
	const to = Math.floor(Date.now() / 1000), from = to - 60 * 86400;
	const raw: any[] = [];
	for (let n = 1; ; n++) {
		const page = await chanbossOrders(from, to, n);
		raw.push(...page.rows);
		if (n >= page.pageCount || page.rows.length === 0) break;
	}
	const names = await shopNames().catch(() => new Map<string, string>());
	const rows = raw.map(orderRow);
	await sql.begin(async (tx) => {
		for (const { shop_name, items, ...o } of rows) {
			await tx`
				insert into orders ${tx({ ...o, shop: names.get(o.shop_id) ?? shop_name, items: tx.json(items) })}
				on conflict (sn) do update set
					shop = excluded.shop, shop_id = excluded.shop_id, created_at = excluded.created_at, ship_by = excluded.ship_by, platform_status = excluded.platform_status,
					chanboss_status = excluded.chanboss_status, chanboss_id = excluded.chanboss_id, chanboss_time = excluded.chanboss_time,
					items = excluded.items, items_text = excluded.items_text, problem = excluded.problem, cancelled_at = excluded.cancelled_at`;
		}
	});
	return rows.length;
}
