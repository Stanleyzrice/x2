// 显式人工/Codex审阅：核对当前内容指纹和完整逐图结果，只保存审阅来源与证据，不调用或冒充 Gemini。
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import { productInfo } from "../../connectors/sites/shopee/products.ts";
import { ItemId } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import type { Json, Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { parseJson } from "../../platform/tool.ts";
import { addSizeParams, buildAddSize } from "./add-size.ts";
import { type Audit, auditKey, reviewImages, roleOf, specNames, uniqIssues } from "./audit.ts";
import { editImageTarget, editParams } from "./edit.ts";
import { buildExpand, expandParams } from "./expand.ts";
import {
	type FinalImageProduct,
	imageLanguageReviewKey,
	imageLanguageSnapshot,
	imageLanguageVerdict,
	rememberExistingImageFiles,
	saveImageLanguageReviews,
	variantImageTarget,
} from "./image-language.ts";
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
					language: imageLanguageVerdict.optional(),
					where: z.enum(["印在商品上", "后加的文案"]).optional(),
				}),
			),
		)
		.describe("逐张图片结果 JSON，完整覆盖 preview 的图片ID；language 填 state、sha256、evidence，实物印字通过另填 note"),
});
const proposal = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("edit"), input: editParams }),
	z.object({ kind: z.literal("expand"), input: expandParams }),
	z.object({ kind: z.literal("add-size"), input: addSizeParams }),
]);
const target = z.object({
	id: ListingId.optional().describe("未建商品稿编号"),
	shop: z.string().trim().min(1).optional().describe("已建商品所在的店铺账号名"),
	productId: ItemId.optional().describe("已建商品的 Shopee 商品编号"),
	proposal: z.preprocess(parseJson, proposal).optional().describe("换图时传 {kind: edit|expand|add-size, input: 对应操作的参数}"),
});
const validTarget = (p: z.output<typeof target>) => (p.id ? !p.shop && !p.productId && !p.proposal : Boolean(p.shop && p.productId));
const targetMessage = "请指定商品稿 id，或已建商品的 shop 与 productId";
export const listingReviewPreviewParams = target.refine(validTarget, targetMessage);
export const listingReviewParams = target.extend(content.shape).refine(validTarget, targetMessage);
type Target = z.output<typeof target>;
type Input = z.output<typeof listingReviewParams>;

export function reviewedAuditEditable(row: Pick<ListingRow, "product_id" | "listed_at">): void {
	if (row.product_id !== null || row.listed_at !== null) throw new Usage("商品已经建成或上架；草稿审阅工具不修改现有商品");
}

/** 完整逐图结果与当前内容绑定；任何旧指纹、漏图、重复或外来图片都拒绝。 */
export function makeReviewedAudit(p: Product, input: z.output<typeof content>, at = new Date().toISOString()): Audit {
	const v = content.parse(input);
	if (v.expectedKey !== auditKey(p)) throw new Usage("审阅后文案、图片或规格已变化，请重新 review-preview 并审阅");
	const expected = reviewImages(p);
	completeImages(expected, v.images);
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

function completeImages(expected: string[], images: { id: string }[]): void {
	const seen = new Set(images.map((x) => x.id));
	if (seen.size !== images.length) throw new Usage("审阅结果有重复图片ID");
	if (seen.size !== expected.length || !expected.every((id) => seen.has(id))) throw new Usage("审阅结果必须完整覆盖当前所有图片，不能漏图或添加外来图片");
}

async function draftReview(sql: Sql | postgres.TransactionSql, row: ListingRow) {
	reviewedAuditEditable(row);
	if (row.cancelled) throw new Usage("商品稿已放弃，不保存审阅");
	const [settings] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${row.shop}`;
	if (!settings) throw new Usage(`没有店铺设置 ${row.shop}`);
	const { product, info, problems } = productOf(row, settingsOf(settings));
	if (!product || !info) throw new Usage(`商品稿还缺：${problems.join("；")}`);
	const snapshot = await imageLanguageSnapshot(sql, row.shop, info);
	const expectedKey = createHash("sha256")
		.update(JSON.stringify([auditKey(product), imageLanguageReviewKey(snapshot)]))
		.digest("hex");
	return { expectedKey, product, snapshot };
}

async function existingReview(sql: Sql, shop: string, productId: string, proposal: Target["proposal"], capture = false) {
	if (proposal && (proposal.input.shop !== shop || proposal.input.id !== productId)) throw new Usage("拟修改的店铺或商品与审阅目标不符");
	const [settings] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${shop}`;
	if (!settings) throw new Usage(`没有店铺设置 ${shop}`);
	const now = await inAccount("shopee", settings.shop_id, () => productInfo(productId));
	if (now.id != null && String(now.id) !== productId) throw new Usage("Shopee 回读商品编号不匹配");
	let final: FinalImageProduct = now;
	let title = now.name;
	switch (proposal?.kind) {
		case "edit":
			final = editImageTarget(now, proposal.input);
			title = proposal.input.title;
			break;
		case "expand": {
			const built = buildExpand(now, proposal.input);
			if (proposal.input.beforeHash && proposal.input.beforeHash !== built.currentHash) throw new Usage("原商品或规格已变：重新预览");
			final = variantImageTarget(now, built.info);
			break;
		}
		case "add-size": {
			const built = buildAddSize(now, proposal.input);
			if (proposal.input.beforeHash && proposal.input.beforeHash !== built.currentHash) throw new Usage("原商品或规格已变：重新预览");
			final = variantImageTarget(now, built.info);
			title = proposal.input.title;
			break;
		}
	}
	let snapshot = await imageLanguageSnapshot(sql, shop, final);
	if (capture && (await rememberExistingImageFiles(sql, shop, now, snapshot))) snapshot = await imageLanguageSnapshot(sql, shop, final);
	const tiers = final.std_tier_variation_list ?? [];
	const expectedKey = createHash("sha256")
		.update(JSON.stringify([shop, productId, title, imageLanguageReviewKey(snapshot)]))
		.digest("hex");
	return { snapshot, shop, productId, title, tiers, expectedKey };
}

export async function previewListingReview(sql: Sql, input: z.output<typeof listingReviewPreviewParams>) {
	if (!input.id) {
		const { snapshot, ...current } = await existingReview(sql, input.shop!, input.productId!, input.proposal, true);
		return { ...current, images: snapshot.images, description: snapshot.text.join("\n"), ruleVersion: snapshot.ruleVersion };
	}
	const [row] = await sql<ListingRow[]>`select * from listings where id = ${input.id}`;
	if (!row) throw new Usage(`没有商品稿 ${input.id}`);
	const { product, snapshot, expectedKey } = await draftReview(sql, row);
	return {
		id: input.id,
		shop: row.shop,
		expectedKey,
		title: product.title,
		description: product.description,
		tiers: specNames(product),
		images: snapshot.images.map((image) => ({ ...image, role: roleOf(product, image.id) })),
		ruleVersion: snapshot.ruleVersion,
		before: row.audit,
	};
}

export async function setListingReview(sql: Sql, input: Input) {
	if (!input.id) {
		const { snapshot, expectedKey, shop, productId } = await existingReview(sql, input.shop!, input.productId!, input.proposal);
		if (input.expectedKey !== expectedKey) throw new Usage("审阅后最终图片或适用规格已变化，请重新 review-preview 并审阅");
		completeImages(
			snapshot.images.map((image) => image.id),
			input.images,
		);
		const images = await sql.begin((tx) => saveImageLanguageReviews(tx, shop, snapshot, input.provider, input.images));
		return { shop, productId, ...languageReceipt(snapshot.ruleVersion, images) };
	}
	const id = input.id;
	return sql.begin(async (tx) => {
		const [row] = await tx<ListingRow[]>`select * from listings where id = ${id} for update`;
		if (!row) throw new Usage(`没有商品稿 ${input.id}`);
		const { product, snapshot, expectedKey } = await draftReview(tx, row);
		if (input.expectedKey !== expectedKey) throw new Usage("审阅后文案、图片或规格已变化，请重新 review-preview 并审阅");
		const audit = makeReviewedAudit(product, { ...input, expectedKey: auditKey(product) });
		const images = await saveImageLanguageReviews(tx, row.shop, snapshot, input.provider, input.images);
		await tx`update listings set audit = ${tx.json(audit as Json)}, updated_at = now() where id = ${id}`;
		return { id, shop: row.shop, audit, ...languageReceipt(snapshot.ruleVersion, images) };
	});
}

function languageReceipt(ruleVersion: number, images: Awaited<ReturnType<typeof saveImageLanguageReviews>>) {
	return { ruleVersion, imageCount: images.length, languagePassed: images.every((image) => !image.problem), images };
}
