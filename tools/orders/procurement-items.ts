// 订单行只关联同商品的已选货源或同店已发布商品稿；链接指向商品，不推断 1688 SKU 对应。
import type { Match, MatchNeed } from "./procurement-matches.ts";

export type ProcurementItem = { itemId: string; modelId: string; name: string; spec: string; qty: number; image: string };
export type ProcurementSourceRow = { itemId: string; offerId: string; title: string | null; itemImage: string | null; broken: string | null };
export type ProcurementListingRow = { shop: string; shopId: string; productId: string; offerId: string; title: string | null };
export type ProcurementSource = { offerId: string; url: string; title: string; chosen: boolean; broken: string | null; origin: "chosen" | "listing" };
export type ProcurementLine = Omit<ProcurementItem, "image"> & { image: string | null; sources: ProcurementSource[] };
type DemandOrder = {
	sn: string;
	shop: string;
	shopId: string;
	cartPending: boolean;
	cartDone: boolean;
	purchase: Pick<Match, "canPurchase">;
	lines: (ProcurementLine & { target: MatchNeed["target"]; purchase: Match })[];
};
type Demand = {
	key: string;
	name: string;
	spec: string;
	target: MatchNeed["target"];
	qty: number;
	paidQty: number;
	unpaidQty: number;
	buyQty: number;
	reviewQty: number;
	orders: { sn: string; shop: string; qty: number }[];
};

export function procurementDemand(orders: DemandOrder[]): Demand[] {
	const groups = new Map<string, Omit<Demand, "orders"> & { orders: Map<string, Demand["orders"][number]> }>();
	for (const order of orders) {
		for (const { itemId, modelId, name, spec, qty, target, purchase } of order.lines) {
			if (!Number.isSafeInteger(qty) || qty < 1) continue;
			const key = JSON.stringify(target ? ["1688", target.offerId, target.skuId, target.specId ?? null] : ["shopee", order.shopId, itemId, modelId]);
			const group = groups.get(key) ?? { key, name, spec, target, qty: 0, paidQty: 0, unpaidQty: 0, buyQty: 0, reviewQty: 0, orders: new Map() };
			const verified = purchase.state === "paid" || purchase.state === "unpaid" || purchase.state === "partial";
			const paidQty = verified ? purchase.paidQty : 0;
			const unpaidQty = verified ? purchase.unpaidQty : 0;
			const buyQty = order.purchase.canPurchase && purchase.canPurchase && !order.cartPending && !order.cartDone ? qty : 0;
			group.qty += qty;
			group.paidQty += paidQty;
			group.unpaidQty += unpaidQty;
			group.buyQty += buyQty;
			group.reviewQty += qty - paidQty - unpaidQty - buyQty;
			const source = group.orders.get(order.sn) ?? { sn: order.sn, shop: order.shop, qty: 0 };
			source.qty += qty;
			group.orders.set(order.sn, source);
			groups.set(key, group);
		}
	}
	return [...groups.values()].map((group) => ({ ...group, orders: [...group.orders.values()] }));
}

/** 只展示 http(s) 图片；不让存下来的页面内容变成可执行 URL。 */
export function procurementImage(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}

export function procurementLines(
	order: { shop: string; shopId: string; items: ProcurementItem[] },
	chosen: ProcurementSourceRow[],
	listings: ProcurementListingRow[],
): ProcurementLine[] {
	return order.items.map((item) => {
		const own = chosen.filter((row) => row.itemId === item.itemId);
		const links = new Map<string, ProcurementSource>();
		for (const row of own) {
			if (!/^\d+$/.test(row.offerId)) continue;
			links.set(row.offerId, {
				offerId: row.offerId,
				url: `https://detail.1688.com/offer/${row.offerId}.html`,
				title: row.title?.trim() || row.offerId,
				chosen: true,
				broken: row.broken,
				origin: "chosen",
			});
		}
		for (const row of listings) {
			if (row.shop !== order.shop || row.shopId !== order.shopId || row.productId !== item.itemId || !/^\d+$/.test(row.offerId) || links.has(row.offerId))
				continue;
			links.set(row.offerId, {
				offerId: row.offerId,
				url: `https://detail.1688.com/offer/${row.offerId}.html`,
				title: row.title?.trim() || row.offerId,
				chosen: false,
				broken: null,
				origin: "listing",
			});
		}
		const fallbackImage = own.map((row) => procurementImage(row.itemImage)).find(Boolean) ?? null;
		return { ...item, image: procurementImage(item.image) ?? fallbackImage, sources: [...links.values()] };
	});
}
