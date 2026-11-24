export type PriceBandWord = { hotWordId: number; word: string };
export type PriceBandCategory = { path: number[]; name: string };
export type PriceBandSource = {
	kind: "samples";
	keyword: string;
	date: string | null;
	received: number;
	dated: number;
	rows: { price: number; sales: number; title: string; shop: string | null }[];
};
export type PriceBandResult = PriceBandSource | { kind: "words"; words: PriceBandWord[] };

const specKey = (text: string) => text.normalize("NFKC").toLowerCase().replaceAll("×", "x").replace(/\s/g, "");

export function summarizePriceBand(source: PriceBandSource, specification: string) {
	const spec = specKey(specification);
	const groups = new Map<number, { items: number; sales: number; selling: number; missingShopSales: number; shops: Map<string, number> }>();
	let items = 0;
	let sales = 0;
	for (const row of source.rows) {
		if (spec && !specKey(row.title).includes(spec)) continue;
		const group = groups.get(row.price) ?? { items: 0, sales: 0, selling: 0, missingShopSales: 0, shops: new Map<string, number>() };
		groups.set(row.price, group);
		items++;
		sales += row.sales;
		group.items++;
		group.sales += row.sales;
		if (!row.sales) continue;
		group.selling++;
		if (row.shop) group.shops.set(row.shop, (group.shops.get(row.shop) ?? 0) + row.sales);
		else group.missingShopSales += row.sales;
	}
	let cumulativeSales = 0;
	let lower: number | null = null;
	let upper: number | null = null;
	const bands = [...groups.entries()]
		.sort(([a], [b]) => a - b)
		.map(([price, group]) => {
			cumulativeSales += group.sales;
			if (sales > 0 && cumulativeSales >= sales * 0.25) lower ??= price;
			if (sales > 0 && cumulativeSales >= sales * 0.75) upper ??= price;
			const topSales = [...group.shops.values()]
				.sort((a, b) => b - a)
				.slice(0, 3)
				.reduce((sum, value) => sum + value, 0);
			return {
				price,
				label: String(price),
				items: group.items,
				itemShare: (group.items / items) * 100,
				salesShare: sales > 0 ? (group.sales / sales) * 100 : null,
				sellingRate: (group.selling / group.items) * 100,
				topShopShare: group.sales > 0 && !group.missingShopSales ? (topSales / group.sales) * 100 : null,
			};
		});
	return { items, bands, mainBand: lower !== null && upper !== null ? { lower, upper } : null };
}

export function pricePosition(prices: readonly number[], price: number) {
	const index = prices.findIndex((value) => value >= price);
	return { index: index < 0 ? prices.length : index, exact: index >= 0 && prices[index] === price };
}
