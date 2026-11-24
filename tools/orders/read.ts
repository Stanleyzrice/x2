// 现读：x2 status 每次经浏览器把要用的站点数据读进内存，不存库（只有订单写回库，给网页上看进度）。
// 采购现读 Shopee 待出货订单；每个登录着的 1688 账号的购物车、采购单（带物流、进行中的退款）。
// 哪一样读不了就记下来（results）：检查照常算，x2 status 说哪样没读成（漏读不算做完）。
// 同一个进程里 2 分钟内读过的复用（一批几项加购、x2 orders source 找完再检查，不用每次整套重读：1688 对频率敏感，读多了弹滑块）

import { type BuyerOrder, buyerOrders, type Refund, cart as readCart, refund as readRefund, traces } from "../../connectors/sites/1688/api.ts";
import { ChanbossOrderId, type Order } from "../../connectors/sites/chanboss/api.ts";
import { inAccount, logins } from "../../platform/browser/browser.ts";
import type { Sql } from "../../platform/db/index.ts";
import { NeedsHuman } from "../../platform/errors.ts";
import { configuredWorkspaces, type Read } from "../../platform/tool.ts";
import type { CartLine, Purchase } from "./allocate.ts";
import { type KnownOrderDate, type OrderDateRange, orderBounds, readShopeeOrders, shopeeOrderRow } from "./shopee.ts";
import { refreshChosen } from "./source.ts";

/** chanboss 状态：站上的代码 → chanboss 的词。paid、arrive 是推断的（2026-10-09 没有这两种状态的订单可核对） */
export const CHANBOSS_STATUS: Record<string, string> = {
	paid: "待处理",
	pre_report: "已预报",
	arrive: "已到齐",
	packaged: "已打包",
	delivery: "已出库",
	other: "其他",
};

export const PLATFORM_STATUS: Record<string, string> = {
	UNPAID: "待付款",
	READY_TO_SHIP: "待出货",
	PROCESSED: "待出货",
	RETRY_SHIP: "待出货",
	SHIPPED: "已出货",
	TO_CONFIRM_RECEIVE: "已出货",
	COMPLETED: "已完成",
	IN_CANCEL: "取消中",
	CANCELLED: "不成立",
	TO_RETURN: "退货退款",
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
export function orderRow(r: Order) {
	const items: Item[] = (r.item_detail_new ?? []).map((i) => ({
		itemId: String(i.platform_item_id ?? ""),
		modelId: String(i.platform_model_id ?? ""),
		chanbossModelId: String(i.model_id ?? ""),
		name: String(i.item_name ?? ""),
		spec: String(i.model_name ?? ""),
		qty: Number(i.count ?? 0),
		image: String(i.image ?? ""),
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
		chanboss_id: ChanbossOrderId.parse(String(r.id)),
		chanboss_time: Number(r.platform_create_time ?? 0),
		items,
		items_text: items.map((i) => `${i.name} / ${i.spec || "（单规格）"} × ${i.qty}`).join("\n"),
		problem: Number(r.problem) ? r.problem_note || `问题（${r.problem_type}）` : null,
		cancelled_at: platform === "CANCELLED" ? time(r.cancel_time) : null,
	};
}

export const signedOf = (status: string) => /签收/.test(status);

export async function readPurchases(account: string, pages = 3): Promise<Purchase[]> {
	return inAccount("1688", account, async () => {
		const byId = new Map<string, BuyerOrder>();
		for (let n = 1; n <= pages; n++) {
			const r = await buyerOrders(n);
			for (const o of r.rows) byId.set(o.orderId, o);
			if (n >= r.pages || r.rows.length === 0) break;
		}
		for (const o of (await buyerOrders(1, 50, "dispute")).rows) byId.set(o.orderId, o);
		const orders = [...byId.values()];
		const shipped = orders.filter((o) => o.items.some((i) => i.trackingNo));
		const trace = new Map(
			(await traces(shipped.map((o) => ({ orderId: o.orderId, trackingNos: o.items.map((i) => i.trackingNo).filter(Boolean) })))).map((t) => [t.orderId, t]),
		);
		const refunds = new Map<string, Refund>();
		for (const i of orders.flatMap((o) => o.items)) {
			if (!i.refund || i.refund.status === "refundsuccess" || i.refund.status === "refundclose" || refunds.has(i.refund.id)) continue;
			await sleep(1500);
			refunds.set(i.refund.id, await readRefund(i.refund.id, i.refund.stage));
		}
		return orders.flatMap((o) =>
			o.items.map((i): Purchase => {
				const logistics = trace.get(o.orderId)?.traces.find((x) => x.trackingNo === i.trackingNo)?.status ?? null;
				const r = i.refund ? refunds.get(i.refund.id) : undefined;
				return {
					account,
					orderId: o.orderId,
					offerId: i.offerId,
					// 每一行自带 skuId（2026-10-09 核对过）；只有一个规格的货源没有，用货源 id
					offerSkuId: i.skuId || (i.specId ? null : i.offerId),
					qty: i.quantity,
					createdAt: date(o.createdAt),
					paidAt: date(o.paidAt),
					status: i.status || o.status,
					toChanboss: false,
					trackingNo: i.trackingNo || null,
					signed: i.status === "success" || i.received >= i.quantity || (logistics !== null && signedOf(logistics)),
					refund: i.refund
						? {
								status: r?.status ?? i.refund.status,
								label: r?.statusLabel ?? (i.refund.status === "refundsuccess" ? "退款成功" : i.refund.status === "refundclose" ? "退款关闭" : "退款中"),
								kind: r?.kind ?? null,
							}
						: null,
				};
			}),
		);
	});
}

export async function buyAccount(sql: Sql): Promise<{ userId: string; loginId: string } | null> {
	const [s] = await sql`select buy_account from order_settings where id = 1`;
	const name = s?.buy_account as string | null;
	if (!name) return null;
	return inAccount("1688", name, async (account) => ({ userId: account.id, loginId: account.name }));
}

export type Reads = {
	unreadSince?: number | null;
	cart: CartLine[];
	purchases: Purchase[];
	accounts: Map<string, string>;
	buyAccount: string | null;
	results: Read[];
};

const REUSE_MS = 2 * 60_000;
const memo = new Map<string, { at: number; value: Promise<unknown> }>();
const fresh = (key: string, maxAge: number) => {
	const m = memo.get(key);
	return m && (m.at === Infinity || Date.now() - m.at < maxAge) ? m : null;
};

export function reuse<T>(key: string, fn: () => Promise<T>, maxAge = REUSE_MS): Promise<T> {
	const m = fresh(key, maxAge);
	if (m) return m.value as Promise<T>;
	const value = fn();
	const entry = { at: Infinity, value };
	memo.set(key, entry);
	void value.then(
		() => {
			entry.at = Date.now();
		},
		() => {
			if (memo.get(key) === entry) memo.delete(key);
		},
	);
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

export async function readAll(
	sql: Sql,
	log: (s: string) => void = console.error,
	shops = configuredOrderShops(),
	range?: OrderDateRange,
	force = false,
): Promise<Reads> {
	const results: Read[] = [];
	const bounds = orderBounds(range);
	const ordersKey = `Shopee订单:${JSON.stringify([[...shops].sort(), range])}`;
	log(`读 Shopee 待出货订单${again(ordersKey)}`);
	const orders = await attempt(
		results,
		"订单",
		"shopee",
		() => reuse(ordersKey, () => writeOrders(sql, shops, range), force ? 0 : REUSE_MS),
		(read) => read.count,
	);
	const toBuy = (
		await sql`select distinct i->>'itemId' as id from orders o, jsonb_array_elements(o.items) i where o.order_source = 'shopee' and o.procurement_eligible and o.platform_status = '待出货' and o.shop in ${sql(shops)} and (${bounds?.start ?? null}::timestamptz is null or created_at >= ${bounds?.start ?? null} and created_at < ${bounds?.end ?? null})`
	).map((r) => r.id as string);
	if (toBuy.length) {
		const key = `货源:${[...toBuy].sort().join(",")}`;
		log(`读要买的商品的货源（${toBuy.length} 个商品）${again(key)}`);
		await attempt(
			results,
			"货源",
			"1688",
			() => reuse(key, () => refreshChosen(sql, toBuy)),
			(n) => n,
		);
	}
	return { ...(await read1688(sql, log, results)), unreadSince: orders?.unreadSince };
}

export async function read1688(sql: Sql, log: (s: string) => void = console.error, results: Read[] = []): Promise<Reads> {
	const accounts = new Map((await logins("1688").catch(() => [])).map((l) => [l.account.id, l.account.name]));
	const buy = await attempt(
		results,
		"采购账号",
		"1688",
		() => buyAccount(sql),
		() => 1,
	);
	if (buy) accounts.set(buy.userId, buy.loginId);
	const cart: CartLine[] = [],
		purchases: Purchase[] = [];
	for (const [userId, loginId] of accounts) {
		log(`读 1688 ${loginId} 的购物车、采购单${again(`采购单:${userId}`)}`);
		const c = await attempt(
			results,
			"购物车",
			userId,
			() => reuse(`购物车:${userId}`, () => inAccount("1688", userId, () => readCart())),
			(v) => v.length,
		);
		if (c) cart.push(...c.map((l) => ({ account: userId, offerId: l.offerId, skuId: l.skuId, qty: l.quantity })));
		const p = await attempt(
			results,
			"采购单",
			userId,
			() => reuse(`采购单:${userId}`, () => readPurchases(userId)),
			(v) => v.length,
		);
		if (p) purchases.push(...p);
	}
	return { cart, purchases, accounts, buyAccount: buy?.userId ?? null, results };
}

export function configuredOrderShops(): string[] {
	const shops = [
		...new Set(
			configuredWorkspaces()
				.filter((w) => w.component === "procurement")
				.flatMap((w) => (Array.isArray(w.props.shops) ? w.props.shops.filter((shop): shop is string => typeof shop === "string" && Boolean(shop)) : [])),
		),
	];
	if (!shops.length) throw new NeedsHuman("没有配置用于采购的 Shopee 店铺");
	return shops;
}

/** 只有完整成功的 Shopee 待出货列表重新开放采购；读取失败或列表中消失的旧行保留历史，但不可继续加购。 */
export async function writeOrders(sql: Sql, shops = configuredOrderShops(), range?: OrderDateRange) {
	const bounds = orderBounds(range);
	const excluded: { sn: string; status: string; reason: string }[] = [];
	let count = 0;
	let unreadSince: number | null = null;
	for (const shop of [...new Set(shops)]) {
		await sql`update orders set procurement_eligible = false where shop = ${shop} and order_source = 'shopee' and (${bounds?.start ?? null}::timestamptz is null or created_at >= ${bounds?.start ?? null} and created_at < ${bounds?.end ?? null})`;
		const known = range
			? await sql<KnownOrderDate[]>`select shopee_order_id as "orderId", shop_id as "shopId", sn, created_at as "createdAt"
			from orders where shop = ${shop} and order_source = 'shopee' and shopee_order_id is not null and created_at is not null`
			: [];
		const read = await readShopeeOrders(shop, range, known);
		if (read.unreadSince !== null) unreadSince = Math.min(unreadSince ?? Infinity, read.unreadSince);
		const rows = read.orders.map((order) => {
			const row = shopeeOrderRow(order, shop);
			if (!row.procurement_eligible) {
				const status = [...new Set([order.status, ...(order.packageStatuses ?? [])].map((s) => s.trim() || "未提供"))].join(" / ");
				excluded.push({ sn: row.sn, status, reason: row.platform_status });
			}
			return row;
		});
		await sql.begin(async (tx) => {
			await tx`update orders set procurement_eligible = false, shopee_sync_at = now() where shop = ${shop} and order_source = 'shopee' and (${bounds?.start ?? null}::timestamptz is null or created_at >= ${bounds?.start ?? null} and created_at < ${bounds?.end ?? null})`;
			for (const { items, ...row } of rows) {
				const [existing] = await tx<{ shop_id: string | null }[]>`select shop_id from orders where sn = ${row.sn} for update`;
				if (existing?.shop_id && existing.shop_id !== read.shopId) throw new Error(`订单 ${row.sn} 的历史店铺身份不符，停止同步`);
				await tx`insert into orders ${tx({ ...row, items: tx.json(items), shopee_sync_at: new Date() })}
					on conflict (sn) do update set shop = excluded.shop, shop_id = excluded.shop_id,
					order_source = excluded.order_source, shopee_order_id = excluded.shopee_order_id, shopee_status = excluded.shopee_status,
					procurement_eligible = excluded.procurement_eligible, shopee_sync_at = excluded.shopee_sync_at,
					created_at = excluded.created_at, ship_by = excluded.ship_by, platform_status = excluded.platform_status,
					items = excluded.items, items_text = excluded.items_text,
					step = case when orders.order_source is distinct from excluded.order_source or orders.items is distinct from excluded.items
						or orders.platform_status is distinct from excluded.platform_status then null else orders.step end,
					step_detail = case when orders.order_source is distinct from excluded.order_source or orders.items is distinct from excluded.items
						or orders.platform_status is distinct from excluded.platform_status then null else orders.step_detail end`;
			}
		});
		count += rows.length;
	}
	return { count, excluded, unreadSince };
}
