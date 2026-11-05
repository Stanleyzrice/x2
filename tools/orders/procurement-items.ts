// 订单行只关联同商品的已选货源或同店已发布商品稿；链接指向商品，不推断 1688 SKU 对应。
export type ProcurementItem = { itemId: string; modelId: string; name: string; spec: string; qty: number; image: string };
export type ProcurementSourceRow = { itemId: string; offerId: string; title: string | null; itemImage: string | null; broken: string | null };
export type ProcurementListingRow = { shop: string; shopId: string; productId: string; offerId: string; title: string | null };
export type ProcurementSource = { offerId: string; url: string; title: string; chosen: boolean; broken: string | null; origin: "chosen" | "listing" };
export type ProcurementLine = Omit<ProcurementItem, "image"> & { image: string | null; sources: ProcurementSource[] };

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
