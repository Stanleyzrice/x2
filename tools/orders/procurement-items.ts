// 订单行只关联同商品的已选货源或同店已发布商品稿；链接指向商品，不推断 1688 SKU 对应。
import { z } from "zod";
import type { ProcurementSource, PurchaseMatch, PurchaseTarget, Quantities, SkuDemand } from "../../platform/web/procurement.ts";

export type ProcurementItem = { itemId: string; modelId: string; name: string; spec: string; qty: number; image: string };
export type ProcurementSourceRow = { itemId: string; offerId: string; title: string | null; itemImage: string | null; broken: string | null };
export type ProcurementListingRow = { shop: string; shopId: string; productId: string; offerId: string; title: string | null };
export type EvidenceCatalog = { shop: string; shopId: string; productId: string; models: unknown };
const imageModels = z.array(z.object({ modelId: z.string().nullable(), image: z.string().nullish() }));
export type ProcurementLine = Omit<ProcurementItem, "image"> & { image: string | null; skuImage: string | null; sources: ProcurementSource[] };
const emptyQuantities = (): Quantities => ({ qty: 0, paidQty: 0, unpaidQty: 0, buyQty: 0, reviewQty: 0 });
type DemandOrder = {
	sn: string;
	shop: string;
	shopId: string;
	lines: (ProcurementLine & { target: PurchaseTarget | null; purchase: PurchaseMatch; cartRecorded: boolean })[];
};

export function procurementDemand(orders: DemandOrder[]): SkuDemand[] {
	const groups = new Map<string, Omit<SkuDemand, "orders"> & { orders: Map<string, SkuDemand["orders"][number]> }>();
	for (const order of orders) {
		for (const { itemId, modelId, name, spec, skuImage, qty, target, purchase, cartRecorded } of order.lines) {
			if (!Number.isSafeInteger(qty) || qty < 1) continue;
			const key = JSON.stringify(target ? ["1688", target.offerId, target.skuId, target.specId ?? null] : ["shopee", order.shopId, itemId, modelId]);
			const group = groups.get(key) ?? { key, name, spec, target, image: null, ...emptyQuantities(), orders: new Map() };
			group.image ??= skuImage;
			const verified = purchase.state === "paid" || purchase.state === "unpaid" || purchase.state === "partial" || purchase.state === "refund";
			const paidQty = verified ? purchase.paidQty : 0;
			const unpaidQty = verified ? purchase.unpaidQty : 0;
			const missing = qty - paidQty - unpaidQty;
			const buyQty = !cartRecorded && target && (purchase.canPurchase || purchase.state === "partial") ? missing : 0;
			const source = group.orders.get(order.sn) ?? { sn: order.sn, shop: order.shop, ...emptyQuantities() };
			for (const totals of [group, source]) {
				totals.qty += qty;
				totals.paidQty += paidQty;
				totals.unpaidQty += unpaidQty;
				totals.buyQty += buyQty;
				totals.reviewQty += missing - buyQty;
			}
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
	catalog: EvidenceCatalog[] = [],
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
		const product = catalog.find((row) => row.shop === order.shop && row.shopId === order.shopId && row.productId === item.itemId);
		const models = imageModels.safeParse(product?.models).data?.filter((model) => model.modelId === item.modelId);
		const skuImage = (models?.length === 1 && procurementImage(models[0]!.image)) || procurementImage(item.image);
		const image = skuImage ?? own.map((row) => procurementImage(row.itemImage)).find(Boolean) ?? null;
		return { ...item, skuImage, image, sources: [...links.values()] };
	});
}
