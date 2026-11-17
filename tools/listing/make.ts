// 做商品稿（x2 listing make）：读货源 → 排规格、核价 → 做图 → 类目、属性、备货天数 → 记进商品稿。
// 缺的（类目不在本店范围、要填字的属性……）记成问题，x2 status 提醒人；人处理了以后再跑一次，做过的不重做。
// 1688 没给的重量、读不到的国内运费不算问题：agent 估（x2 listing estimate，只填空着的），写完照货源快照重新核价（reprice），不用再读 1688。
// 几份同时做（x2 listing make --jobs）：碰浏览器的（读 1688 货源、加水印、传图、类目、属性、备货天数）按浏览器排队，读 1688 隔几秒（queue.ts）；
// 问 Gemini、交象寄、取图不排队。报价（quote，选品用）用第 2 步的同一套代码，不做图、不存库

import type postgres from "postgres";
import { detailImages, Gone, type Offer, OfferId, offer as readOffer } from "../../connectors/sites/1688/api.ts";
import { attributes as attributeTree, type Category, categoryTree, recommendedCategory, shippingDays } from "../../connectors/sites/shopee/products.ts";
import { logins } from "../../platform/browser/browser.ts";
import type { Json, Sql } from "../../platform/db/index.ts";
import { NeedsHuman } from "../../platform/errors.ts";
import { categoryAllowed, daysToShip, pickAttributes, recommendedPath } from "./category.ts";
import { makeImages } from "./images.ts";
import { type ImageMode, imageModeOf, type Pics } from "./pics.ts";
import { freightOf, num, pricingPolicy, reprice, type Settings, settingsOf, specsAndPrices, usableWeights } from "./pricing.ts";
import { MAX_DETAIL, MAX_MAIN } from "./product.ts";
import { purchaseLimitOf } from "./purchase-limit.ts";
import { from1688, inShopQueued, on1688, type Runner } from "./queue.ts";
import { problemsAfterReviewedImages, verifyReviewedFiles } from "./reviewed-images.ts";
import type { ListingRow, ShopSettingsRow } from "./row.ts";
import { type SkuImage, withSkuImages } from "./sku-images.ts";
import { sourceOffer, sourceProductSchema } from "./source-data.ts";
import { sourceScope } from "./source-scope.ts";
import { nicknameFor, textProblems } from "./text.ts";
import { specsOf } from "./variants.ts";

export async function savePrices(sql: Sql, l: ListingRow, s: Settings): Promise<boolean> {
	const r = reprice(l, s);
	if (!r?.changed) return false;
	const fields = {
		variants: r.specs,
		pricing: { ...pricingPolicy(s), freightRmb: r.freightRmb, minimumPurchase: r.minimumPurchase, at: new Date().toISOString() },
	};
	await sql`update listings set variants = ${sql.json(fields.variants as Json)}, pricing = ${sql.json(fields.pricing as Json)}, updated_at = now() where id = ${l.id}`;
	Object.assign(l, fields);
	return true;
}

let tree: Map<string, string> | null = null;
async function categoryNames(): Promise<Map<string, string>> {
	if (tree) return tree;
	const walk = (list: Category[], out: Map<string, string>) => {
		for (const c of list) {
			out.set(c.id, c.name);
			walk(c.children, out);
		}
		return out;
	};
	tree = walk(await categoryTree(), new Map());
	return tree;
}

export async function readOffer1688(offerId: OfferId): Promise<Offer> {
	const a = (await logins("1688"))[0];
	if (!a) throw new NeedsHuman("没有登录着 1688 的浏览器：读不了货源");
	return usableWeights(await on1688(a.account.id, () => readOffer(offerId)));
}

/** 候选的图：最后用主图 9 张、详情图 12 张（product.ts），多看几张给筛掉的留余地，再多就白花筛字和译图的钱 */
const CANDIDATE_MAIN = 12,
	CANDIDATE_DETAIL = 16;

export async function make(
	sql: Sql,
	id: string,
	log: (s: string) => void = console.error,
	options: {
		prepareOnly?: boolean;
		imageMode?: ImageMode;
		sourceSkuIds?: string[];
		mainImages?: string[];
		detailImages?: string[];
		skuImages?: SkuImage[];
	} = {},
): Promise<{ id: string; problems: string[] }> {
	const [l] = await sql<ListingRow[]>`select * from listings where id = ${id}`;
	if (!l) throw new Error(`没有商品稿 ${id}`);
	if (options.prepareOnly) {
		if (l.product_id || l.listed_at) throw new Error("已建商品不能仅准备货源和规格");
		if (l.images.imageMode === "reviewed" || options.imageMode === "reviewed") throw new Error("已审图片续做不能与仅准备货源混用");
	}
	if (l.product_id && (options.sourceSkuIds || options.mainImages || options.detailImages || options.skuImages))
		throw new Error("已建商品不能重新指定货源或图片范围");
	const [row] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${l.shop}`;
	const s = settingsOf(row!);
	const imageMode = imageModeOf(options.imageMode, l.images, l.source_product_id ? "original" : "processed");
	if (imageMode === "reviewed") {
		if (options.sourceSkuIds || options.mainImages || options.detailImages || options.skuImages)
			throw new Error("已审图片续做不重排货源、规格或图片；修改范围须重新导入审阅清单");
		return completeReviewed(sql, l, s, log);
	}
	if (!options.prepareOnly && imageMode === "processed" && !s.mark) return save(sql, id, {}, ["水印：店铺设置里缺这家店的水印（两家店的封面要不一样）"]);

	let source: import("./source-data.ts").SourceProduct | null = null;
	let o: Offer;
	const fields = l.source_fields ?? {};
	if (l.source_product_id) {
		const [row] = await sql<{ snapshot: unknown }[]>`select snapshot from listing_sources where id = ${l.source_product_id}`;
		source = sourceProductSchema.parse(row?.snapshot);
		if (source.errors.length)
			return save(
				sql,
				id,
				{},
				source.errors.map((error) => `采集：${error}`),
				l,
			);
		const read = sourceOffer(source, fields);
		if (!read.offer) return save(sql, id, {}, read.problems, l);
		o = usableWeights(read.offer);
		log(`沿用人工采集快照 ${source.platform} ${source.sourceId}`);
	} else {
		log(`读货源 ${l.offer_id}`);
		try {
			o = await readOffer1688(OfferId.parse(l.offer_id));
		} catch (e) {
			if (e instanceof Gone) return save(sql, id, {}, ["货源：已在 1688 下架"]);
			throw e;
		}
	}
	const removed = sourceScope(o, options.sourceSkuIds, l.removed_variants ?? []);
	const detail = source
		? options.prepareOnly
			? source.description.images
			: (fields.detailImages ?? source.description.images)
		: (options.detailImages ??
			(o.detailUrl
				? await from1688(() => detailImages(o.detailUrl!)).catch((e) => {
						log(`详情图取不到：${(e as Error).message}`);
						return [] as string[];
					})
				: []));

	const freight = freightOf(o, l.freight_rmb);
	const { specs: sourceSpecs, problems } = specsAndPrices(o, s, {
		removed,
		prev: specsOf(l.variants),
		weightKg: num(l.weight_kg),
		freightRmb: freight,
		minimumPurchase: purchaseLimitOf(l, s.minPurchase),
		originalText: Boolean(source),
	});
	const specs = withSkuImages(sourceSpecs, options.skuImages);
	// 先形成完整来源与核价字段；仅准备到此保存，不进入任何图片、模型或类目流程。
	const done: Record<string, unknown> = {
		nickname: nicknameFor(l.nickname, l.offer?.title, o.title),
		offer: {
			offerId: o.offerId,
			url: o.url,
			title: o.title,
			images: o.images,
			detail,
			tags: o.tags,
			freight: o.freight,
			minQty: o.minQty,
			props: o.props,
			skus: o.skus,
		},
		offer_read_at: new Date(),
		variants: specs,
		removed_variants: removed,
		pricing: { ...pricingPolicy(s), freightRmb: freight, minimumPurchase: purchaseLimitOf(l, s.minPurchase), at: new Date().toISOString() },
	};
	if (source) {
		const title = fields.title ?? l.title ?? source.title;
		const description = fields.description ?? l.description ?? source.description.text;
		Object.assign(done, { title, description });
		problems.push(...textProblems(title, description));
	}
	if (options.prepareOnly) {
		log("仅保存货源、完整详情来源、规格和核价，待图片处理与审阅");
		return save(sql, id, done, [...problems, "图：缺可用的主图（仅准备货源，待图片处理和审阅）"], source ? l : undefined);
	}

	const browser: Runner = (fn) => inShopQueued(s.shopId, fn);
	const pics: Pics = await makeImages(
		sql,
		{
			shop: s.shop,
			mark: s.mark,
			imageMode,
			browser,
			main: source ? (fields.mainImages ?? source.images) : (options.mainImages ?? o.images ?? [o.image]).slice(0, CANDIDATE_MAIN),
			detail: source ? detail : detail.slice(0, CANDIDATE_DETAIL),
			options: (specs.tiers[0]?.options ?? []).map((x) => x.image).filter((x): x is string => Boolean(x)),
		},
		log,
	);
	done.images = pics;
	if (source) {
		if (pics.main.length > MAX_MAIN) problems.push(`图：主图 ${pics.main.length} 张，须明确选择最多 ${MAX_MAIN} 张`);
		if (pics.detail.length > MAX_DETAIL) problems.push(`图：详情图 ${pics.detail.length} 张，须明确选择最多 ${MAX_DETAIL} 张`);
		for (const [role, images] of [
			["主图", pics.main],
			["详情图", pics.detail],
			["规格图", pics.options],
		] as const)
			for (const image of images) if (image.drop || !image.imageId) problems.push(`图：${role} ${image.drop ?? "尚未上传"}（${image.from}）`);
	}
	const cover = pics.main.find((p) => p.imageId);
	if (!cover) problems.push("图：缺可用的主图");
	else
		Object.assign(
			done,
			await browser(async () => {
				const out: Record<string, unknown> = {};
				let path: number[] = l.category_path ?? [];
				const kept = path.length > 0;
				if (!kept) {
					log("推荐类目");
					const rec = recommendedPath(await recommendedCategory(o.title, cover.imageId!));
					if (!rec) {
						problems.push("类目：Shopee 未推荐类目，待人定");
						return out;
					}
					path = rec.path;
				}
				const leaf = path[path.length - 1]!;
				const names = await categoryNames().catch(() => new Map<string, string>());
				const name = names.size || !kept ? path.map((c) => names.get(String(c)) ?? String(c)).join(" > ") : (l.category_name ?? path.join(" > "));
				Object.assign(out, { category_path: path, category_id: leaf, category_name: name });
				if (!categoryAllowed(String(leaf), s.categories, l.category_exception))
					problems.push(`类目：推荐的「${names.get(String(leaf)) ?? leaf}」不在本店允许的类目里`);
				const attrs = pickAttributes(await attributeTree(leaf), source ? fields.attributes : undefined);
				Object.assign(out, { attributes: attrs.attributes, attributes_text: attrs.text.join("\n") || null });
				if (attrs.missing.length)
					problems.push(source && fields.attributes ? `属性：${attrs.missing.join("；")}` : `属性：必填的「${attrs.missing.join("、")}」待人工填写`);
				const rules = (await shippingDays()).rules;
				const days = source && fields.daysToShip !== undefined ? fields.daysToShip : daysToShip(leaf, rules);
				if (days === null) problems.push("备货天数：无法读取这个类目的备货天数规则");
				if (
					source &&
					fields.daysToShip !== undefined &&
					!rules.some((rule) => rule.categoryIds.includes(String(leaf)) && fields.daysToShip! >= rule.min && fields.daysToShip! <= rule.max)
				)
					problems.push("备货天数：人工值不在当前类目允许范围内");
				out.days_to_ship = days;
				return out;
			}),
		);

	return save(sql, id, done, problems, source ? l : undefined);
}

/** 已审图片续做只补类目、空白属性和空白备货天数；源SKU、售价、人工字段及图片集合保持原值。 */
async function completeReviewed(sql: Sql, row: ListingRow, settings: Settings, log: (s: string) => void) {
	if (row.product_id || row.listed_at) throw new Error("已建商品不能续做已审图片商品稿");
	if (!row.offer || !specsOf(row.variants)) throw new Error("已审图片续做缺保存的货源或规格");
	await verifyReviewedFiles(sql, row);
	const currentState = (l: ListingRow) => JSON.stringify([l.offer, l.variants, l.images, l.category_path, l.attributes, l.days_to_ship, l.problems]);
	const before = currentState(row);
	const problems = (problemsAfterReviewedImages(row) ?? "").split("\n").filter((line) => line && !/^类目：|^备货天数：/.test(line));
	const cover = row.images.main!.find((p) => p.imageId && !p.drop)!;
	log("沿用已审图片与原规格，补类目、属性和备货天数");
	const done = await inShopQueued(settings.shopId, async () => {
		const fields: Record<string, unknown> = {};
		let path = row.category_path ?? [];
		if (!path.length) {
			const recommended = recommendedPath(await recommendedCategory(row.offer!.title, cover.imageId!));
			if (!recommended) {
				problems.push("类目：Shopee 未推荐类目，待人定");
				return fields;
			}
			path = recommended.path;
		}
		const leaf = path.at(-1)!;
		const names = await categoryNames().catch(() => new Map<string, string>());
		Object.assign(fields, {
			category_path: path,
			category_id: leaf,
			category_name: row.category_name ?? path.map((c) => names.get(String(c)) ?? String(c)).join(" > "),
		});
		if (!categoryAllowed(String(leaf), settings.categories, row.category_exception)) problems.push("类目：不在本店允许的类目里");
		if (row.attributes === null) {
			const attributes = pickAttributes(await attributeTree(leaf));
			Object.assign(fields, { attributes: attributes.attributes, attributes_text: attributes.text.join("\n") || null });
			if (attributes.missing.length) problems.push(`属性：必填的「${attributes.missing.join("、")}」待人工填写`);
		}
		if (row.days_to_ship === null) {
			const days = daysToShip(leaf, (await shippingDays()).rules);
			fields.days_to_ship = days;
			if (days === null) problems.push("备货天数：无法读取这个类目的备货天数规则");
		}
		return fields;
	});
	return sql.begin(async (tx) => {
		const [fresh] = await tx<ListingRow[]>`select * from listings where id = ${row.id} for update`;
		if (!fresh || fresh.product_id || fresh.listed_at || currentState(fresh) !== before) throw new Error("续做期间商品稿已变化，未覆盖人工修改，请重试");
		return save(tx, row.id, done, [...new Set(problems)]);
	});
}

async function save(
	sql: Sql | postgres.TransactionSql,
	id: string,
	fields: Record<string, unknown>,
	problems: string[],
	source?: Pick<ListingRow, "source_product_id" | "source_fields">,
): Promise<{ id: string; problems: string[] }> {
	const json = new Set(["images", "offer", "variants", "pricing", "attributes", "category_path", "removed_variants"]);
	const set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, json.has(k) && v !== null && v !== undefined ? sql.json(v as Json) : v]));
	const patch = sql({ ...set, problems: problems.join("\n") || null, updated_at: new Date() });
	if (source) {
		const changed = await sql`update listings set ${patch} where id = ${id} and product_id is null and listed_at is null
			and source_product_id = ${source.source_product_id!} and exists (select 1 from listing_sources where id = ${source.source_product_id!} and deleted_at is null) and source_fields is not distinct from ${source.source_fields == null ? null : sql.json(source.source_fields as Json)}
			and not exists (select 1 from writes where params->>'listingId' = ${id} and status in ('待执行','已提交','结果未知','不一致')) returning id`;
		if (!changed.length) throw new Error("准备期间商品资料或提交状态已变化，未覆盖人工修改，请重新准备");
	} else await sql`update listings set ${patch} where id = ${id}`;
	return { id, problems };
}
