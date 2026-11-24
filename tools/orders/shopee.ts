// Shopee 待出货订单读取与完整性校验；列表、详情、店铺身份都对得上才可采购，不借用 Chanboss 状态。
import { z } from "zod";
import { type Order, oneOrder, orderCards, orderIndexPages, TAB } from "../../connectors/sites/shopee/orders.ts";
import { OrderSn, shop as readShop } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import { Usage } from "../../platform/errors.ts";
import { reply } from "../../platform/reply.ts";

export type Ref = { order_id: string | number; shop_id: string | number; region_id?: string | null };
export type ShopeeOrder = Order & { createdAt: Date };
export const orderDateRange = z.object({ from: z.iso.date(), to: z.iso.date() }).refine((r) => r.from <= r.to, "下单起始日不能晚于截止日");
export type OrderDateRange = z.infer<typeof orderDateRange>;
export function orderBounds(range?: OrderDateRange) {
	return range && { start: new Date(`${range.from}T00:00:00+08:00`), end: new Date(Date.parse(`${range.to}T00:00:00+08:00`) + 86_400_000) };
}
export type KnownOrderDate = { orderId: string; shopId: string; sn: string; createdAt: Date };
const detail = z.looseObject({
	order_id: z.union([z.string(), z.number()]),
	order_sn: z.string(),
	shop_id: z.union([z.string(), z.number()]),
	create_time: z.coerce.number().int().positive(),
});
const TO_SHIP = new Set(["to ship", "待出貨", "待出货", "ready_to_ship"]);
const NON_SHIPPING: Record<string, string> = {
	unpaid: "待付款",
	未付款: "待付款",
	待付款: "待付款",
	cancelled: "不成立",
	已取消: "不成立",
	"cancellation requested": "取消中",
	in_cancel: "取消中",
	取消中: "取消中",
	completed: "已完成",
	已完成: "已完成",
	shipped: "已出货",
	已出貨: "已出货",
	运送中: "已出货",
	運送中: "已出货",
};
export function shopeeState(status: string): { eligible: boolean; platformStatus: string } {
	const key = status.trim().toLowerCase();
	if (TO_SHIP.has(key)) return { eligible: true, platformStatus: "待出货" };
	return { eligible: false, platformStatus: Object.hasOwn(NON_SHIPPING, key) ? NON_SHIPPING[key]! : "状态待核对" };
}

export function validateIndexPage(total: number, refs: Ref[], shopId: string, seen: Set<string>, expected: number | null): void {
	if (!Number.isSafeInteger(total) || total < 0 || (expected !== null && expected !== total)) throw new Usage("Shopee 待出货订单总数变化或无效，请重新读取");
	if (refs.some((r) => String(r.shop_id) !== shopId)) throw new Usage("Shopee 订单列表返回了另一家店铺");
	for (const r of refs) {
		const id = String(r.order_id);
		if (!id || seen.has(id)) throw new Usage("Shopee 待出货订单列表重复或缺少编号，读取不完整");
		seen.add(id);
	}
	if (seen.size > total || (!refs.length && seen.size < total)) throw new Usage("Shopee 待出货订单列表数量不完整");
}

function orderState(order: Order) {
	const state = shopeeState(order.status);
	if (order.packageStatuses?.some((status) => shopeeState(status).platformStatus !== state.platformStatus))
		return { eligible: false, platformStatus: "包裹状态待核对" };
	return state;
}

export function validateCards(cards: Order[], refs: Ref[], shopId: string): void {
	const expected = new Set(refs.map((r) => String(r.order_id)));
	const seen = new Set<string>();
	for (const order of cards) {
		if (order.shopId !== shopId || !expected.has(order.orderId) || seen.has(order.orderId) || !order.orderSn)
			throw new Usage("Shopee 订单详情身份不符或重复，读取不完整");
		seen.add(order.orderId);
		if (!order.items.length || order.items.some((i) => !i.itemId || !Number.isSafeInteger(i.qty) || i.qty < 1))
			throw new Usage(`Shopee 订单 ${order.orderSn} 商品明细不完整`);
	}
	if (seen.size !== expected.size) throw new Usage("Shopee 订单详情缺失，读取不完整");
}

async function inShop<T>(account: string, run: (shopId: string) => Promise<T>): Promise<T> {
	return inAccount("shopee", account, async () => {
		const identity = await readShop();
		if (identity.username !== account && identity.shopId !== account) throw new Usage(`Shopee 登录身份变化，当前不是 ${account}`);
		return run(identity.shopId);
	});
}

export async function collectShopeeOrders(
	shopId: string,
	refs: Ref[],
	range?: OrderDateRange,
	saved: KnownOrderDate[] = [],
	readDetail = oneOrder,
	readCards = orderCards,
) {
	const known = new Map(saved.filter((row) => row.shopId === shopId).map((row) => [row.orderId, row]));
	const bounds = orderBounds(range);
	const dates = new Map<string, { sn: string; createdAt: Date }>();
	const selected: Ref[] = [];
	let unreadSince: number | null = null;
	for (const ref of refs) {
		const id = String(ref.order_id);
		let date = known.get(id);
		if (!date) {
			const raw = reply(detail, await readDetail(id), "Shopee /api/v3/order/get_one_order");
			if (String(raw.order_id) !== id || String(raw.shop_id) !== shopId) throw new Usage("Shopee 订单详情与列表的店铺或订单身份不符");
			date = { orderId: id, shopId, sn: raw.order_sn, createdAt: new Date(raw.create_time * 1000) };
		}
		if (bounds && (date.createdAt < bounds.start || date.createdAt >= bounds.end)) {
			if (!known.has(id)) unreadSince = Math.min(unreadSince ?? Infinity, date.createdAt.getTime());
			continue;
		}
		dates.set(id, date);
		selected.push(ref);
	}
	const orders: ShopeeOrder[] = [];
	const sns = new Set<string>();
	for (let i = 0; i < selected.length; i += 5) {
		const batch = selected.slice(i, i + 5);
		const cards = await readCards(TAB.toShip, batch);
		validateCards(cards, batch, shopId);
		for (const order of cards) {
			const date = dates.get(order.orderId)!;
			if (date.sn !== order.orderSn || sns.has(order.orderSn)) throw new Usage("Shopee 订单号重复或与详情不符，读取不完整");
			sns.add(order.orderSn);
			orders.push({ ...order, createdAt: date.createdAt });
		}
	}
	return { orders, unreadSince };
}

export async function readShopeeOrders(account: string, range?: OrderDateRange, known?: KnownOrderDate[]) {
	return inShop(account, async (shopId) => {
		const refs: Ref[] = [];
		const seen = new Set<string>();
		let expected: number | null = null;
		for await (const page of orderIndexPages(TAB.toShip)) {
			validateIndexPage(page.total, page.refs, shopId, seen, expected);
			expected ??= page.total;
			refs.push(...page.refs);
			if (seen.size === expected) break;
		}
		return { shopId, ...(await collectShopeeOrders(shopId, refs, range, known)) };
	});
}

export const modelKey = (item: { itemId: string; modelId: string }) => (!item.modelId || item.modelId === "0" ? item.itemId : item.modelId);
export function shopeeItems(order: Order) {
	const grouped = new Map<string, { itemId: string; modelId: string; chanbossModelId: string; name: string; spec: string; qty: number; image: string }>();
	for (const item of order.items) {
		const modelId = modelKey(item),
			key = `${item.itemId}:${modelId}`;
		const previous = grouped.get(key);
		if (previous) previous.qty += item.qty;
		else grouped.set(key, { ...item, modelId, chanbossModelId: "" });
	}
	return [...grouped.values()];
}

export function shopeeOrderRow(order: ShopeeOrder, account: string) {
	const items = shopeeItems(order),
		state = orderState(order);
	return {
		sn: OrderSn.parse(order.orderSn),
		shop: account,
		shop_id: order.shopId,
		order_source: "shopee" as const,
		shopee_order_id: order.orderId,
		shopee_status: order.status,
		procurement_eligible: state.eligible,
		created_at: order.createdAt,
		ship_by: order.shipBy ? new Date(order.shipBy) : null,
		platform_status: state.platformStatus,
		items,
		items_text: items.map((i) => `${i.name} / ${i.spec || "（单规格）"} × ${i.qty}`).join("\n"),
	};
}

export function validateCartOrder(
	order: Order | undefined,
	stored: { sn: string; shopee_order_id: string; shop_id: string },
	lines: { modelId: string; qty: number }[],
): void {
	if (!order || order.orderId !== stored.shopee_order_id || order.orderSn !== stored.sn || order.shopId !== stored.shop_id)
		throw new Usage(`Shopee 订单 ${stored.sn} 的店铺或订单身份变化，未加购`);
	if (!orderState(order).eligible) throw new Usage(`Shopee 订单 ${stored.sn} 已不是待出货，未加购`);
	const items = shopeeItems(order);
	for (const line of lines) {
		const matches = items.filter((i) => i.modelId === line.modelId);
		if (matches.length !== 1 || matches[0]!.qty !== line.qty) throw new Usage(`Shopee 订单 ${stored.sn} 的规格或数量已变化，未加购`);
	}
}

export async function readCartOrders(account: string, refs: Ref[]): Promise<Order[]> {
	return inShop(account, async (shopId) => {
		if (refs.some((r) => String(r.shop_id) !== shopId)) throw new Usage("Shopee 加购校验的店铺身份不符");
		const out: Order[] = [];
		for (let i = 0; i < refs.length; i += 5) {
			const batch = refs.slice(i, i + 5),
				cards = await orderCards(TAB.toShip, batch);
			validateCards(cards, batch, shopId);
			out.push(...cards);
		}
		return out;
	});
}
