// 跨店复制只搬已保存的商品事实；目标上传记录和站点身份独立建立，不重读货源或重排人工规格。
import { z } from "zod";
import type { Json, Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { makeImages } from "./images.ts";
import { imageModeOf, type Pic, type Pics } from "./pics.ts";
import { usedPics } from "./product.ts";
import { purchaseLimitOf } from "./purchase-limit.ts";
import { inShopQueued } from "./queue.ts";
import { ListingId, type ListingRow, type ShopSettingsRow } from "./row.ts";
import { specsOf } from "./variants.ts";

export const COPY_IMAGES_PENDING = "目标店图片待上传";
export const copyParams = z.object({
	id: ListingId.describe("源商品稿编号"),
	shop: z.string().trim().min(1).describe("目标店"),
	why: z.string().trim().min(1).optional().describe("本次跨店复制的理由"),
	evidence: z.string().trim().min(1).optional().describe("本次授权或依据"),
});
export const copyImagesParams = z.object({ id: ListingId.describe("目标商品稿编号") });
type CopyInput = z.output<typeof copyParams>;
const roles = ["main", "detail", "options"] as const;
const lines = (s: string | null) => (s ?? "").split("\n").filter(Boolean);
const plainPic = (p: Pic): Pic => ({ from: p.from, sha: p.sha, width: p.width, height: p.height });

function checkPlan(pics: Partial<Pics>, variants: unknown): Pics {
	if (imageModeOf(undefined, pics) !== "original") throw new Usage("跨店复制需要已保存的 original 图片计划");
	const specs = specsOf(variants);
	if (!specs) throw new Usage("源稿缺可识别的规格，不能复制");
	const plan: Pics = { imageMode: "original", main: pics.main ?? [], detail: pics.detail ?? [], options: pics.options ?? [] };
	if (!plan.main.length || plan.main.length > 9 || plan.detail.length > 12) throw new Usage("原图计划的主图或详情图数量不合要求");
	const shas = new Map<string, string>();
	for (const role of roles) {
		if (role === "options" && new Set(plan[role].map((p) => p.from)).size !== plan[role].length) throw new Usage("原图计划的规格图来源重复");
		for (const p of plan[role]) {
			if (!p.from || !p.sha || !/^[a-f\d]{64}$/i.test(p.sha) || p.drop) throw new Usage("原图计划缺来源、SHA或包含停用图");
			if (shas.has(p.from) && shas.get(p.from) !== p.sha) throw new Usage("同一原图URL的SHA不一致");
			shas.set(p.from, p.sha);
		}
	}
	const options = new Set(plan.options.map((p) => p.from));
	if ((specs.tiers[0]?.options ?? []).some((o) => o.image && !options.has(o.image))) throw new Usage("原图计划缺少已用规格图，不能清空规格图片复制");
	return plan;
}

/** 只取源商品实际采用的原图角色，去掉源店的上传身份和处理结果。 */
export function originalCopyPlan(source: ListingRow): Pics {
	if (imageModeOf(undefined, source.images) !== "original") throw new Usage("跨店复制需要已保存的 original 图片计划");
	const removed = new Set(source.removed_images ?? []);
	const specs = specsOf(source.variants);
	const optionUrls = new Set(specs?.tiers[0]?.options.map((o) => o.image));
	return checkPlan(
		{
			imageMode: "original",
			main: usedPics(source.images, "main", removed).map(({ pic }) => plainPic(pic)),
			detail: usedPics(source.images, "detail", removed).map(({ pic }) => plainPic(pic)),
			options: (source.images.options ?? []).filter((p) => p.imageId && !p.drop && !removed.has(p.imageId) && optionUrls.has(p.from)).map(plainPic),
		},
		source.variants,
	);
}

export function copyDraftFields(source: ListingRow, sourceShop: Pick<ShopSettingsRow, "shop_id" | "min_purchase">, p: CopyInput) {
	if (source.shop === p.shop) throw new Usage("源店与目标店相同，不能跨店复制");
	if (!source.offer) throw new Usage("源稿缺货源快照，不能复制");
	const sourceUrl = source.product_id ? `https://shopee.tw/product/${sourceShop.shop_id}/${source.product_id}` : null;
	const provenance = `listing copy：源稿 #${source.id}（${source.shop}）${sourceUrl ? ` ${sourceUrl}` : ""} → ${p.shop}`;
	return structuredClone({
		shop: p.shop,
		offer_id: source.offer_id,
		strategy: source.strategy,
		cancelled: false,
		weight_kg: source.weight_kg,
		...(source.weight_override !== undefined ? { weight_override: source.weight_override } : {}),
		freight_rmb: source.freight_rmb,
		min_purchase: purchaseLimitOf(source, sourceShop.min_purchase),
		title: source.title,
		description: source.description,
		note: source.note,
		noted: source.noted,
		nickname: source.nickname,
		offer: source.offer,
		offer_read_at: source.offer_read_at,
		category_id: source.category_id,
		category_path: source.category_path,
		category_name: source.category_name,
		attributes: source.attributes,
		attributes_text: source.attributes_text,
		days_to_ship: source.days_to_ship,
		variants: source.variants,
		images: originalCopyPlan(source),
		pricing: source.pricing,
		audit: null,
		problems: [...new Set([...lines(source.problems), COPY_IMAGES_PENDING])].join("\n"),
		step: null,
		step_detail: null,
		product_id: null,
		listed_at: null,
		removed_images: [],
		removed_variants: source.removed_variants,
		kept_images: [],
		pick_why: [...lines(source.pick_why), ...(p.why ? [`跨店复制：${p.why}`] : [])].join("\n") || null,
		pick_evidence: [...lines(source.pick_evidence), provenance, ...(p.evidence ? [`本次依据：${p.evidence}`] : [])].join("\n"),
		pick_snapshot: source.pick_snapshot,
	});
}

const jsonFields = new Set([
	"offer",
	"category_path",
	"attributes",
	"variants",
	"images",
	"pricing",
	"audit",
	"removed_images",
	"removed_variants",
	"kept_images",
	"pick_snapshot",
]);

export async function copyDraft(sql: Sql, p: CopyInput) {
	return sql.begin(async (tx) => {
		const [source] = await tx<ListingRow[]>`select * from listings where id = ${p.id} for share`;
		if (!source) throw new Usage(`没有商品稿 ${p.id}`);
		if (source.shop === p.shop) throw new Usage("源店与目标店相同，不能跨店复制");
		const [target] = await tx<ShopSettingsRow[]>`select * from shop_settings where shop = ${p.shop}`;
		if (!target) throw new Usage(`没有「${p.shop}」这家店`);
		const [existing] = await tx<{ id: ListingId }[]>`select id::text from listings where shop = ${p.shop} and offer_id = ${source.offer_id}`;
		const result = (id: ListingId, isNew: boolean) => ({ id, sourceId: source.id, sourceShop: source.shop, shop: p.shop, offerId: source.offer_id, isNew });
		if (existing) return result(existing.id, false);
		const [sourceShop] = await tx<ShopSettingsRow[]>`select * from shop_settings where shop = ${source.shop}`;
		if (!sourceShop) throw new Usage(`没有源店「${source.shop}」的设置`);
		const fields = copyDraftFields(source, sourceShop, p);
		const stored = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, jsonFields.has(k) && v !== null && v !== undefined ? tx.json(v as Json) : v]));
		const [inserted] = await tx<{ id: ListingId }[]>`insert into listings ${tx(stored)} on conflict (shop, offer_id) do nothing returning id::text`;
		if (inserted) return result(inserted.id, true);
		const [raced] = await tx<{ id: ListingId }[]>`select id::text from listings where shop = ${p.shop} and offer_id = ${source.offer_id}`;
		if (!raced) throw new Usage("目标稿并发变化，未保存复制稿");
		return result(raced.id, false);
	});
}

export function copiedImageIds(plan: Pics, uploaded: Pics): string[] {
	if (uploaded.imageMode !== "original") throw new Usage("目标店回传图片不是 original 模式");
	const ids: string[] = [];
	for (const role of roles) {
		if (uploaded[role].length !== plan[role].length) throw new Usage(`目标店${role}图片数量与原图计划不一致`);
		for (const [i, expected] of plan[role].entries()) {
			const got = uploaded[role][i]!;
			if (got.from !== expected.from || got.sha !== expected.sha || got.final !== expected.sha || !got.imageId || got.drop || got.translated)
				throw new Usage(`目标店${role}图片的来源、SHA或上传结果与原图计划不一致`);
			ids.push(got.imageId);
		}
	}
	return [...new Set(ids)];
}

function draftOnly(row: ListingRow): void {
	if (row.product_id !== null || row.listed_at !== null) throw new Usage("商品已经建成或上架；copy-images 不修改现有商品");
}
const imageState = (l: ListingRow) => JSON.stringify([l.shop, l.offer_id, l.variants, l.images, l.removed_images, l.kept_images]);

export async function copyImages(sql: Sql, p: z.output<typeof copyImagesParams>, maker: typeof makeImages = makeImages) {
	const [row] = await sql<ListingRow[]>`select * from listings where id = ${p.id}`;
	if (!row) throw new Usage(`没有商品稿 ${p.id}`);
	draftOnly(row);
	if (row.removed_images?.length) throw new Usage("目标稿已有人移除图片，请先核对图片计划");
	const plan = checkPlan(row.images, row.variants);
	if (!lines(row.problems).includes(COPY_IMAGES_PENDING)) {
		const kept = copiedImageIds(plan, plan);
		return { id: p.id, shop: row.shop, imageMode: "original" as const, uploadedImages: kept.length, changed: false, problems: lines(row.problems) };
	}
	const [shop] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${row.shop}`;
	if (!shop) throw new Usage(`没有「${row.shop}」这家店`);
	const before = imageState(row);
	const uploaded = await maker(sql, {
		shop: row.shop,
		mark: null,
		imageMode: "original",
		main: plan.main.map((p) => p.from),
		detail: plan.detail.map((p) => p.from),
		options: plan.options.map((p) => p.from),
		browser: (fn) => inShopQueued(shop.shop_id, fn),
	});
	const kept = copiedImageIds(plan, uploaded);
	return sql.begin(async (tx) => {
		const [fresh] = await tx<ListingRow[]>`select * from listings where id = ${p.id} for update`;
		if (!fresh) throw new Usage(`没有商品稿 ${p.id}`);
		draftOnly(fresh);
		if (imageState(fresh) !== before) throw new Usage("目标稿的规格或图片计划已变化，未覆盖人工修改；请重新核对后再运行");
		const problems =
			lines(fresh.problems)
				.filter((line) => line !== COPY_IMAGES_PENDING)
				.join("\n") || null;
		const changed =
			JSON.stringify(fresh.images) !== JSON.stringify(uploaded) || JSON.stringify(fresh.kept_images) !== JSON.stringify(kept) || problems !== fresh.problems;
		if (changed)
			await tx`update listings set images = ${tx.json(uploaded as Json)}, kept_images = ${tx.json(kept)}, audit = null,
				problems = ${problems}, updated_at = now() where id = ${p.id}`;
		return { id: p.id, shop: row.shop, imageMode: "original" as const, uploadedImages: kept.length, changed, problems: lines(problems) };
	});
}
