// 已有二维规格只追加一个尺寸；旧规格只提交 id、索引和原价，避免把预览时的库存覆盖回去。
import { createHash } from "node:crypto";
import { z } from "zod";
import { type ProductInfo, productInfo } from "../../connectors/sites/shopee/products.ts";
import { ItemId, ModelId } from "../../connectors/sites/shopee/seller.ts";
import { type AddSizeInfo, addSizeInfo, addSizeProduct } from "../../connectors/sites/shopee/variants.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { parseJson, str } from "../../platform/tool.ts";
import { type WriteOp, writeOp } from "../../platform/writes.ts";
import { imageLanguageBlock, variantImageTarget } from "./image-language.ts";
import { catalogWriteBlock } from "./write-guard.ts";

const positiveId = (id: string) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0;
const extraModel = z.object({
	firstTierIndex: z.number().int().nonnegative(),
	sku: z.string().trim().min(1),
	price: z.number().positive().finite(),
	stock: z.number().int().nonnegative(),
});
export const addSizeParams = z.object({
	shop: str("店铺账号名"),
	id: ItemId.refine(positiveId).describe("Shopee 商品 id"),
	beforeHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional()
		.describe("预览返回的 currentHash；写入必须提供"),
	title: z.string().min(1).max(60).describe("新增尺寸后的完整标题"),
	descriptionInfo: z.preprocess(parseJson, addSizeInfo.shape.description_info).describe("对应的新 description_info JSON"),
	size: z.string().trim().min(1).max(20).describe("追加到第二层末尾的尺寸名"),
	models: z.preprocess(parseJson, z.array(extraModel).min(1)).describe("逐一级款式的新增规格 JSON，firstTierIndex、sku、price、stock 均明确提供"),
});
type Input = z.output<typeof addSizeParams>;
const oldModel = z.object({
	id: ModelId.refine(positiveId),
	name: z.string(),
	sku: z.string(),
	tierIndex: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
	price: z.number().positive().finite(),
});
const baselineShape = z.object({
	name: z.string(),
	descriptionInfo: addSizeInfo.shape.description_info,
	tiers: addSizeInfo.shape.std_tier_variation_list,
	models: z.array(oldModel),
	protectedFields: z.record(z.string(), z.unknown()),
});
type Baseline = z.output<typeof baselineShape>;

const protectedKeys = [
	"parent_sku",
	"category_path",
	"images",
	"long_images",
	"brand_info",
	"authorised_brand_id",
	"brand_license_info",
	"attributes",
	"pre_order_info",
	"enable_model_level_dts",
	"weight",
	"dimension",
	"dangerous_goods",
	"min_purchase_limit",
	"max_purchase_limit_info",
	"condition",
	"size_chart_info",
	"video_list",
	"wholesale_list",
	"tax_setting",
	"is_unlisted",
	"status",
] as const;

/** 对象键和回包规格顺序不影响快照；库存不在要覆盖的字段里，也不参与旧规格快照。 */
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) => {
		if (!v || typeof v !== "object" || Array.isArray(v)) return v;
		return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)));
	});
}
function snapshot(now: ProductInfo): Baseline {
	const tiers = addSizeInfo.shape.std_tier_variation_list.parse(now.std_tier_variation_list);
	if (tiers.length !== 2 || tiers.some((tier) => !tier.value_list.length)) throw new Usage("只支持已有完整两层规格的商品");
	if (tiers.some((tier) => new Set(tier.value_list.map((v) => v.custom_value)).size !== tier.value_list.length))
		throw new Usage("原规格选项名重复，不追加尺寸");
	const models = (now.model_list ?? [])
		.map((m) =>
			oldModel.parse({
				id: m.id,
				name: m.name,
				sku: m.sku,
				tierIndex: m.tier_index?.map(Number),
				price: Number(m.price_info?.input_normal_price ?? m.price_info?.normal_price),
			}),
		)
		.sort((a, b) => a.id.localeCompare(b.id));
	if (models.length !== tiers[0]!.value_list.length * tiers[1]!.value_list.length || new Set(models.map((m) => m.id)).size !== models.length)
		throw new Usage("原规格数量不完整或 id 重复，不追加尺寸");
	const indexes = new Set(models.map((m) => m.tierIndex.join(",")));
	if (indexes.size !== models.length || models.some((m) => m.tierIndex[0] >= tiers[0]!.value_list.length || m.tierIndex[1] >= tiers[1]!.value_list.length))
		throw new Usage("原规格索引重复或越界，不追加尺寸");
	return baselineShape.parse({
		name: now.name,
		descriptionInfo: now.description_info,
		tiers,
		models,
		protectedFields: Object.fromEntries(protectedKeys.filter((key) => now[key] !== undefined).map((key) => [key, now[key]])),
	});
}
const hash = (baseline: Baseline) => createHash("sha256").update(canonical(baseline)).digest("hex");
export const addSizeHash = (now: ProductInfo): string => hash(snapshot(now));

export function buildAddSize(now: ProductInfo, p: Input): { baseline: Baseline; info: AddSizeInfo; currentHash: string } {
	const baseline = snapshot(now);
	if (baseline.tiers[1]!.value_list.some((option) => option.custom_value === p.size)) throw new Usage("这个尺寸已经存在，不重复新增");
	const count = baseline.tiers[0]!.value_list.length;
	if (p.models.length !== count || new Set(p.models.map((m) => m.firstTierIndex)).size !== count || p.models.some((m) => m.firstTierIndex >= count))
		throw new Usage("新增规格必须逐一级款式各有一项，索引不能重复或越界");
	const oldSkus = new Set(baseline.models.map((m) => m.sku));
	if (new Set(p.models.map((m) => m.sku)).size !== count || p.models.some((m) => oldSkus.has(m.sku))) throw new Usage("新增规格货号重复或与旧规格冲突");
	const newIndex = baseline.tiers[1]!.value_list.length;
	const tiers = structuredClone(baseline.tiers);
	tiers[1]!.value_list.push({ custom_value: p.size, id: 0 });
	const info = addSizeInfo.parse({
		name: p.title,
		description_info: p.descriptionInfo,
		std_tier_variation_list: tiers,
		model_list: [
			...baseline.models.map((m) => ({ id: m.id, tier_index: m.tierIndex, price: String(m.price) })),
			...p.models.map((m) => ({
				id: 0,
				tier_index: [m.firstTierIndex, newIndex],
				price: String(m.price),
				sku: m.sku,
				stock_setting_list: [{ sellable_stock: m.stock }],
				is_default: false,
				confirm_empty_gtin: false,
				gtin_code: "",
				sku_image: baseline.tiers[0]!.value_list[m.firstTierIndex]!.image_id ?? "",
			})),
		],
	});
	return { baseline, info, currentHash: hash(baseline) };
}

/** 旧规格按 id、新规格按货号核对；旧库存可因订单变化，不做覆盖也不要求保持。 */
export function addSizeState(now: ProductInfo, baseline: Baseline, p: Input, info: AddSizeInfo): true | null {
	try {
		if (now.name !== p.title || canonical(now.description_info) !== canonical(info.description_info)) return null;
		const protectedFields = Object.fromEntries(protectedKeys.filter((key) => now[key] !== undefined).map((key) => [key, now[key]]));
		if (canonical(protectedFields) !== canonical(baseline.protectedFields)) return null;
		if (canonical(now.std_tier_variation_list) !== canonical(info.std_tier_variation_list)) return null;
		const models = now.model_list ?? [];
		if (models.length !== info.model_list.length || new Set(models.map((m) => m.id)).size !== models.length) return null;
		for (const old of baseline.models) {
			const got = models.find((m) => m.id === old.id);
			if (
				!got ||
				got.sku !== old.sku ||
				got.name !== old.name ||
				canonical(got.tier_index?.map(Number)) !== canonical(old.tierIndex) ||
				Number(got.price_info?.input_normal_price ?? got.price_info?.normal_price) !== old.price
			)
				return null;
		}
		for (const extra of p.models) {
			const matches = models.filter((m) => m.sku === extra.sku);
			const got = matches[0];
			const tierIndex = [extra.firstTierIndex, baseline.tiers[1]!.value_list.length];
			const expectedName = `${baseline.tiers[0]!.value_list[extra.firstTierIndex]!.custom_value},${p.size}`;
			const expectedImage = baseline.tiers[0]!.value_list[extra.firstTierIndex]!.image_id ?? "";
			if (
				matches.length !== 1 ||
				!got?.id ||
				!positiveId(got.id) ||
				baseline.models.some((m) => m.id === got.id) ||
				got.name !== expectedName ||
				canonical(got.tier_index?.map(Number)) !== canonical(tierIndex) ||
				Number(got.price_info?.input_normal_price ?? got.price_info?.normal_price) !== extra.price ||
				Number(got.stock_detail?.total_seller_stock) !== extra.stock ||
				got.sku_image !== expectedImage
			)
				return null;
		}
		return true;
	} catch {
		return null;
	}
}

async function shopIdOf(sql: Sql, shop: string): Promise<string> {
	const [row] = await sql<{ shop_id: string }[]>`select shop_id from shop_settings where shop = ${shop}`;
	if (!row) throw new Usage(`店铺设置里没有 ${shop}`);
	return row.shop_id;
}
export async function previewAddSize(sql: Sql, p: Input) {
	const shopId = await shopIdOf(sql, p.shop);
	return inAccount("shopee", shopId, async () => {
		const now = await productInfo(p.id);
		const built = buildAddSize(now, p);
		if (p.beforeHash && p.beforeHash !== built.currentHash) throw new Usage("商品内容或原规格已变：重新预览，不覆盖");
		return { ...p, shopId, parentSku: now.parent_sku ?? "", ...built, checkedAt: new Date().toISOString() };
	});
}
export async function planAddSize(sql: Sql, p: Input) {
	if (!p.beforeHash) throw new Usage("先预览，再传 currentHash 作为 beforeHash");
	const preview = await previewAddSize(sql, p);
	return [[{ op: "追加尺寸", params: { ...p, shopId: preview.shopId, parentSku: preview.parentSku, baseline: preview.baseline, info: preview.info } }]];
}

const params = addSizeParams.extend({
	beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
	shopId: z.string(),
	parentSku: z.string(),
	baseline: baselineShape,
	info: addSizeInfo,
});
type Params = z.output<typeof params>;
const op: WriteOp<Params, Baseline> = {
	describe: "现有商品追加一个第二层尺寸及相应标题、描述",
	params,
	target: (p) => `shopee:${p.shopId}:${p.parentSku || p.id}`,
	key: (p) =>
		`add-size:${p.shopId}:${p.id}:${createHash("sha256")
			.update(canonical([p.beforeHash, p.info]))
			.digest("hex")}`,
	display: (p) =>
		`${p.shop}（商品 ${p.id}）追加尺寸 ${p.size}，${p.models.length} 个规格：${p.models.map((m) => `${m.sku} NT$${m.price} 库存${m.stock}`).join("；")}`,
	untried: "追加尺寸是新写操作：先和人约一个商品一起跑 --try，回读后请人在站点核对",
	where: (_sql, p, fn) => inAccount("shopee", p.shopId, fn),
	async prepare(sql, p) {
		if ((await shopIdOf(sql, p.shop)) !== p.shopId) return { skip: "店铺设置刚改过：重新确认店铺" };
		const blocked = await catalogWriteBlock(sql, { ...p, productId: p.id });
		if (blocked) return { skip: blocked };
		const now = await productInfo(p.id);
		if ((now.parent_sku ?? "") !== p.parentSku || addSizeHash(now) !== p.beforeHash) return { skip: "商品内容或原规格已变：重新预览，不覆盖" };
		const built = buildAddSize(now, p);
		if (canonical(built.info) !== canonical(p.info) || canonical(built.baseline) !== canonical(p.baseline)) return { skip: "预览与写入内容不同，不提交" };
		const language = await imageLanguageBlock(sql, p.shop, `商品 ${p.id}`, variantImageTarget(now, built.info));
		if (language) return { skip: language };
		return { params: p, before: built.baseline };
	},
	submit: (_sql, p) => addSizeProduct.submit({ productId: p.id, info: p.info }),
	async check(p, before, fresh) {
		for (let n = 0; n < (fresh ? 3 : 1); n++) {
			if (n) await new Promise((ok) => setTimeout(ok, 2000));
			const now = await productInfo(p.id);
			const done = addSizeState(now, before ?? p.baseline, p, p.info);
			if (done || !fresh || n === 2)
				return { done, readback: { productId: p.id, title: now.name, models: now.model_list, tiers: now.std_tier_variation_list } };
		}
		return { done: null, readback: null };
	},
};
export const ADD_SIZE_WRITES = { 追加尺寸: writeOp(op) };
