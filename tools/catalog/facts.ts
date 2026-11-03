// Catalog 的网站事实归一化、完整分页检查与已有货源归属校验；不选择或修改货源。
import type { ProductInfo, ProductSummary } from "../../connectors/sites/shopee/products.ts";
import { productModelImage, STATUS } from "../../connectors/sites/shopee/products.ts";
import { NeedsHuman } from "../../platform/errors.ts";

export type StockState = "in_stock" | "sold_out" | "unknown";
export type CatalogModel = {
	modelId: string | null;
	sku: string | null;
	name: string;
	price: number | null;
	stock: number | null;
	tierIndex: number[];
	image?: string | null;
};
export type ProductFact = {
	productId: string;
	name: string;
	parentSku: string | null;
	cover: string | null;
	status: number | null;
	reportedStatus: number | null;
	statusLabel: string;
	unlisted: boolean | null;
	models: CatalogModel[] | null;
	priceMin: number | null;
	priceMax: number | null;
	stockTotal: number | null;
	stockState: StockState;
	detailError: string | null;
};
export type Identity = { shopId: string; username: string };
export type CatalogReader = {
	identity(): Promise<Identity>;
	list(page: number): Promise<{ total: number; rows: ProductSummary[] }>;
	detail(id: string): Promise<ProductInfo>;
};

const number = (v: unknown): number | null => {
	if (v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (typeof v !== "number" && typeof v !== "string")) return null;
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : null;
};
const sumKnown = (values: (number | null)[]): number | null =>
	values.length && values.every((n) => n !== null) ? values.reduce<number>((sum, n) => sum + n!, 0) : null;

// 商品列表已带 SKU 时复用同次采集的价格库存；只有网站未提供模型列表才逐件补读。
function detailsFromList(summary: ProductSummary): ProductInfo | null {
	if (!summary.bulk?.models.length) return null;
	return {
		id: summary.productId,
		name: summary.name,
		parent_sku: summary.bulk.parentSku,
		model_list: summary.bulk.models.map((m) => ({
			id: m.modelId,
			name: m.name.trim() ? m.name : summary.bulk!.models.length === 1 && m.isDefault === true ? "默认规格" : "",
			sku: m.sku,
			sku_image: m.image ?? null,
			tier_index: m.tierIndex,
			price_info: { normal_price: m.price },
			stock_detail: { total_seller_stock: m.stock },
		})),
	};
}

export function productFact(summary: ProductSummary, info: ProductInfo | null, detailError: string | null = null): ProductFact {
	if (info?.id != null && String(info.id) !== summary.productId) throw new Error(`Shopee 商品详情编号不匹配：${summary.productId}`);
	let missingSpecification = false;
	const models: CatalogModel[] | null = info?.model_list
		? info.model_list.map((m) => {
				const tierIndex = (m.tier_index ?? []).map(Number);
				const parts = tierIndex.map((i, a) => info.std_tier_variation_list?.[a]?.value_list?.[i]?.custom_value ?? "").filter(Boolean);
				const name = (m.name?.trim() ? m.name : "") || parts.join(" / ");
				const defaultModel = info.model_list!.length === 1 && !tierIndex.length && !info.std_tier_variation_list?.length;
				if (!name && !defaultModel) missingSpecification = true;
				return {
					modelId: m.id ?? null,
					sku: m.sku || null,
					name: name || (defaultModel ? "默认规格" : "规格名未知"),
					price: number(m.price_info?.input_normal_price) ?? number(m.price_info?.normal_price),
					stock: number(m.stock_detail?.total_seller_stock) ?? sumKnown((m.stock_detail?.seller_stock_info ?? []).map((s) => number(s.sellable_stock))),
					tierIndex,
					image: productModelImage(info!, m),
				};
			})
		: null;
	const prices = (models ?? []).map((m) => m.price);
	const stocks = (models ?? []).map((m) => m.stock);
	const stockTotal = sumKnown(stocks);
	const status = summary.status === 1 && info?.is_unlisted === true ? 8 : summary.status;
	return {
		productId: summary.productId,
		name: info?.name || summary.name,
		parentSku: info?.parent_sku || null,
		cover: summary.cover || null,
		status,
		reportedStatus: summary.status,
		statusLabel: status === null ? "状态未知" : (STATUS[status] ?? `状态 ${status}`),
		unlisted: info?.is_unlisted ?? null,
		models,
		priceMin: prices.length && prices.every((p) => p !== null) ? Math.min(...(prices as number[])) : null,
		priceMax: prices.length && prices.every((p) => p !== null) ? Math.max(...(prices as number[])) : null,
		stockTotal,
		stockState: stocks.some((s) => s !== null && s > 0) ? "in_stock" : stockTotal === 0 ? "sold_out" : "unknown",
		detailError:
			detailError ??
			(!models?.length
				? "Shopee 未返回规格明细"
				: missingSpecification
					? "部分规格名称未返回"
					: models.some((m) => m.modelId === null || m.price === null || m.stock === null)
						? "部分规格的 id、价格或库存未返回"
						: null),
	};
}

export function checkIdentity(expected: { shop: string; shopId: string }, actual: Identity): void {
	if (actual.shopId !== expected.shopId || actual.username !== expected.shop)
		throw new NeedsHuman(`Catalog 店铺身份不匹配：需要 ${expected.shop} / ${expected.shopId}，当前是 ${actual.username} / ${actual.shopId}`);
}

export type CollectProgress = { phase: "listing" | "details"; page: number; observed: number; total: number };
export async function collectCatalog(expected: { shop: string; shopId: string }, reader: CatalogReader, progress?: (value: CollectProgress) => Promise<void>) {
	checkIdentity(expected, await reader.identity());
	const first = await reader.list(1);
	if (!Number.isSafeInteger(first.total) || first.total < 0) throw new Error("Shopee 商品总数无效");
	const summaries: ProductSummary[] = [];
	const ids = new Set<string>();
	let current = first;
	for (let page = 1; ; page++) {
		if (current.total !== first.total) throw new Error("Shopee 商品总数在读取期间变化，未替换上次快照");
		if (!current.rows.length && summaries.length < first.total) throw new Error(`Shopee 商品第 ${page} 页为空，分页不完整`);
		for (const row of current.rows) {
			if (ids.has(row.productId)) throw new Error(`Shopee 商品分页出现重复编号：${row.productId}`);
			ids.add(row.productId);
			summaries.push(row);
		}
		await progress?.({ phase: "listing", page, observed: summaries.length, total: first.total });
		if (summaries.length >= first.total) break;
		current = await reader.list(page + 1);
	}
	if (summaries.length !== first.total) throw new Error("Shopee 商品分页数量与总数不一致");
	const products: ProductFact[] = [];
	for (const summary of summaries) {
		let info: ProductInfo | null = detailsFromList(summary);
		let error: string | null = null;
		try {
			if (!info) info = await reader.detail(summary.productId);
		} catch (e) {
			if (summary.status !== 0 || e instanceof NeedsHuman) throw e;
			error = `网站仍返回此删除商品，详情不可读取：${(e as Error).message}`;
		}
		products.push(productFact(summary, info, error));
		await progress?.({ phase: "details", page: 0, observed: products.length, total: first.total });
	}
	checkIdentity(expected, await reader.identity());
	return { products, expectedCount: first.total, complete: true as const, detailsComplete: products.every((p) => p.detailError === null) };
}

export type SupplierLink = { kind: "listing" | "chosen"; offerId: string; url: string; broken: string | null; selectedAt: string | null };
export type ListingLink = { shop: string; shopId: string; productId: string; offerId: string };
export type ChosenLink = { productId: string; offerId: string; broken: string | null; selectedAt: string | null };
export type Ownership = { productId: string; shopId: string | null };

export function supplierLinks(
	shop: string,
	shopId: string,
	productId: string,
	listings: ListingLink[],
	chosen: ChosenLink[],
	owners: Ownership[],
): { suppliers: SupplierLink[]; supplierWarnings: string[] } {
	const link = (offerId: string) => `https://detail.1688.com/offer/${encodeURIComponent(offerId)}.html`;
	const suppliers: SupplierLink[] = listings
		.filter((l) => l.shop === shop && l.shopId === shopId && l.productId === productId)
		.map((l) => ({ kind: "listing", offerId: l.offerId, url: link(l.offerId), broken: null, selectedAt: null }));
	const known = [...owners, ...listings.map((l) => ({ productId: l.productId, shopId: l.shopId }))].filter((o) => o.productId === productId);
	const mine = chosen.filter((c) => c.productId === productId);
	const supplierWarnings: string[] = [];
	if (mine.length && (!known.length || known.some((o) => o.shopId !== shopId)))
		supplierWarnings.push("已有已选货源，但订单或商品稿记录未提供唯一且一致的店铺归属，未将它认作本店货源");
	else for (const c of mine) suppliers.push({ kind: "chosen", offerId: c.offerId, url: link(c.offerId), broken: c.broken, selectedAt: c.selectedAt });
	if (new Set(suppliers.map((s) => s.offerId)).size > 1) supplierWarnings.push("上品来源与已选货源不同，分别展示，请人工核对");
	return { suppliers, supplierWarnings };
}
