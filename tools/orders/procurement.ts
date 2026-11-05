// 订单提醒直接读取 Shopee；开始采购时另读采购事实，预览和确认都校验同一份完整订单，结果未知只查询原确认记录。
import { z } from "zod";
import { OrderSn } from "../../connectors/sites/shopee/seller.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import type { Outcome, Ran } from "../../platform/writes.ts";
import { checkOrders } from "./check.ts";
import { type ProcurementItem, type ProcurementListingRow, type ProcurementSourceRow, procurementLines } from "./procurement-items.ts";
import { purchaseState, samePurchase, selectPurchase } from "./purchase.ts";
import { readAll, reuse, writeOrders } from "./read.ts";
import { snapshot } from "./status.ts";
import { cartParams } from "./writes.ts";

export const monitorParams = z.object({ shops: z.array(z.string().min(1)).min(1).max(100).default(["cheeroutdoor"]) });
export const selectionParams = monitorParams.extend({ orders: z.array(OrderSn).min(1).max(200), requestId: z.string().uuid() });
export const purchaseParams = selectionParams.extend({ items: z.array(cartParams).min(1) });

type MonitorRow = {
	sn: string;
	shop: string;
	shop_id: string;
	created_at: Date | null;
	ship_by: Date | null;
	items_text: string | null;
	items: ProcurementItem[];
	step: string | null;
	cart_pending: boolean;
	cart_done: boolean;
};
const syncs = new WeakMap<Sql, Map<string, { at: string | null; error: string | null }>>();
const scopeKey = (shops: string[]) => JSON.stringify([...new Set(shops)].sort());
export async function monitor(sql: Sql, shops: string[]) {
	const rows = await sql<MonitorRow[]>`select o.sn, o.shop, o.shop_id, o.created_at, o.ship_by, o.items, o.items_text, o.step,
		exists (select 1 from writes w, jsonb_array_elements(w.params->'lines') l where w.op = '加购'
			and w.status in ('待执行', '已提交', '结果未知', '不一致') and l->>'sn' = o.sn) as cart_pending,
		exists (select 1 from writes w, jsonb_array_elements(w.params->'lines') l where w.op = '加购'
			and w.status in ('成功', '已核对') and l->>'sn' = o.sn) as cart_done
		from orders o where o.shop in ${sql(shops)} and o.order_source = 'shopee' and o.procurement_eligible and o.platform_status = '待出货'
		order by o.created_at desc nulls last, o.sn desc`;
	const itemIds = [...new Set(rows.flatMap((row) => row.items.map((item) => item.itemId)))];
	const sources = itemIds.length
		? await sql<ProcurementSourceRow[]>`select item_id as "itemId", offer_id as "offerId", title, item_image as "itemImage", broken
			from sources where site = '1688' and chosen and item_id in ${sql(itemIds)}`
		: [];
	const listings = itemIds.length
		? await sql<ProcurementListingRow[]>`select l.shop, s.shop_id as "shopId", l.product_id as "productId", l.offer_id as "offerId", l.title
			from listings l join shop_settings s on s.shop = l.shop
			where l.shop in ${sql(shops)} and l.product_id in ${sql(itemIds)} and not l.cancelled`
		: [];
	const sync = syncs.get(sql)?.get(scopeKey(shops));
	return {
		checkedAt: sync?.at ?? null,
		error: sync?.error ?? null,
		orders: rows.map((r) => ({
			sn: r.sn,
			shop: r.shop,
			createdAt: r.created_at?.toISOString() ?? null,
			shipBy: r.ship_by?.toISOString() ?? null,
			items: r.items_text ?? "",
			lines: procurementLines({ shop: r.shop, shopId: r.shop_id, items: r.items }, sources, listings),
			step: r.cart_pending ? "加购待核对" : r.cart_done ? "已加购，请核对购物车" : (r.step ?? "待采购检查"),
			cartPending: r.cart_pending,
			cartDone: r.cart_done,
		})),
	};
}

export async function syncMonitor(sql: Sql, shops: string[]) {
	const key = scopeKey(shops);
	const states = syncs.get(sql) ?? new Map<string, { at: string | null; error: string | null }>();
	syncs.set(sql, states);
	try {
		const at = await reuse(
			`procurement-monitor:${key}`,
			async () => {
				await writeOrders(sql, shops);
				return new Date().toISOString();
			},
			60_000,
		);
		states.set(key, { at, error: null });
	} catch (e) {
		states.set(key, { at: states.get(key)?.at ?? null, error: (e as Error).message });
	}
	return monitor(sql, shops);
}

async function selected(sql: Sql, p: z.infer<typeof selectionParams>) {
	await writeOrders(sql, p.shops);
	const reads = await readAll(sql, undefined, p.shops);
	const bad = reads.results.find((r) => !r.ok);
	if (bad) throw new Usage(`${bad.what}读取失败，停止采购以避免重复：${bad.error ?? "未知原因"}`);
	const state = await snapshot(sql, reads);
	return selectPurchase(state, checkOrders(state), p.orders, p.shops);
}

export async function purchasePreview(sql: Sql, p: z.infer<typeof selectionParams>) {
	const items = await selected(sql, p);
	const total = items.reduce((sum, row) => sum + (row.price ?? Number.NaN) * row.qty, 0);
	return {
		params: { ...p, items },
		display: [
			`向 1688 采购账号 ${items[0]!.account} 的购物车加入以下商品：`,
			...items.map(
				(row) =>
					`${row.title} / ${row.sku} × ${row.qty}（${row.price === null ? "单价未知" : `¥${row.price}`}；订单 ${row.lines.map((l) => `${l.sn} × ${l.qty}`).join("、")}）`,
			),
			Number.isNaN(total) ? "商品金额未知" : `预计商品金额 ¥${total.toFixed(2)}（不含运费，以 1688 为准）`,
			"加入购物车后，由你在 1688 核对并付款下单。",
		].join("\n"),
	};
}

export async function planPurchase(sql: Sql, p: z.infer<typeof purchaseParams>) {
	const items = await selected(sql, p);
	if (!samePurchase(items, p.items)) throw new Usage("订单数量、货源、价格或采购账号已变化，请重新查看采购预览");
	return [p.items.map((params) => ({ op: "加购", params }))];
}

export async function purchaseResult(sql: Sql, shops: string[], requestId: string) {
	const [r] = await sql<
		{ state: string; outcome: Outcome | null; params: z.infer<typeof purchaseParams>; created_at: Date; expires_at: Date }[]
	>`select state, outcome, params, created_at, expires_at from web_confirmations
		where tool = 'orders.purchase' and params->>'requestId' = ${requestId} order by created_at desc limit 1`;
	if (!r) return { state: "not-found", outcome: null };
	if (JSON.stringify(r.params.shops) !== JSON.stringify(shops)) throw new Usage("采购请求不在当前店铺范围");
	if (r.state === "prepared") return { state: r.expires_at <= new Date() ? "expired" : "prepared", outcome: null };
	// 读回只查此预览之后、精确规格和订单行对应的写入；核对完成后能解除页面等待，不会重新提交。
	const writes = await Promise.all(
		r.params.items.map(async (item) => {
			const [row] = await sql<(Ran & { error: string | null })[]>`select id::text, batch::text, op, display, status, error from writes
			where op = '加购' and created_at >= ${r.created_at} and params->>'offerId' = ${item.offerId} and params->>'skuId' = ${item.skuId}
			and params->'lines' = ${sql.json(item.lines)} and params->>'account' is not distinct from ${item.account ?? null}
			and params->>'qty' = ${String(item.qty)} order by id desc limit 1`;
			return row;
		}),
	);
	const ran = writes.flatMap((row) =>
		row ? [{ id: row.id, batch: row.batch, op: row.op, display: row.display, status: row.status, ...(row.error ? { why: row.error } : {}) }] : [],
	);
	const state = purchaseState(
		r.state,
		writes.map((row) => row?.status),
	);
	return { state, outcome: { ran, unknown: state !== "completed", blocked: r.outcome?.blocked ?? null } };
}
