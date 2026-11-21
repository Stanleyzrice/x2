// 订单提醒直接读取 Shopee；开始采购时另读采购事实，预览和确认都校验同一份完整订单，结果未知只查询原确认记录。
import { z } from "zod";
import { OrderSn } from "../../connectors/sites/shopee/seller.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { parseJson } from "../../platform/tool.ts";
import type { Outcome, Ran } from "../../platform/writes.ts";
import { refreshAccount } from "../reimbursement/index.ts";
import { checkOrders } from "./check.ts";
import {
	assertProcurementAvailable,
	type EvidenceCatalog,
	type EvidenceListing,
	type EvidenceSource,
	procurementTarget,
	readPurchaseEvidence,
	summarizePurchase,
} from "./procurement-evidence.ts";
import { type ProcurementItem, procurementLines } from "./procurement-items.ts";
import { type MatchNeed, matchProcurement } from "./procurement-matches.ts";
import { purchaseState, samePurchase, selectPurchase } from "./purchase.ts";
import { buyAccount, readAll, reuse, writeOrders } from "./read.ts";
import { snapshot } from "./status.ts";
import { cartParams } from "./writes.ts";

export const monitorParams = z.object({
	shops: z
		.preprocess(parseJson, z.array(z.string().min(1)).min(1).max(100))
		.default(["cheeroutdoor"])
		.describe("店铺数组，命令行用 JSON"),
});
export const selectionParams = monitorParams.extend({
	orders: z.preprocess(parseJson, z.array(OrderSn).min(1).max(200)).describe("所选 Shopee 订单号数组，命令行用 JSON"),
	requestId: z.string().uuid(),
});
export const purchaseParams = selectionParams.extend({
	items: z.preprocess(parseJson, z.array(cartParams).min(1)).describe("采购预览返回的规格和数量，命令行用 JSON"),
});

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
async function refreshPurchases(sql: Sql): Promise<void> {
	const account = await buyAccount(sql);
	if (!account) throw new Error("请先配置 1688 采购账号");
	const result = await refreshAccount(sql, { id: account.userId, name: account.loginId });
	if (result.status !== "succeeded") throw new Error(result.error ?? "1688 采购订单仍在同步，保留上次成功快照");
}

export async function monitor(sql: Sql, shops: string[]) {
	const [rows, historical, evidence] = await Promise.all([
		sql<MonitorRow[]>`select o.sn, o.shop, o.shop_id, o.created_at, o.ship_by, o.items, o.items_text, o.step,
		exists (select 1 from writes w, jsonb_array_elements(w.params->'lines') l where w.op = '加购'
			and w.status in ('待执行', '已提交', '结果未知', '不一致') and l->>'sn' = o.sn) as cart_pending,
		exists (select 1 from writes w, jsonb_array_elements(w.params->'lines') l where w.op = '加购'
			and w.status in ('成功', '已核对') and l->>'sn' = o.sn) as cart_done
		from orders o where o.shop in ${sql(shops)} and o.order_source = 'shopee' and o.procurement_eligible and o.platform_status = '待出货'
		order by o.created_at desc nulls last, o.sn desc`,
		// 其他店铺及已履约需求一起分配数量，不能把以前已购买的件数重新分给当前待采购订单。
		sql<MonitorRow[]>`select o.sn, o.shop, o.shop_id, o.created_at, o.ship_by, o.items, o.items_text, o.step,
		false as cart_pending, false as cart_done from orders o where o.order_source = 'shopee'
		and o.platform_status in ('待出货', '已出货', '已完成', '退货退款')`,
		readPurchaseEvidence(sql),
	]);
	const demands = [...new Map([...historical, ...rows].map((row) => [row.sn, row])).values()];
	const itemIds = [...new Set(demands.flatMap((row) => row.items.map((item) => item.itemId)))];
	const demandShops = [...new Set(demands.map((row) => row.shop))];
	// 两类已有货源索引互不依赖，并发读取，首屏不等待外站同步。
	const [sources, listings, catalog] = await Promise.all([
		itemIds.length
			? sql<EvidenceSource[]>`select item_id as "itemId", offer_id as "offerId", title, item_image as "itemImage", broken, skus, sku_exceptions as exceptions
			from sources where site = '1688' and chosen and item_id in ${sql(itemIds)}`
			: [],
		itemIds.length
			? sql<EvidenceListing[]>`select l.shop, s.shop_id as "shopId", l.product_id as "productId", l.offer_id as "offerId", l.title, l.variants,
			jsonb_build_object('offerId', l.offer->'offerId', 'skus', l.offer->'skus') as offer
			from listings l join shop_settings s on s.shop = l.shop
			where l.shop in ${sql(demandShops)} and l.product_id in ${sql(itemIds)} and not l.cancelled`
			: [],
		itemIds.length
			? sql<EvidenceCatalog[]>`select p.shop, p.shop_id as "shopId", p.product_id as "productId", p.models
			from catalog_products p join catalog_heads h on h.shop = p.shop and h.shop_id = p.shop_id and h.revision = p.revision
			where p.shop in ${sql(demandShops)} and p.product_id in ${sql(itemIds)}`
			: [],
	]);
	const needs: MatchNeed[] = demands.flatMap((row) =>
		row.items.map((item) => ({
			sn: row.sn,
			modelId: item.modelId,
			qty: item.qty,
			createdAt: row.created_at?.toISOString() ?? null,
			offerIds: [
				...new Set([
					...sources.filter((source) => source.itemId === item.itemId).map((source) => source.offerId),
					...listings
						.filter((listing) => listing.shop === row.shop && listing.shopId === row.shop_id && listing.productId === item.itemId)
						.map((listing) => listing.offerId),
				]),
			].filter((offerId) => /^\d+$/.test(offerId)),
			...procurementTarget({ shop: row.shop, shopId: row.shop_id }, item, sources, listings, catalog),
		})),
	);
	const matches = matchProcurement(needs, evidence.records, evidence.coverage);
	const sync = syncs.get(sql)?.get(scopeKey(shops));
	return {
		checkedAt: sync?.at ?? null,
		error: sync?.error ?? null,
		purchases: evidence.coverage,
		orders: rows.map((r) => {
			const lines = procurementLines({ shop: r.shop, shopId: r.shop_id, items: r.items }, sources, listings).map((line) => ({
				...line,
				purchase: matches.get(`${r.sn}:${line.modelId}`)!,
			}));
			const purchase = summarizePurchase(lines.map((line) => line.purchase));
			return {
				sn: r.sn,
				shop: r.shop,
				createdAt: r.created_at?.toISOString() ?? null,
				shipBy: r.ship_by?.toISOString() ?? null,
				items: r.items_text ?? "",
				lines,
				purchase,
				step: purchase.label,
				cartPending: r.cart_pending,
				cartDone: r.cart_done,
			};
		}),
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
				await refreshPurchases(sql);
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
	await refreshPurchases(sql);
	const latest = await monitor(sql, p.shops);
	assertProcurementAvailable(latest.orders, p.orders);
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
