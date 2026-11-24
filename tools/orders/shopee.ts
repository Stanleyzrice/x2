// Shopee 待出货订单读取与完整性校验；列表、详情、店铺身份都对得上才可采购，不借用 Chanboss 状态。
import { z } from "zod";
import { type Order, oneOrder, orderCards, orderIndexPages, TAB } from "../../connectors/sites/shopee/orders.ts";
import { OrderSn, shop as readShop } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import { Usage } from "../../platform/errors.ts";
import { reply } from "../../platform/reply.ts";

export type Ref = { order_id: string | number; shop_id: string | number; region_id?: string | null };
export type ShopeeOrder = Order & { createdAt: Date };
const detail = z.looseObject({
	order_id: z.union([z.string(), z.number()]),
	order_sn: z.string(),
	shop_id: z.union([z.string(), z.number()]),
	create_time: z.coerce.number().int().positive(),
});
const TO_SHIP = new Set(["To ship", "待出貨", "待出货", "READY_TO_SHIP"]);
const CLOSED: Record<string, string> = {
	Unpaid: "待付款",
	未付款: "待付款",
	待付款: "待付款",
	Cancelled: "不成立",
	已取消: "不成立",
	取消中: "取消中",
	Completed: "已完成",
	已完成: "已完成",
	Shipped: "已出货",
	已出貨: "已出货",
	运送中: "已出货",
	運送中: "已出货",
};
export function shopeeState(status: string): { eligible: boolean; platformStatus: string } {
	if (TO_SHIP.has(status)) return { eligible: true, platformStatus: "待出货" };
	if (CLOSED[status]) return { eligible: false, platformStatus: CLOSED[status]! };
	throw new Usage(`Shopee 订单状态尚未识别：${status || "空"}；先不采购`);
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

export function packagesEligible(order: Order): boolean {
	return (order.packageStatuses ?? [order.status]).every((status) => shopeeState(status).eligible);
}

export function validateCards(cards: Order[], refs: Ref[], shopId: string): void {
	const expected = new Set(refs.map((r) => String(r.order_id)));
	const seen = new Set<string>();
	for (const order of cards) {
		if (order.shopId !== shopId || !expected.has(order.orderId) || seen.has(order.orderId) || !order.orderSn)
			throw new Usage("Shopee 订单详情身份不符或重复，读取不完整");
		seen.add(order.orderId);
		shopeeState(order.status);
		if (shopeeState(order.status).eligible && !packagesEligible(order)) throw new Usage(`Shopee 订单 ${order.orderSn} 包含非待出货包裹，未采购`);
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

export async function readShopeeOrders(account: string): Promise<{ shopId: string; orders: ShopeeOrder[] }> {
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
		const out: ShopeeOrder[] = [];
		const sns = new Set<string>();
		for (let i = 0; i < refs.length; i += 5) {
			const batch = refs.slice(i, i + 5);
			const cards = await orderCards(TAB.toShip, batch);
			validateCards(cards, batch, shopId);
			for (const order of cards) {
				if (sns.has(order.orderSn)) throw new Usage("Shopee 订单号重复，读取不完整");
				sns.add(order.orderSn);
				const raw = reply(detail, await oneOrder(order.orderId), "Shopee /api/v3/order/get_one_order");
				if (String(raw.order_id) !== order.orderId || raw.order_sn !== order.orderSn || String(raw.shop_id) !== shopId)
					throw new Usage("Shopee 订单详情与列表的店铺或订单身份不符");
				out.push({ ...order, createdAt: new Date(raw.create_time * 1000) });
			}
		}
		return { shopId, orders: out };
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
		state = shopeeState(order.status);
	return {
		sn: OrderSn.parse(order.orderSn),
		shop: account,
		shop_id: order.shopId,
		order_source: "shopee" as const,
		shopee_order_id: order.orderId,
		shopee_status: order.status,
		procurement_eligible: state.eligible && packagesEligible(order),
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
	if (!shopeeState(order.status).eligible || !packagesEligible(order)) throw new Usage(`Shopee 订单 ${stored.sn} 已不是待出货，未加购`);
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
