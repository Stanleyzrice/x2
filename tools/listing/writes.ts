// 上品的写：建商品、上架（Shopee，经至多一次写入）。写入引擎（platform/writes.ts）按 prepare → 记意图 → submit → check 调；
// prepare 是业务上的保护：建商品前照商品稿现组一遍，和人同意时交给 x2 的一样才建
import { z } from "zod";
import { channels, type ProductInfo, productInfo, productPage } from "../../connectors/sites/shopee/products.ts";
import { createListing, findByParentSku, listProduct } from "../../connectors/sites/shopee/publish.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import { db, type Sql } from "../../platform/db/index.ts";
import { type WriteOp, writeOp } from "../../platform/writes.ts";
import { type Audit, listingAuditCurrent } from "./audit.ts";
import { channelOptionSchema } from "./channels.ts";
import { coverageBlock } from "./coverage.ts";
import { followUpBatchId } from "./follow-up.ts";
import { imageLanguageBlock } from "./image-language.ts";
import type { ImageMode } from "./pics.ts";
import { minPrice } from "./price.ts";
import { settingsOf } from "./pricing.ts";
import { type Product, readbackProblems, type SentInfo } from "./product.ts";
import { productOf } from "./ready.ts";
import { ListingId, type ListingRow, type ShopSettingsRow } from "./row.ts";
import { originalSourceApproved, type SourceApproval, sourcePublicationHash } from "./source-data.ts";
import { catalogWriteBlock } from "./write-guard.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listingNow(sql: Sql, id: ListingId) {
	const [l] = await sql<ListingRow[]>`select * from listings where id = ${id}`;
	if (!l) return null;
	const [row] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${l.shop}`;
	const s = settingsOf(row!);
	return { l, s, r: productOf(l, s) };
}

/** 写入意图已登记后再查来源；短暂的源行共享锁与备选区删除事务协调，不跨外站请求持锁。 */
async function sourceWriteBlock(sql: Sql, listingId: ListingId): Promise<string | null> {
	const [source] = await sql<
		{ deleted_at: Date | null }[]
	>`select s.deleted_at from listing_sources s join listings l on l.source_product_id = s.id where l.id = ${listingId} for share of s`;
	return source?.deleted_at ? "商品已从备选区移除，本次未提交；重新采集后须重新确认上架" : null;
}

const createParams = z.object({
	listingId: ListingId,
	shop: z.string(),
	shopId: z.string(),
	parentSku: z.string(),
	// 检查时照 productInfo() 组的（ready.ts）；prepare 用现组的原生字段替换提交参数
	productInfo: z.record(z.string(), z.unknown()).pipe(z.custom<SentInfo>()),
	hash: z.string(),
	channelOptions: z.array(channelOptionSchema).optional(),
	name: z.string().optional(),
});
type CreateP = z.infer<typeof createParams>;

type SourceReview = { approval: SourceApproval | null | undefined; id: string | null | undefined; imageMode: ImageMode | undefined; hash: string | undefined };

/** 只保护首次建商品；已有商品上架沿用原流程，不给其追加草稿审阅要求。 */
export const creationReviewBlock = (audit: Partial<Audit> | null, product: Product, source?: SourceReview): string | null =>
	listingAuditCurrent(audit, product, source?.imageMode) || (source && originalSourceApproved(source.approval, source.id, source.imageMode, source.hash))
		? null
		: "商品稿的文案、图片或规格尚未完成当前审核：重新审阅后再建商品";

/** 人工备选商品上架前现验图片模式对应的审核依据。 */
export function sourceLiveReviewBlock(audit: Partial<Audit> | null, product: Product | undefined, source: SourceReview): string | null {
	if (source.imageMode === "processed" || source.imageMode === "reviewed")
		return product && listingAuditCurrent(audit, product, source.imageMode) ? null : "备选商品的文案、图片或规格尚未完成当前审核：重新审阅后再上架";
	return originalSourceApproved(source.approval, source.id, source.imageMode, source.hash) ? null : "备选商品的上架批准已撤销或内容变化，请重新确认上架";
}

const createOp: WriteOp<CreateP> = {
	describe: "在 Shopee 上建商品（先建成下架）",
	params: createParams,
	target: (p) => `shopee:${p.shopId}:${p.parentSku}`,
	key: (p) => `create:${p.shop}:${p.parentSku}`,
	display: (p) => `建商品 ${p.name ?? `${p.shop}「${String(p.productInfo.name ?? "").slice(0, 24)}」`}`,
	where: (_sql, p, fn) => inAccount("shopee", p.shopId, fn),
	async prepare(sql, p) {
		const blocked = await catalogWriteBlock(sql, p);
		if (blocked) return { skip: blocked };
		const removed = await sourceWriteBlock(sql, p.listingId);
		if (removed) return { skip: removed };
		const now = await listingNow(sql, p.listingId);
		if (!now || now.l.cancelled) return { skip: "商品稿已放弃" };
		if (now.l.shop !== p.shop || now.s.shopId !== p.shopId || (now.r.product?.parentSku && now.r.product.parentSku !== p.parentSku))
			return { skip: "当前商品稿与计划店铺或商品身份不符" };
		if (now.l.product_id) return { skip: `已经建好了（商品 ${now.l.product_id}）` };
		if (now.s.paused) return { skip: `暂停上品：${now.s.paused}` };
		if (!now.r.info) return { skip: `商品稿还缺：${now.r.problems.join("；")}` };
		if (now.r.hash !== p.hash) return { skip: "商品稿刚改过：给人重新看过再 x2 listing publish --ids …" };
		const coverage = coverageBlock(now.l, now.r.product!);
		if (coverage) return { skip: coverage };
		const reviewBlock = creationReviewBlock(now.l.audit, now.r.product!, {
			approval: now.l.source_approval,
			id: now.l.source_product_id,
			imageMode: now.l.images.imageMode,
			hash: now.r.hash,
		});
		if (reviewBlock) return { skip: reviewBlock };
		const language = await imageLanguageBlock(sql, now.l.shop, `商品稿 #${p.listingId}`, now.r.info);
		if (language) return { skip: language };
		// 模板的上下限、快照由 productOf 现核；只给旧结算模型再核最低金额，不能叠加到模板上。
		if (!now.s.template) {
			const freight = Number(now.l.pricing?.freightRmb ?? 0);
			for (const v of now.r.product!.variants) {
				const min = minPrice(v.costRmb, freight, v.weightKg!, now.s.params, now.s.preOrder);
				if (min === null || min > v.priceTwd) return { skip: `按现在的店铺设置，规格 ${v.sku} 的售价 NT$${v.priceTwd} 不够（要 ${min ?? "—"}）：重新做商品稿` };
			}
		}
		await productPage();
		return { params: { ...p, productInfo: now.r.info }, before: {} };
	},
	async submit(sql, p) {
		const w = await createListing.submit({ productInfo: p.productInfo });
		if (w.kind === "done")
			await sql`update listings set product_id = ${(w.data as { productId: string }).productId}, updated_at = now() where id = ${p.listingId}`;
		return w;
	},
	async check(p) {
		const sql = await db();
		const [row] = await sql<{ product_id: string | null }[]>`select product_id from listings where id = ${p.listingId}`;
		let id = row!.product_id;
		if (!id) {
			id = await findByParentSku(p.parentSku, String(p.productInfo.name));
			if (!id) return { done: null, readback: { found: false } };
			await sql`update listings set product_id = ${id}, updated_at = now() where id = ${p.listingId}`;
		}
		// 读回对账：读回来和提交的 product_info 逐项比。刚建完读得到要几秒：对不上就隔 3 秒再读，最多 3 次
		let problems: string[] = [];
		for (let i = 0; i < 3; i++) {
			if (i) await sleep(3000);
			const info = await productInfo(id);
			const path = (p.productInfo.category_path as number[]) ?? [];
			problems = readbackProblems(p.productInfo, info, await channels(id, path[path.length - 1]!), p.channelOptions);
			if (!problems.length) break;
		}
		return { done: problems.length === 0, readback: { productId: id, problems } };
	},
};

const liveParams = z.object({
	listingId: ListingId,
	shop: z.string(),
	shopId: z.string(),
	parentSku: z.string(),
	title: z.string().nullable().optional(),
	name: z.string().optional(),
	productId: z.string().optional(),
	trackingBatch: followUpBatchId.optional(),
});
type LiveP = z.infer<typeof liveParams>;

const liveOp: WriteOp<LiveP> = {
	describe: "把建好的商品上架（下架 → 在售）",
	params: liveParams,
	target: (p) => `shopee:${p.shopId}:${p.parentSku}`,
	key: (p) => `live:${p.shop}:${p.parentSku}`,
	display: (p) => `上架 ${p.name ?? `${p.shop}「${String(p.title ?? p.parentSku).slice(0, 24)}」`}`,
	where: (_sql, p, fn) => inAccount("shopee", p.shopId, fn),
	async prepare(sql, p) {
		const removed = await sourceWriteBlock(sql, p.listingId);
		if (removed) return { skip: removed };
		const [l] = await sql<ListingRow[]>`select * from listings where id = ${p.listingId}`;
		if (!l || l.cancelled) return { skip: "商品稿已放弃" };
		if (!l.product_id) return { skip: "还没建好（建商品没成功）" };
		const [settings] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${l.shop}`;
		if (p.shop !== l.shop || settings?.shop_id !== p.shopId) return { skip: "当前商品稿与计划店铺不符" };
		if (l.listed_at) return { skip: "已经上架了" };
		if (l.source_product_id || l.coverage) {
			const ready = productOf(l, settingsOf(settings));
			if (l.coverage) {
				const coverage = ready.product ? coverageBlock(l, ready.product) : ready.problems.join("；");
				if (coverage) return { skip: coverage };
			}
			if (l.source_product_id) {
				const reviewBlock = sourceLiveReviewBlock(l.audit, ready.product, {
					approval: l.source_approval,
					id: l.source_product_id,
					imageMode: l.images.imageMode,
					hash: sourcePublicationHash(l, ready.hash),
				});
				if (reviewBlock) return { skip: reviewBlock };
			}
		}
		const blocked = await catalogWriteBlock(sql, { ...p, productId: String(l.product_id) });
		if (blocked) return { skip: blocked };
		const productId = String(l.product_id);
		const current = await productInfo(productId);
		if (current.parent_sku !== p.parentSku || (current.id != null && String(current.id) !== productId)) return { skip: "Shopee 现读商品身份不匹配" };
		const language = await imageLanguageBlock(sql, l.shop, `商品稿 #${p.listingId}（商品 ${productId}）`, current);
		if (language) return { skip: language };
		return { params: { ...p, productId }, before: {} };
	},
	submit: (_sql, p) => listProduct.submit({ productId: p.productId! }),
	// 读回对账：在售是做了，禁卖是没做。翻在售以后要十几秒才读得到：隔 3 秒读一次，最多 6 次
	async check(p, _before, fresh) {
		let info: ProductInfo | null = null;
		for (let i = 0; i < (fresh ? 6 : 1); i++) {
			if (i) await sleep(3000);
			info = await productInfo(p.productId!);
			if (Number(info.status) === 1 && !info.is_unlisted) return { done: true, readback: { status: info.status } };
			if (Number(info.status) === 3) return { done: false, readback: { status: info.status, why: "禁卖" } };
		}
		return { done: null, readback: { status: info?.status ?? null, unlisted: info?.is_unlisted ?? null } };
	},
	async after(sql, p) {
		await sql`update listings set listed_at = now(), updated_at = now() where id = ${p.listingId}`;
	},
};

export const LISTING_WRITES: Record<string, WriteOp> = { 建商品: writeOp(createOp), 上架: writeOp(liveOp) };
