// 现读：x2 status 每次经浏览器把要用的站点数据读进内存，不存库（只有订单写回库，给网页上看进度）。
// 读什么：chanboss 的订单（两家店都在）；每个登录着的 1688 账号的购物车、采购单（带物流、进行中的退款）。
// 哪一样读不了就记下来（results）：检查照常算，x2 status 说哪样没读成（漏读不算做完）。
// 同一个进程里 2 分钟内读过的复用（一批几项加购、x2 orders source 找完再检查，不用每次整套重读：1688 对频率敏感，读多了弹滑块）

import { type BuyerOrder, buyerOrders, type Refund, cart as readCart, refund as readRefund, traces } from "../../connectors/sites/1688/api.ts";
import { orders as chanbossOrders } from "../../connectors/sites/chanboss/api.ts";
import { challengeIn, inAccount, logins } from "../../platform/browser/accounts.ts";
import type { Sql } from "../../platform/db/index.ts";
import { NeedsHuman } from "../../platform/errors.ts";
import type { Read } from "../../platform/tool.ts";
import type { CartLine, Purchase } from "./reconcile.ts";
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
export function orderRow(r: any) {
	const items: Item[] = ((r.item_detail_new ?? []) as any[]).map((i) => ({
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
		chanboss_id: String(r.id),
		chanboss_time: Number(r.platform_create_time ?? 0),
		items,
		items_text: items.map((i) => `${i.name} / ${i.spec || "（单规格）"} × ${i.qty}`).join("\n"),
		problem: Number(r.problem) ? String(r.problem_note || `问题（${r.problem_type}）`) : null,
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
	const a = (await logins("1688")).find((x) => x.account.name === name || x.account.id === name);
	if (!a) throw (await challengeIn("1688")) ?? new NeedsHuman(`采购账号「${name}」没有登录：在浏览器里登录这个 1688 账号，确认 cdp-relay 扩展已连接`);
	return { userId: a.account.id, loginId: a.account.name };
}

export type Reads = {
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
	return m && Date.now() - m.at < maxAge ? m : null;
};

export function reuse<T>(key: string, fn: () => Promise<T>, maxAge = REUSE_MS): Promise<T> {
	const m = fresh(key, maxAge);
	if (m) return m.value as Promise<T>;
	const value = fn();
	memo.set(key, { at: Date.now(), value });
	value.catch(() => {
		if (memo.get(key)?.value === value) memo.delete(key);
	});
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

export async function readAll(sql: Sql, log: (s: string) => void = console.error): Promise<Reads> {
	const results: Read[] = [];
	log(`读 chanboss 订单${again("订单")}`);
	await attempt(
		results,
		"订单",
		"chanboss",
		() => reuse("订单", () => writeOrders(sql)),
		(n) => n,
	);
	const toBuy = (
		await sql`select distinct i->>'itemId' as id from orders o, jsonb_array_elements(o.items) i where o.platform_status = '待出货' and o.chanboss_status = '待处理'`
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
	return read1688(sql, log, results);
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

async function writeOrders(sql: Sql): Promise<number> {
	const to = Math.floor(Date.now() / 1000),
		from = to - 60 * 86400;
	const raw: any[] = [];
	for (let n = 1; ; n++) {
		const page = await chanbossOrders(from, to, n);
		raw.push(...page.rows);
		if (n >= page.pageCount || page.rows.length === 0) break;
	}
	const names = await logins("shopee")
		.then((all) => new Map(all.map((l) => [l.account.id, l.account.name])))
		.catch(() => new Map<string, string>());
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
