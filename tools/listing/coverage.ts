import { createHash } from "node:crypto";
import { z } from "zod";
import type { Json, Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { parseJson } from "../../platform/tool.ts";
import { settingsOf } from "./pricing.ts";
import { type Product, usedPics } from "./product.ts";
import { productOf } from "./ready.ts";
import { ListingId, type ListingRow, type ShopSettingsRow } from "./row.ts";

const reason = z.string().trim().min(1);
const sourceUrl = z.url({ protocol: /^https?$/ });
const manifest = z.object({
	expectedScope: z.string().regex(/^[a-f\d]{64}$/),
	excludedSkus: z.array(z.object({ skuId: z.string().min(1), reason })),
	detail: z.array(z.union([z.strictObject({ sourceUrl, imageId: z.string().min(1) }), z.strictObject({ sourceUrl, reason })])),
	layoutEvidence: reason,
});
export type ListingCoverage = z.output<typeof manifest>;
export const coveragePreviewParams = z.object({ id: ListingId });
export const coverageParams = coveragePreviewParams.extend({
	manifest: z.preprocess(parseJson, manifest).describe("规格排除、详情来源逐项处理、最终版式审阅的JSON，可用 - 从stdin读"),
});

export function coverageScope(row: ListingRow, product: Pick<Product, "variants" | "tiers">) {
	const selected = product.variants.map(({ skuId, specId, options }) => ({ skuId, specId, options }));
	const selectedIds = new Set(selected.map(({ skuId }) => skuId));
	const sourceSkus = (row.offer?.skus ?? []).map(({ skuId, specId, name, stock, price }) => ({ skuId, specId, name, price, inStock: stock > 0 }));
	const sourceDetail = [...new Set(row.offer?.detail ?? [])];
	const finalDetail = usedPics(row.images, "detail", new Set(row.removed_images ?? [])).map(({ pic }) => ({
		id: pic.imageId!,
		from: pic.from,
		width: pic.width!,
		height: pic.height!,
	}));
	return {
		expectedScope: createHash("sha256")
			.update(JSON.stringify([row.offer_id, sourceSkus, sourceDetail, selected, product.tiers, finalDetail]))
			.digest("hex"),
		sourceSkus,
		selected,
		tiers: product.tiers,
		excludedInStock: sourceSkus.filter(({ skuId, inStock }) => inStock && !selectedIds.has(skuId)),
		sourceDetail,
		finalDetail,
	};
}

export function saveCoverage(row: ListingRow, product: Pick<Product, "variants" | "tiers">, input: ListingCoverage): ListingCoverage {
	const scope = coverageScope(row, product);
	const review = manifest.parse(input);
	if (review.expectedScope !== scope.expectedScope) throw new Usage("来源或最终规格、详情图已变化，请重新 coverage-preview 并审阅");
	const sourceById = new Map(scope.sourceSkus.map((sku) => [sku.skuId, sku]));
	for (const variant of scope.selected) {
		const source = sourceById.get(variant.skuId);
		if (!source?.inStock || source.specId !== variant.specId) throw new Usage(`最终SKU ${variant.skuId} 无对应的在库货源规格`);
	}
	const skuIds = new Set(review.excludedSkus.map(({ skuId }) => skuId));
	const missingSkus = scope.excludedInStock.filter(({ skuId }) => !skuIds.has(skuId));
	if (missingSkus.length) throw new Usage(`在库规格缺少排除依据：${missingSkus.map(({ name, skuId }) => `${name} (${skuId})`).join("、")}`);
	if (skuIds.size !== scope.excludedInStock.length || skuIds.size !== review.excludedSkus.length)
		throw new Usage("排除依据必须逐个对应当前未上的在库规格，不得重复或混入其他SKU");
	const reviewedUrls = new Set(review.detail.map(({ sourceUrl }) => sourceUrl));
	const missingDetail = scope.sourceDetail.filter((url) => !reviewedUrls.has(url));
	if (missingDetail.length) throw new Usage(`以下原详情来源未审阅：${missingDetail.join("、")}`);
	if (reviewedUrls.size !== scope.sourceDetail.length || reviewedUrls.size !== review.detail.length)
		throw new Usage("详情审阅必须逐个对应当前所有原详情来源，不得重复或混入外来图片");
	const imageIds = new Set(scope.finalDetail.map(({ id }) => id));
	for (const decision of review.detail)
		if ("imageId" in decision && !imageIds.has(decision.imageId)) throw new Usage(`审阅绑定了不存在的详情图：${decision.imageId}`);
	return review;
}

export function coverageBlock(row: ListingRow, product: Pick<Product, "variants" | "tiers">): string | null {
	if (!row.coverage) return "规格与详情的覆盖审阅未完成，先执行 listing coverage-preview 和 listing coverage-review";
	try {
		saveCoverage(row, product, row.coverage);
		return null;
	} catch (error) {
		return (error as Error).message;
	}
}

async function currentProduct(sql: Sql | import("postgres").TransactionSql, row: ListingRow): Promise<Product> {
	if (row.cancelled || row.product_id || row.listed_at) throw new Usage("覆盖审阅仅用于未建商品稿");
	const [shop] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${row.shop}`;
	if (!shop) throw new Usage(`没有店铺设置 ${row.shop}`);
	const result = productOf(row, settingsOf(shop));
	if (!result.product) throw new Usage(`商品稿还缺：${result.problems.join("；")}`);
	return result.product;
}

export async function previewCoverage(sql: Sql, { id }: z.output<typeof coveragePreviewParams>) {
	const [row] = await sql<ListingRow[]>`select * from listings where id = ${id}`;
	if (!row) throw new Usage(`没有商品稿 ${id}`);
	const product = await currentProduct(sql, row);
	return { id, ...coverageScope(row, product), before: row.coverage ?? null };
}

export async function reviewCoverage(sql: Sql, { id, manifest }: z.output<typeof coverageParams>) {
	return sql.begin(async (tx) => {
		const [row] = await tx<ListingRow[]>`select * from listings where id = ${id} for update`;
		if (!row) throw new Usage(`没有商品稿 ${id}`);
		const coverage = saveCoverage(row, await currentProduct(tx, row), manifest);
		await tx`update listings set coverage = ${tx.json(coverage as Json)}, updated_at = now() where id = ${id}`;
		return { id, coverage };
	});
}
