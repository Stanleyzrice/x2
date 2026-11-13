// 显式人工/Codex审阅：核对当前内容指纹和完整逐图结果，只保存审阅来源与证据，不调用或冒充 Gemini。
import type postgres from "postgres";
import { z } from "zod";
import type { Json, Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { parseJson } from "../../platform/tool.ts";
import { type Audit, auditKey, reviewImages, roleOf, specNames, uniqIssues } from "./audit.ts";
import { settingsOf } from "./pricing.ts";
import type { Product } from "./product.ts";
import { productOf } from "./ready.ts";
import { ListingId, type ListingRow, type ShopSettingsRow } from "./row.ts";

const hash = z.string().regex(/^[a-f\d]{64}$/, "审阅指纹须为当前 preview 返回的 SHA256");
const issues = z.array(z.string().trim().min(1));
const content = z.object({
	expectedKey: hash.describe("review-preview 返回的当前文案、图片与规格指纹"),
	provider: z.enum(["codex-visual", "human"]).describe("实际完成审阅的来源；不能写 Gemini"),
	evidence: z.string().trim().min(1).describe("实际审阅过程与结论的依据，注明已查看所有最终图片及原始货源对应"),
	textIssues: z.preprocess(parseJson, issues).describe("实际文案问题的 JSON 数组；明确无问题时传 []"),
	images: z
		.preprocess(
			parseJson,
			z.array(
				z.object({
					id: z.string().trim().min(1),
					issues,
					where: z.enum(["印在商品上", "后加的文案"]).optional(),
				}),
			),
		)
		.describe("逐张图片结果 JSON：[{id,issues:[],where?}]，必须完整覆盖 preview 的图片ID，不漏图、不重复"),
});
export const listingReviewParams = content.extend({ id: ListingId.describe("未建商品稿编号") });
export const listingReviewPreviewParams = z.object({ id: ListingId.describe("未建商品稿编号") });
type Input = z.output<typeof listingReviewParams>;

export function reviewedAuditEditable(row: Pick<ListingRow, "product_id" | "listed_at">): void {
	if (row.product_id !== null || row.listed_at !== null) throw new Usage("商品已经建成或上架；草稿审阅工具不修改现有商品");
}

/** 完整逐图结果与当前内容绑定；任何旧指纹、漏图、重复或外来图片都拒绝。 */
export function makeReviewedAudit(p: Product, input: z.output<typeof content>, at = new Date().toISOString()): Audit {
	const v = content.parse(input);
	if (v.expectedKey !== auditKey(p)) throw new Usage("审阅后文案、图片或规格已变化，请重新 review-preview 并审阅");
	const expected = reviewImages(p),
		seen = new Set(v.images.map((x) => x.id));
	if (seen.size !== v.images.length) throw new Usage("审阅结果有重复图片ID");
	if (seen.size !== expected.length || !expected.every((id) => seen.has(id))) throw new Usage("审阅结果必须完整覆盖当前所有图片，不能漏图或添加外来图片");
	return {
		key: v.expectedKey,
		provider: v.provider,
		evidence: v.evidence,
		reviewedImageIds: expected,
		textIssues: uniqIssues(v.textIssues),
		images: v.images.map((x) => ({ id: x.id, issues: uniqIssues(x.issues), ...(x.where ? { where: x.where } : {}), role: roleOf(p, x.id) })),
		at,
	};
}

async function currentProduct(sql: Sql | postgres.TransactionSql, row: ListingRow): Promise<Product> {
	reviewedAuditEditable(row);
	if (row.cancelled) throw new Usage("商品稿已放弃，不保存审阅");
	const [settings] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${row.shop}`;
	if (!settings) throw new Usage(`没有店铺设置 ${row.shop}`);
	const result = productOf(row, settingsOf(settings));
	if (!result.product) throw new Usage(`商品稿还缺：${result.problems.join("；")}`);
	return result.product;
}

export async function previewListingReview(sql: Sql, input: z.output<typeof listingReviewPreviewParams>) {
	const [row] = await sql<ListingRow[]>`select * from listings where id = ${input.id}`;
	if (!row) throw new Usage(`没有商品稿 ${input.id}`);
	const product = await currentProduct(sql, row);
	return {
		id: input.id,
		shop: row.shop,
		expectedKey: auditKey(product),
		title: product.title,
		description: product.description,
		tiers: specNames(product),
		images: reviewImages(product).map((id) => ({ id, role: roleOf(product, id) })),
		before: row.audit,
	};
}

export async function setListingReview(sql: Sql, input: Input) {
	return sql.begin(async (tx) => {
		const [row] = await tx<ListingRow[]>`select * from listings where id = ${input.id} for update`;
		if (!row) throw new Usage(`没有商品稿 ${input.id}`);
		const product = await currentProduct(tx, row),
			audit = makeReviewedAudit(product, input);
		await tx`update listings set audit = ${tx.json(audit as Json)}, updated_at = now() where id = ${input.id}`;
		return { id: input.id, shop: row.shop, audit, imageCount: audit.reviewedImageIds!.length };
	});
}
