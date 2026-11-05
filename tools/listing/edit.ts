// 已上架商品改标题、价格、显式类目属性、主图、描述或Size Chart：核对原值，不交库存、规格名等字段，经写入引擎单次提交、回读。
import { createHash } from "node:crypto";
import { z } from "zod";
import { type ProductInfo, productAttribute, productInfo } from "../../connectors/sites/shopee/products.ts";
import { editProduct, productDescriptionInfo, productSizeChartInfo } from "../../connectors/sites/shopee/publish.ts";
import { ItemId, ModelId } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { parseJson, str } from "../../platform/tool.ts";
import { type WriteOp, writeOp } from "../../platform/writes.ts";

const priceChange = z.object({ modelId: ModelId, from: z.number().positive().finite(), to: z.number().positive().finite() });
const categoryPath = z.preprocess(parseJson, z.array(z.number().int().positive()).min(1));
const attributes = z.array(productAttribute);
const imageList = z.preprocess(parseJson, z.array(z.string().regex(/^[A-Za-z0-9_-]+$/, "须提供Shopee图片id，不是URL")).min(1));
type Attributes = z.output<typeof attributes>;
type DescriptionInfo = z.output<typeof productDescriptionInfo>;
const descriptionInfo = z.preprocess(parseJson, productDescriptionInfo);
const originalSizeChartInfo = z.looseObject({ size_chart: z.string() });
type SizeChartInfo = z.output<typeof originalSizeChartInfo>;

export const editParams = z
	.object({
		shop: str("店铺账号名（店铺设置里的 shop）"),
		id: ItemId.refine((id) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0).describe("Shopee 商品 id，不是商品稿编号"),
		beforeTitle: str("人确认的原标题，逐字核对；现读不一致就不提交"),
		title: str("人同意的完整新标题"),
		prices: z
			.preprocess(parseJson, z.array(priceChange))
			.default([])
			.describe('人同意的改价 JSON：[{"modelId":"规格 id","from":原价,"to":目标价}]；不写就只改标题'),
		beforeCategoryPath: categoryPath.optional().describe("人确认的原类目路径JSON数组，现读不一致不提交"),
		categoryPath: categoryPath.optional().describe("明确的新类目路径JSON数组；同时给原类目与新属性"),
		attributes: z.preprocess(parseJson, attributes).optional().describe("新类目对应的显式属性JSON数组，可给[]；不沿用旧类目属性"),
		beforeImages: imageList.optional().describe("人确认的现有主图完整有序Shopee图片id JSON数组；现读不一致不提交"),
		images: imageList.optional().describe("明确的新主图完整有序Shopee图片id JSON数组；同时提供beforeImages"),
		beforeDescriptionInfo: descriptionInfo.optional().describe("人确认的原完整description_info JSON对象；现读不一致不提交"),
		descriptionInfo: descriptionInfo.optional().describe("明确的新完整description_info JSON对象，保留其余field_list和图片；同时提供原对象"),
		beforeSizeChartInfo: z
			.preprocess(parseJson, originalSizeChartInfo)
			.optional()
			.describe("现读完整原size_chart_info JSON对象，size_chart可为空；原值变化不提交"),
		sizeChartInfo: z
			.preprocess(parseJson, productSizeChartInfo)
			.optional()
			.describe("明确的新完整size_chart_info JSON对象，size_chart须为非空Shopee图片id；同时提供原对象"),
	})
	.refine(
		(p) => (p.categoryPath ? Boolean(p.beforeCategoryPath && p.attributes) : !p.beforeCategoryPath && !p.attributes),
		"修改类目须同时提供原路径、新路径和明确属性，属性不能单独修改",
	)
	.refine((p) => Boolean(p.beforeImages) === Boolean(p.images), "修改图片须同时提供beforeImages和images完整列表")
	.refine((p) => Boolean(p.beforeDescriptionInfo) === Boolean(p.descriptionInfo), "修改描述须同时提供beforeDescriptionInfo和descriptionInfo完整对象")
	.refine((p) => Boolean(p.beforeSizeChartInfo) === Boolean(p.sizeChartInfo), "修改Size Chart须同时提供beforeSizeChartInfo和sizeChartInfo完整对象");
type Input = z.output<typeof editParams>;

export function titleChange(current: string | null | undefined, before: string, title: string): { skip: string } | { info: { name: string } } {
	if (current === title) return { skip: "已经是目标标题，不再提交" };
	if (current !== before) return { skip: "原标题已变或未知：重新现读并确认，不覆盖" };
	return { info: { name: title } };
}

export const titleState = (current: string | null | undefined, title: string): true | null => (current === title ? true : null);

/** 详情可能将图片id展开为URL；只在所有项都是字符串时按完整有序列表核对。 */
export function imagesState(now: ProductInfo, expected: string[] | undefined): true | null {
	if (!expected) return true;
	if (!now.images || now.images.some((v) => typeof v !== "string")) return null;
	const ids = now.images.map((v) => String(v).split("?")[0]!.split("/").at(-1));
	return JSON.stringify(ids) === JSON.stringify(expected) ? true : null;
}

export function imagesChange(now: ProductInfo, before: string[] | undefined, images: string[] | undefined) {
	if (!images) return {};
	if (!before) throw new Usage("修改图片须同时提供beforeImages和images完整列表");
	if (!imagesState(now, images) && !imagesState(now, before)) throw new Usage("原图片已变或未知：重新现读确认，不覆盖");
	return { images };
}

const canonical = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(canonical)
		: value && typeof value === "object"
			? Object.fromEntries(
					Object.entries(value)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([k, v]) => [k, canonical(v)]),
				)
			: value;

const richDescription = z.looseObject({ field_list: z.array(z.looseObject({ type: z.number(), value: z.unknown() })) });

/** 完整核对描述；Shopee读回会省略详情图宽高，只豁免同位置同图的缺失尺寸。 */
export function descriptionState(now: ProductInfo, expected: DescriptionInfo | undefined): true | null {
	if (!expected) return true;
	let actual = now.description_info;
	let target = expected;
	if (actual?.description_type === "json" && expected.description_type === "json" && typeof actual.description === "string") {
		try {
			const seen = richDescription.parse(JSON.parse(actual.description));
			const wanted = richDescription.parse(JSON.parse(expected.description));
			for (const [i, field] of wanted.field_list.entries()) {
				const got = seen.field_list[i];
				if (field.type === 1 && got?.type === 1 && field.value === got.value) for (const key of ["width", "height"]) if (!(key in got)) delete field[key];
			}
			actual = { ...actual, description: JSON.stringify(canonical(seen)) };
			target = { ...expected, description: JSON.stringify(canonical(wanted)) };
		} catch {
			return null;
		}
	}
	return JSON.stringify(canonical(actual)) === JSON.stringify(canonical(target)) ? true : null;
}

export function descriptionChange(now: ProductInfo, before: DescriptionInfo | undefined, after: DescriptionInfo | undefined) {
	if (!after) return {};
	if (!before) throw new Usage("修改描述须同时提供beforeDescriptionInfo和descriptionInfo完整对象");
	if (!descriptionState(now, after) && !descriptionState(now, before)) throw new Usage("原描述已变或未知：重新现读确认，不覆盖");
	return { description_info: after };
}

/** 只归一化站点展开的图片URL；其余size_chart_info字段须完整一致，不能借主图或描述推断已更新。 */
export function sizeChartState(now: ProductInfo, expected: SizeChartInfo | undefined): true | null {
	if (!expected) return true;
	if (typeof now.size_chart_info?.size_chart !== "string") return null;
	const normalized = (info: SizeChartInfo) => ({
		...info,
		size_chart: /^https?:\/\//.test(info.size_chart) ? info.size_chart.split("?")[0]!.split("/").at(-1) : info.size_chart,
	});
	return JSON.stringify(canonical(normalized({ ...now.size_chart_info, size_chart: now.size_chart_info.size_chart }))) ===
		JSON.stringify(canonical(normalized(expected)))
		? true
		: null;
}

export function sizeChartChange(now: ProductInfo, before: SizeChartInfo | undefined, after: SizeChartInfo | undefined) {
	if (!after) return {};
	if (!before) throw new Usage("修改Size Chart须同时提供beforeSizeChartInfo和sizeChartInfo完整对象");
	if (!sizeChartState(now, after) && !sizeChartState(now, before)) throw new Usage("原Size Chart已变或未知：重新现读确认，不覆盖");
	return { size_chart_info: after };
}

/** 没有新增字段的调用保持既有key；图片顺序也是变更内容的一部分。 */
export function editKey(p: Input & { shopId: string }): string {
	return `edit:${p.shopId}:${p.id}:${createHash("sha256")
		.update(
			JSON.stringify([
				p.beforeTitle,
				p.title,
				p.prices,
				...(p.categoryPath ? [p.beforeCategoryPath, p.categoryPath, p.attributes] : []),
				...(p.images ? [p.beforeImages, p.images] : []),
				...(p.descriptionInfo ? [canonical(p.beforeDescriptionInfo), canonical(p.descriptionInfo)] : []),
				...(p.sizeChartInfo ? [canonical(p.beforeSizeChartInfo), canonical(p.sizeChartInfo)] : []),
			]),
		)
		.digest("hex")}`;
}

const samePath = (a: (number | string)[] | null | undefined, b: number[]) => JSON.stringify(a?.map(Number)) === JSON.stringify(b);
export function categoryState(now: ProductInfo, path: number[] | undefined, expected: Attributes | undefined): true | null {
	if (!path) return true;
	if (!samePath(now.category_path, path) || !expected) return null;
	const actual = now.attributes;
	if (!actual) return expected.length ? null : true;
	const values = (a: NonNullable<ProductInfo["attributes"]>[number]) =>
		a.attribute_values.some((v) => v.value_id === undefined) ? null : a.attribute_values.map((v) => v.value_id!).sort((a, b) => a - b);
	return expected.every((a) => actual.some((b) => a.attribute_id === b.attribute_id && JSON.stringify(values(a)) === JSON.stringify(values(b)))) ? true : null;
}

/** 只传调用方明确选择的新类目及属性；旧类目变了就返回重新确认，不能覆写。 */
export function categoryChange(now: ProductInfo, before: number[] | undefined, path: number[] | undefined, values: Attributes | undefined) {
	if (!path) return {};
	if (!before || !values) throw new Usage("修改类目须同时提供原路径、新路径和明确属性");
	if (!categoryState(now, path, values) && !samePath(now.category_path, before)) throw new Usage("原类目已变或未知：重新现读确认，不覆盖");
	return { category_path: path, attributes: values };
}

const model = z.object({ id: ModelId, tier_index: z.array(z.number().int().nonnegative()).min(1), price: z.string() });
type Model = z.output<typeof model>;
/** JSONB 会重排对象键，站点也会重排规格行；按规格 id 比字段值，不能比较原始 JSON 字符串。 */
export function sameModels(a: Model[], b: Model[]): boolean {
	const canonical = (rows: Model[]) => rows.map((m) => [m.id, m.tier_index, Number(m.price)]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
	return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
export function priceModels(now: ProductInfo, changes: z.output<typeof priceChange>[]): Model[] {
	if (!changes.length) return [];
	if (!now.model_list?.length) throw new Usage("规格未返回，不改价");
	if (new Set(changes.map((c) => c.modelId)).size !== changes.length) throw new Usage("改价清单有重复规格 id");
	const models = now.model_list.map((m) => {
		const price = m.price_info?.input_normal_price ?? m.price_info?.normal_price;
		if (!m.id || !Number.isSafeInteger(Number(m.id)) || price == null || price === "" || !(Number(price) > 0) || !Number.isFinite(Number(price)))
			throw new Usage("规格 id 或售价未知，不改价");
		return model.parse({ id: m.id, tier_index: m.tier_index?.map(Number), price: String(Number(price)) });
	});
	if (new Set(models.map((m) => m.id)).size !== models.length) throw new Usage("回包有重复规格 id，不改价");
	for (const c of changes) {
		const m = models.find((m) => m.id === c.modelId);
		if (!m || Number(m.price) !== c.from) throw new Usage(`规格 ${c.modelId} 不存在或原价已变：重新现读确认`);
	}
	return models.map((m) => ({ ...m, price: String(changes.find((c) => c.modelId === m.id)?.to ?? Number(m.price)) }));
}

/** 对整份规格价格回读：不能只看到两个目标价就把其他规格的意外变化当作成功。 */
export function pricesState(now: ProductInfo, expected: Model[]): true | null {
	if (!expected.length) return true;
	if (now.model_list?.length !== expected.length || new Set(now.model_list.map((m) => m.id)).size !== expected.length) return null;
	return expected.every((m) => {
		const got = now.model_list?.find((g) => g.id === m.id);
		return (
			got &&
			Number(got.price_info?.input_normal_price ?? got.price_info?.normal_price) === Number(m.price) &&
			JSON.stringify(got.tier_index?.map(Number)) === JSON.stringify(m.tier_index)
		);
	})
		? true
		: null;
}

async function shopIdOf(sql: Sql, shop: string): Promise<string> {
	const [row] = await sql<{ shop_id: string }[]>`select shop_id from shop_settings where shop = ${shop}`;
	if (!row) throw new Usage(`店铺设置里没有 ${shop}`);
	return row.shop_id;
}

export async function previewEdit(sql: Sql, p: Input) {
	const shopId = await shopIdOf(sql, p.shop);
	return inAccount("shopee", shopId, async () => {
		const now = await productInfo(p.id);
		const change = titleChange(now.name, p.beforeTitle, p.title);
		if ("skip" in change && now.name !== p.title) throw new Usage(change.skip);
		const models = priceModels(now, p.prices);
		categoryChange(now, p.beforeCategoryPath, p.categoryPath, p.attributes);
		imagesChange(now, p.beforeImages, p.images);
		descriptionChange(now, p.beforeDescriptionInfo, p.descriptionInfo);
		sizeChartChange(now, p.beforeSizeChartInfo, p.sizeChartInfo);
		return {
			...p,
			shopId,
			parentSku: now.parent_sku ?? "",
			currentTitle: now.name,
			checkedAt: new Date().toISOString(),
			models,
			already:
				now.name === p.title &&
				!p.prices.length &&
				Boolean(
					categoryState(now, p.categoryPath, p.attributes) &&
						imagesState(now, p.images) &&
						descriptionState(now, p.descriptionInfo) &&
						sizeChartState(now, p.sizeChartInfo),
				),
		};
	});
}

export async function planEdit(sql: Sql, p: Input) {
	const preview = await previewEdit(sql, p);
	if (preview.already) return [];
	return [[{ op: "改商品", params: { ...p, shopId: preview.shopId, parentSku: preview.parentSku, models: preview.models } }]];
}

const params = editParams.safeExtend({ shopId: z.string(), parentSku: z.string(), models: z.array(model) });
type Params = z.output<typeof params>;
const editOp: WriteOp<Params, { title: string; categoryPath?: number[]; images?: string[]; descriptionInfo?: DescriptionInfo; sizeChartInfo?: SizeChartInfo }> =
	{
		describe: "修改现有 Shopee 商品的标题、人指定的规格价格、显式类目属性、主图、描述或Size Chart",
		params,
		target: (p) => `shopee:${p.shopId}:${p.parentSku || p.id}`,
		key: editKey,
		display: (p) =>
			`${p.shop}（商品 ${p.id}）标题：${p.beforeTitle} → ${p.title}${p.prices.map((c) => `；规格 ${c.modelId}：NT$${c.from} → NT$${c.to}`).join("")}${p.categoryPath ? `；类目：${p.beforeCategoryPath?.join(" > ")} → ${p.categoryPath.join(" > ")}` : ""}${p.images ? `；主图：${p.beforeImages?.join(",")} → ${p.images.join(",")}` : ""}${p.descriptionInfo ? `；描述：${JSON.stringify(p.beforeDescriptionInfo)} → ${JSON.stringify(p.descriptionInfo)}` : ""}${p.sizeChartInfo ? `；Size Chart：${JSON.stringify(p.beforeSizeChartInfo)} → ${JSON.stringify(p.sizeChartInfo)}` : ""}`,
		untried: "改商品是新写操作：先和人约一个商品一起跑 --try，回读后请人在站点核对",
		where: (_sql, p, fn) => inAccount("shopee", p.shopId, fn),
		async prepare(sql, p) {
			if ((await shopIdOf(sql, p.shop)) !== p.shopId) return { skip: "店铺设置刚改过：重新确认店铺" };
			const now = await productInfo(p.id);
			if ((now.parent_sku ?? "") !== p.parentSku) return { skip: "商品货号刚改过：重新确认商品" };
			const change = titleChange(now.name, p.beforeTitle, p.title);
			if ("skip" in change && now.name !== p.title) return change;
			const models = priceModels(now, p.prices);
			if (!sameModels(models, p.models)) return { skip: "规格或售价刚改过：重新确认，不覆盖" };
			try {
				categoryChange(now, p.beforeCategoryPath, p.categoryPath, p.attributes);
				imagesChange(now, p.beforeImages, p.images);
				descriptionChange(now, p.beforeDescriptionInfo, p.descriptionInfo);
				sizeChartChange(now, p.beforeSizeChartInfo, p.sizeChartInfo);
			} catch (e) {
				return { skip: (e as Error).message };
			}
			if (
				now.name === p.title &&
				!p.prices.length &&
				categoryState(now, p.categoryPath, p.attributes) &&
				imagesState(now, p.images) &&
				descriptionState(now, p.descriptionInfo) &&
				sizeChartState(now, p.sizeChartInfo)
			)
				return {
					skip: p.sizeChartInfo
						? "已经是目标标题及指定Size Chart等修改，不再提交"
						: p.descriptionInfo
							? "已经是目标标题及指定描述，不再提交"
							: p.images
								? "已经是目标标题及指定图片，不再提交"
								: p.categoryPath
									? "已经是目标标题及指定类目，不再提交"
									: "已经是目标标题，不再提交",
				};
			return {
				params: p,
				before: {
					title: p.beforeTitle,
					...(p.beforeCategoryPath ? { categoryPath: p.beforeCategoryPath } : {}),
					...(p.beforeImages ? { images: p.beforeImages } : {}),
					...(p.beforeDescriptionInfo ? { descriptionInfo: p.beforeDescriptionInfo } : {}),
					...(p.beforeSizeChartInfo ? { sizeChartInfo: p.beforeSizeChartInfo } : {}),
				},
			};
		},
		submit: (_sql, p) =>
			editProduct.submit({
				productId: p.id,
				title: p.title,
				...(p.models.length ? { models: p.models } : {}),
				...(p.categoryPath ? { categoryPath: p.categoryPath, attributes: p.attributes } : {}),
				...(p.images ? { images: p.images } : {}),
				...(p.descriptionInfo ? { descriptionInfo: p.descriptionInfo } : {}),
				...(p.sizeChartInfo ? { sizeChartInfo: p.sizeChartInfo } : {}),
			}),
		async check(p, _before, fresh) {
			for (let n = 0; n < (fresh ? 3 : 1); n++) {
				if (n) await new Promise((ok) => setTimeout(ok, 2000));
				const now = await productInfo(p.id);
				const done =
					titleState(now.name, p.title) &&
					pricesState(now, p.models) &&
					categoryState(now, p.categoryPath, p.attributes) &&
					imagesState(now, p.images) &&
					descriptionState(now, p.descriptionInfo) &&
					sizeChartState(now, p.sizeChartInfo);
				if (done || !fresh || n === 2)
					return {
						done,
						readback: {
							productId: p.id,
							title: now.name,
							models: now.model_list,
							...(p.categoryPath ? { categoryPath: now.category_path, attributes: now.attributes } : {}),
							...(p.images ? { images: now.images } : {}),
							...(p.descriptionInfo ? { descriptionInfo: now.description_info } : {}),
							...(p.sizeChartInfo ? { sizeChartInfo: now.size_chart_info } : {}),
						},
					};
			}
			return { done: null, readback: null };
		},
	};
export const EDIT_WRITES = { 改商品: writeOp(editOp) };
