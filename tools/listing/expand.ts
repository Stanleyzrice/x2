// 按显式1688 SKU映射更新规格；旧模型保留库存和货号，可显式同时更新详情图。
import { createHash } from "node:crypto";
import { z } from "zod";
import { OfferId, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import { type ProductInfo, productInfo } from "../../connectors/sites/shopee/products.ts";
import { productDescriptionInfo } from "../../connectors/sites/shopee/publish.ts";
import { ItemId, ModelId } from "../../connectors/sites/shopee/seller.ts";
import { type ExpandInfo, expandInfo, expandProduct } from "../../connectors/sites/shopee/variants.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { parseJson, str } from "../../platform/tool.ts";
import { type WriteOp, writeOp } from "../../platform/writes.ts";
import { descriptionChange, descriptionState } from "./edit.ts";
import { imageLanguageBlock, variantImageTarget } from "./image-language.ts";
import { catalogWriteBlock, listingWriteTried } from "./write-guard.ts";

const positiveId = (id: string) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0;
const imageId = z.string().regex(/^[A-Za-z0-9_-]+$/, "规格图须是已上传的Shopee图片id");
const tier = z.object({
	name: z.string().trim().min(1).max(14),
	options: z.array(z.object({ name: z.string().trim().min(1).max(20), imageId: imageId.optional() })).min(1),
});
const model = z.object({
	skuId: z.string().min(1).pipe(SkuId),
	specId: SpecId,
	tierIndex: z.array(z.number().int().nonnegative()).min(1).max(2),
	costRmb: z.number().nonnegative().finite(),
	weightKg: z.number().positive().finite(),
	price: z.number().positive().finite(),
	stock: z.number().int().nonnegative(),
	imageId,
	existingModelId: ModelId.refine(positiveId).optional(),
});
export const expandParams = z.object({
	shop: str("店铺账号名"),
	id: ItemId.refine(positiveId).describe("现有Shopee商品id"),
	offerId: z.string().regex(/^\d+$/).pipe(OfferId).describe("本商品对应的1688 offerId"),
	beforeHash: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional()
		.describe("预览返回的currentHash；写入必须提供"),
	tiers: z.preprocess(parseJson, z.array(tier).min(1).max(2)).describe("最终1至2层规格及选项；第一层每个选项须有imageId"),
	models: z
		.preprocess(parseJson, z.array(model).min(1).max(100))
		.describe("通过核价的完整SKU子集，含skuId/specId/tierIndex/costRmb/weightKg/price/stock/imageId；原模型须existingModelId"),
	targetWeightKg: z.coerce.number().positive().finite().optional().describe("显式商品级计费重量；默认现有重量，须覆盖全部保留SKU，全部SKU应已按此重量重新核价"),
	beforeDescriptionInfo: z.preprocess(parseJson, productDescriptionInfo).optional().describe("同时更新详情图时，原完整description_info"),
	descriptionInfo: z.preprocess(parseJson, productDescriptionInfo).optional().describe("同时更新详情图时，目标完整description_info；须同时提供原对象"),
});
type Input = z.output<typeof expandParams>;

const oldModel = z.object({
	id: ModelId.refine(positiveId),
	sku: z.string().min(1),
	name: z.string(),
	tierIndex: z.array(z.number().int().nonnegative()).min(1).max(2),
	price: z.number().positive().finite(),
	skuImage: z.string(),
	isDefault: z.boolean().nullable(),
});
const baselineShape = z.object({
	parentSku: z.string().min(1),
	tiers: z.array(z.unknown()),
	models: z.array(oldModel).min(1),
	weightKg: z.number().positive().finite(),
	protectedFields: z.record(z.string(), z.unknown()),
});
export type ExpandBaseline = z.output<typeof baselineShape>;
const protectedKeys = [
	"name",
	"description_info",
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
	"dimension",
	"dangerous_goods",
	"min_purchase_limit",
	"max_purchase_limit_info",
	"condition",
	"size_chart_info",
	"video_list",
	"wholesale_list",
	"tax_setting",
	"logistics_channels",
	"is_unlisted",
	"status",
] as const;
const stableAttributes = (now: ProductInfo) =>
	now.attributes
		?.map((a) => ({
			...a,
			attribute_values: [...a.attribute_values].sort(
				(x, y) =>
					(x.value_id ?? Number.POSITIVE_INFINITY) - (y.value_id ?? Number.POSITIVE_INFINITY) ||
					String(x.raw_value ?? "").localeCompare(String(y.raw_value ?? "")),
			),
		}))
		.sort((a, b) => a.attribute_id - b.attribute_id) ?? now.attributes;
const protectedOf = (now: ProductInfo) =>
	Object.fromEntries(protectedKeys.filter((k) => now[k] !== undefined).map((k) => [k, k === "attributes" ? stableAttributes(now) : now[k]]));
const canonical = (value: unknown): string =>
	JSON.stringify(value, (_key, v: unknown) =>
		v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v,
	);
const picId = (value: unknown): string | null => (typeof value === "string" ? (value.split("?")[0]!.split("/").at(-1) ?? null) : null);
export const expandedMerchantSku = (offerId: string, specId: string, skuId: string) => `LT${offerId}-${specId || skuId}`.slice(0, 40);

/** 原库存不进入要覆盖的内容或指纹；订单扣库存不会被预览时的值覆盖。 */
function snapshot(now: ProductInfo): ExpandBaseline {
	if (!now.model_list?.length) throw new Usage("原规格列表为空或未知，不展开");
	const models = now.model_list
		.map((m) =>
			oldModel.parse({
				id: m.id,
				sku: m.sku,
				name: m.name,
				tierIndex: m.tier_index?.map(Number),
				price: Number(m.price_info?.input_normal_price ?? m.price_info?.normal_price),
				skuImage: m.sku_image ?? "",
				isDefault: typeof m.is_default === "boolean" ? m.is_default : null,
			}),
		)
		.sort((a, b) => a.id.localeCompare(b.id));
	if (new Set(models.map((m) => m.id)).size !== models.length || new Set(models.map((m) => m.sku)).size !== models.length)
		throw new Usage("原规格id或货号重复，不展开");
	return baselineShape.parse({
		parentSku: now.parent_sku,
		tiers: now.std_tier_variation_list,
		models,
		weightKg: Number(now.weight?.value),
		protectedFields: protectedOf(now),
	});
}
export const expandHash = (now: ProductInfo) =>
	createHash("sha256")
		.update(canonical(snapshot(now)))
		.digest("hex");

function targetTiers(p: Input): ExpandInfo["std_tier_variation_list"] {
	for (const [a, t] of p.tiers.entries()) {
		if (new Set(t.options.map((o) => o.name)).size !== t.options.length) throw new Usage("规格选项名重复，不展开");
		if (a === 0 && t.options.some((o) => !o.imageId)) throw new Usage("第一层每个选项都须有明确规格图");
	}
	if (new Set(p.tiers.map((t) => t.name)).size !== p.tiers.length) throw new Usage("规格层名重复");
	return p.tiers.map((t) => ({
		id: 0,
		custom_value: t.name,
		value_list: t.options.map((o) => ({ id: 0, custom_value: o.name, ...(o.imageId ? { image_id: o.imageId } : {}) })),
	}));
}
function validateRows(p: Input) {
	const indexes = new Set<string>(),
		skus = new Set<string>(),
		sourceIds = new Set<string>();
	for (const row of p.models) {
		if (row.tierIndex.length !== p.tiers.length || row.tierIndex.some((i, a) => i >= p.tiers[a]!.options.length)) throw new Usage("规格索引层数不符或越界");
		const index = row.tierIndex.join(","),
			sku = expandedMerchantSku(p.offerId, row.specId, row.skuId);
		if (indexes.has(index) || skus.has(sku) || sourceIds.has(row.skuId)) throw new Usage("规格组合、1688 skuId或生成的merchantSKU重复；不能截断合并");
		indexes.add(index);
		skus.add(sku);
		sourceIds.add(row.skuId);
	}
	for (const [a, t] of p.tiers.entries())
		for (let i = 0; i < t.options.length; i++)
			if (!p.models.some((m) => m.tierIndex[a] === i)) throw new Usage("规格选项没有对应的通过核价SKU；删除未使用选项，不虚构组合");
	const prices = p.models.map((m) => m.price);
	if (Math.max(...prices) > Math.min(...prices) * 5) throw new Usage("规格价差超过Shopee的5倍范围，应按完整款式或尺寸分组拆品");
}

export function buildExpand(
	now: ProductInfo,
	p: Input,
): {
	baseline: ExpandBaseline;
	info: ExpandInfo;
	currentHash: string;
	mapping: {
		skuId: string;
		specId: string;
		merchantSku: string;
		tierIndex: number[];
		existingModelId?: string;
		costRmb: number;
		weightKg: number;
		price: number;
		stock: number;
		imageId: string;
	}[];
} {
	validateRows(p);
	const tiers = targetTiers(p),
		baseline = snapshot(now);
	if (baseline.parentSku !== `LT${p.offerId}`) throw new Usage("1688 offerId与现有parentSku不符，不展开");
	const retained = p.models.filter((m) => m.existingModelId);
	if (
		retained.length !== baseline.models.length ||
		new Set(retained.map((m) => m.existingModelId)).size !== retained.length ||
		baseline.models.some((m) => !retained.some((r) => r.existingModelId === m.id))
	)
		throw new Usage("必须逐个映射并保留全部原modelId，不删除或替换旧规格");
	const weight = p.targetWeightKg ?? baseline.weightKg;
	if (weight < baseline.weightKg || p.models.some((m) => m.weightKg > weight))
		throw new Usage("目标商品级重量须覆盖现有重量及全部SKU；按同一重量重新核价后显式传targetWeightKg");
	const mapping = p.models.map((row) => ({ ...row, merchantSku: expandedMerchantSku(p.offerId, row.specId, row.skuId) }));
	const modelList = mapping.map((row) => {
		const old = baseline.models.find((m) => m.id === row.existingModelId);
		if (row.existingModelId) {
			if (!old || row.price !== old.price || row.merchantSku !== old.sku) throw new Usage("原规格来源、merchantSKU或售价不匹配；不改旧规格价格和货号");
			return { id: old.id, tier_index: row.tierIndex, price: String(old.price), sku_image: p.tiers.length === 2 ? row.imageId : "" };
		}
		if (baseline.models.some((m) => m.sku === row.merchantSku)) throw new Usage("新增merchantSKU已存在，须映射原modelId，不能重复创建");
		return {
			id: 0 as const,
			tier_index: row.tierIndex,
			price: String(row.price),
			sku: row.merchantSku,
			stock_setting_list: [{ sellable_stock: row.stock }],
			is_default: false,
			confirm_empty_gtin: false,
			gtin_code: "",
			sku_image: p.tiers.length === 2 ? row.imageId : "",
		};
	});
	const info = expandInfo.parse({
		std_tier_variation_list: tiers,
		model_list: modelList,
		...descriptionChange(now, p.beforeDescriptionInfo, p.descriptionInfo),
		...(weight !== baseline.weightKg ? { weight: { value: String(weight), unit: 1 } } : {}),
	});
	return { baseline, info, currentHash: expandHash(now), mapping };
}

const normalizedTiers = (tiers: ProductInfo["std_tier_variation_list"]) =>
	tiers?.map((t) => [t.custom_value, t.value_list?.map((o) => [o.custom_value, picId(o.image_id) || ""])]);
function targetState(now: ProductInfo, p: Input, checkStock: boolean): true | null {
	try {
		validateRows(p);
		if (!descriptionState(now, p.descriptionInfo)) return null;
		if (now.parent_sku !== `LT${p.offerId}` || canonical(normalizedTiers(now.std_tier_variation_list)) !== canonical(normalizedTiers(targetTiers(p))))
			return null;
		const models = now.model_list ?? [];
		if (models.length !== p.models.length || new Set(models.map((m) => m.id)).size !== models.length) return null;
		for (const row of p.models) {
			const sku = expandedMerchantSku(p.offerId, row.specId, row.skuId),
				matches = models.filter((m) => m.sku === sku),
				got = matches[0];
			if (matches.length !== 1 || !got?.id || !positiveId(got.id) || (row.existingModelId && got.id !== row.existingModelId)) return null;
			const tierImage = now.std_tier_variation_list?.[0]?.value_list?.[row.tierIndex[0] ?? -1]?.image_id;
			if (
				canonical(got.tier_index?.map(Number)) !== canonical(row.tierIndex) ||
				Number(got.price_info?.input_normal_price ?? got.price_info?.normal_price) !== row.price ||
				picId(got.sku_image || tierImage) !== row.imageId
			)
				return null;
			if (checkStock && !row.existingModelId && Number(got.stock_detail?.total_seller_stock) !== row.stock) return null;
		}
		const weight = Number(now.weight?.value);
		if (!(weight > 0) || p.models.some((m) => m.weightKg > weight) || (p.targetWeightKg !== undefined && p.targetWeightKg !== weight)) return null;
		return true;
	} catch {
		return null;
	}
}
/** 已完整展开后重复运行只返回已完成；库存可能已因订单改变，不再次写入。 */
export const expandAlready = (now: ProductInfo, p: Input) => targetState(now, p, false);
export function expandState(now: ProductInfo, baseline: ExpandBaseline, p: Input): true | null {
	const expected = { ...baseline.protectedFields };
	if (p.descriptionInfo) expected.description_info = now.description_info;
	if (!targetState(now, p, true) || canonical(protectedOf(now)) !== canonical(expected)) return null;
	if (Number(now.weight?.value) !== (p.targetWeightKg ?? baseline.weightKg)) return null;
	const oldIds = new Set(baseline.models.map((m) => m.id));
	for (const row of p.models) {
		const gotId = now.model_list?.find((m) => m.sku === expandedMerchantSku(p.offerId, row.specId, row.skuId))?.id;
		if (!row.existingModelId && gotId && oldIds.has(gotId)) return null;
	}
	return true;
}

async function shopIdOf(sql: Sql, shop: string) {
	const [row] = await sql<{ shop_id: string }[]>`select shop_id from shop_settings where shop=${shop}`;
	if (!row) throw new Usage(`店铺设置里没有 ${shop}`);
	return row.shop_id;
}
export async function previewExpand(sql: Sql, p: Input) {
	const shopId = await shopIdOf(sql, p.shop);
	return inAccount("shopee", shopId, async () => {
		const now = await productInfo(p.id);
		if (expandAlready(now, p))
			return { ...p, shopId, parentSku: now.parent_sku ?? "", already: true as const, currentHash: expandHash(now), checkedAt: new Date().toISOString() };
		const built = buildExpand(now, p);
		if (p.beforeHash && p.beforeHash !== built.currentHash) throw new Usage("原商品或规格已变：重新预览，不覆盖");
		return { ...p, shopId, parentSku: built.baseline.parentSku, already: false as const, ...built, checkedAt: new Date().toISOString() };
	});
}
export async function planExpand(sql: Sql, p: Input) {
	if (!p.beforeHash) throw new Usage("先expand-preview，再传currentHash作为beforeHash");
	const preview = await previewExpand(sql, p);
	if (preview.already) return [];
	return [[{ op: "展开规格", params: { ...p, shopId: preview.shopId, parentSku: preview.parentSku, baseline: preview.baseline, info: preview.info } }]];
}
const params = expandParams.extend({
	beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
	shopId: z.string(),
	parentSku: z.string(),
	baseline: baselineShape,
	info: expandInfo,
});
type Params = z.output<typeof params>;
const op: WriteOp<Params, ExpandBaseline> = {
	describe: "按已核价1688 SKU子集展开一至两层规格和图片，保留全部原模型",
	params,
	target: (p) => `shopee:${p.shopId}:${p.parentSku || p.id}`,
	key: (p) =>
		`expand:${p.shopId}:${p.id}:${createHash("sha256")
			.update(canonical([p.beforeHash, p.offerId, p.tiers, p.models, p.targetWeightKg, p.info]))
			.digest("hex")}`,
	display: (p) => `${p.shop}（商品${p.id}）展开为${p.models.length}个规格，保留${p.baseline.models.length}个原模型；货源${p.offerId}`,
	untried: "展开规格是新写操作：先和人约一个商品一起跑--try，读回后请人在站点核对",
	tried: (sql, p) => listingWriteTried(sql, "展开规格", p.shopId),
	where: (_sql, p, fn) => inAccount("shopee", p.shopId, fn),
	async prepare(sql, p) {
		if ((await shopIdOf(sql, p.shop)) !== p.shopId) return { skip: "店铺设置刚改过，重新确认" };
		const blocked = await catalogWriteBlock(sql, { ...p, productId: p.id });
		if (blocked) return { skip: blocked };
		const now = await productInfo(p.id);
		if (expandAlready(now, p)) return { skip: "目标规格及图片已完整存在，不再提交" };
		if (now.parent_sku !== p.parentSku || expandHash(now) !== p.beforeHash) return { skip: "原商品或规格已变：重新预览，不覆盖" };
		const built = buildExpand(now, p);
		if (canonical(built.baseline) !== canonical(p.baseline) || canonical(built.info) !== canonical(p.info)) return { skip: "预览与写入内容不同，不提交" };
		const language = await imageLanguageBlock(sql, p.shop, `商品 ${p.id}`, variantImageTarget(now, built.info));
		if (language) return { skip: language };
		return { params: p, before: built.baseline };
	},
	submit: (_sql, p) => expandProduct.submit({ productId: p.id, info: p.info }),
	async check(p, before, fresh) {
		for (let n = 0; n < (fresh ? 5 : 1); n++) {
			if (n) await new Promise((ok) => setTimeout(ok, 5000));
			const now = await productInfo(p.id),
				done = expandState(now, before ?? p.baseline, p);
			if (done || !fresh || n === 4)
				return {
					done,
					readback: {
						productId: p.id,
						models: now.model_list,
						tiers: now.std_tier_variation_list,
						weight: now.weight,
						...(p.descriptionInfo ? { descriptionInfo: now.description_info } : {}),
						mapping: p.models.map((row) => ({
							skuId: row.skuId,
							specId: row.specId,
							merchantSku: expandedMerchantSku(p.offerId, row.specId, row.skuId),
							modelId: now.model_list?.find((m) => m.sku === expandedMerchantSku(p.offerId, row.specId, row.skuId))?.id,
						})),
					},
				};
		}
		return { done: null, readback: null };
	},
};
export const EXPAND_WRITES = { 展开规格: writeOp(op) };
