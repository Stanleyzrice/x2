import { z } from "zod";
import { shopMetrics, twMidnight } from "../../connectors/sites/shopee/marketing.ts";
import { allProducts, type Performance, type ProductSummary, performance } from "../../connectors/sites/shopee/products.ts";
import { shop as identity } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import { NeedsHuman } from "../../platform/errors.ts";
import { snapshotSchema } from "../../platform/ui/interactable/store-monitor/schema.ts";

const DAY = 86_400;
const toTaipeiDate = (timestamp: number) => new Date((timestamp + 8 * 3600) * 1000).toISOString().slice(0, 10);
const count = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().nonnegative());
const series = z.object({
	value: count,
	chain_ratio: z.number().nullish(),
	points: z.array(z.object({ timestamp: z.number().int(), value: count.nullish() })),
});
const shopReport = z.object({ shop_uv: series, product_clicks: series, paid_orders: series, confirmed_orders: z.object({ value: count }) });

export async function readCompleteList<Row>(
	label: string,
	read: (page: number) => Promise<{ total: number; rows: Row[] }>,
	id: (row: Row) => string,
): Promise<Row[]> {
	const rows = new Map<string, Row>();
	const first = await read(1);
	for (let page = 1, current = first; ; current = await read(++page)) {
		if (current.total !== first.total) throw new Error(`${label}总数在读取期间变化，请重新刷新`);
		for (const row of current.rows) {
			const key = id(row);
			if (rows.has(key)) throw new Error(`${label}分页出现重复商品 ${key}，请重新刷新`);
			rows.set(key, row);
		}
		if (rows.size === first.total) return [...rows.values()];
		if (rows.size > first.total || !current.rows.length) throw new Error(`${label}分页不完整，请重新刷新`);
	}
}

export function trafficOf(raw: unknown, start: number, end: number) {
	const parsed = shopReport.safeParse(raw);
	if (!parsed.success) throw new Error("虾皮店铺指标回包不完整，未替换上一次快照");
	const { shop_uv, product_clicks, paid_orders, confirmed_orders } = parsed.data;
	const days = Array.from({ length: 7 }, (_, index) => start + index * DAY);
	const pointMap = ({ points }: z.infer<typeof series>) => {
		const indexed = new Map(points.map(({ timestamp, value }) => [timestamp, value]));
		if (indexed.size !== days.length || points.length !== days.length || days.some((day) => day > end || !indexed.has(day)))
			throw new Error("虾皮店铺指标日期与最近 7 个完整日不符，未替换上一次快照");
		return indexed;
	};
	const visitors = pointMap(shop_uv);
	const clicks = pointMap(product_clicks);
	const paid = pointMap(paid_orders);
	const metric = ({ value, chain_ratio }: z.infer<typeof series>) => ({ total: value, change: chain_ratio ?? null });
	return {
		visitors: metric(shop_uv),
		clicks: metric(product_clicks),
		paid: metric(paid_orders),
		confirmed: confirmed_orders.value,
		points: days.map((day) => ({ date: toTaipeiDate(day), visitors: visitors.get(day) ?? null, clicks: clicks.get(day) ?? null, paid: paid.get(day) ?? null })),
	};
}

export function productsOf(catalog: ProductSummary[], report: Performance[]) {
	const active = new Set<string>();
	const blocked: { id: string; name: string }[] = [];
	let inStock = 0;
	let outOfStock = 0;
	let unknownStock = 0;
	let review = 0;
	let offShelf = 0;
	for (const { productId, status, name, bulk } of catalog) {
		if (status === 1) {
			active.add(productId);
			const models = bulk?.models;
			if (models?.some(({ stock }) => stock !== null && stock > 0)) inStock++;
			else if (models?.length && models.every(({ stock }) => stock === 0)) outOfStock++;
			else unknownStock++;
		} else if (status === 2) review++;
		else if (status === 3) blocked.push({ id: productId, name: name.trim() || `商品 ${productId}` });
		else if (status === 8) offShelf++;
	}
	let reported = 0;
	let impressions = 0;
	for (const row of report) {
		if (!active.has(row.id)) continue;
		const metric = count.safeParse(row.product_card_impressions);
		if (!metric.success) continue;
		reported++;
		impressions += metric.data;
	}
	return { inStock, outOfStock, unknownStock, review, offShelf, reported, impressions: reported || !active.size ? impressions : null, blocked };
}

export async function collectSnapshot(shop: string, shopId: string) {
	return inAccount("shopee", shopId, async () => {
		const midnight = twMidnight();
		const start = midnight - 7 * DAY;
		const end = midnight - 1;
		const traffic = trafficOf(await shopMetrics(start, end, "past7days"), start, end);
		const catalog = await readCompleteList("虾皮商品目录", allProducts, (row) => row.productId);
		const report = await readCompleteList(
			"虾皮商品表现",
			(page) => performance(start, end, "past7days", page),
			(row) => row.id,
		);
		if ((await identity()).shopId !== shopId) throw new NeedsHuman(`虾皮当前登录的店铺与 ${shop} 不符，请切回对应店铺后再刷新`);
		return snapshotSchema.parse({
			shop,
			shopId,
			capturedAt: new Date().toISOString(),
			start: toTaipeiDate(start),
			end: toTaipeiDate(end),
			traffic,
			products: productsOf(catalog, report),
			restriction: { status: "unverified", evidence: "本次采集未核对卖家中心的店铺级处罚通知。目录中的禁卖状态只涉及对应商品。" },
		});
	});
}
