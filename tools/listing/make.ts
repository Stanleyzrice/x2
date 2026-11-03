// 做商品稿（x2 listing make）：读货源 → 排规格、核价 → 做图 → 类目、属性、备货天数 → 记进商品稿。
// 缺的（类目不在本店范围、要填字的属性……）记成问题，x2 status 提醒人；人处理了以后再跑一次，做过的不重做。
// 1688 没给的重量、读不到的国内运费不算问题：agent 估（x2 listing estimate，只填空着的），写完照货源快照重新核价（reprice），不用再读 1688。
// 几份同时做（x2 listing make --jobs）：碰浏览器的（读 1688 货源、加水印、传图、类目、属性、备货天数）按浏览器排队，读 1688 隔几秒（queue.ts）；
// 问 Gemini、交象寄、取图不排队。报价（quote，选品用）用第 2 步的同一套代码，不做图、不存库

import { detailImages, Gone, type Offer, type OfferId, offer as readOffer } from "../../connectors/sites/1688/api.ts";
import { attributes as attributeTree, type Category, categoryTree, recommendedCategory, shippingDays } from "../../connectors/sites/shopee/products.ts";
import { logins } from "../../platform/browser/browser.ts";
import type { Json, Sql } from "../../platform/db/index.ts";
import { NeedsHuman } from "../../platform/errors.ts";
import { daysToShip, pickAttributes, recommendedPath } from "./category.ts";
import { makeImages } from "./images.ts";
import { type ImageMode, imageModeOf, type Pics } from "./pics.ts";
import { freightOf, num, pricingPolicy, reprice, type Settings, settingsOf, specsAndPrices, usableWeights } from "./pricing.ts";
import { from1688, inShopQueued, on1688, type Runner } from "./queue.ts";
import type { ListingRow, ShopSettingsRow } from "./row.ts";
import { nicknameFor } from "./text.ts";
import { specsOf } from "./variants.ts";

export async function savePrices(sql: Sql, l: ListingRow, s: Settings): Promise<boolean> {
	const r = reprice(l, s);
	if (!r?.changed) return false;
	const fields = { variants: r.specs, pricing: { ...pricingPolicy(s), freightRmb: r.freightRmb, at: new Date().toISOString() } };
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
	options: { imageMode?: ImageMode } = {},
): Promise<{ id: string; problems: string[] }> {
	const [l] = await sql<ListingRow[]>`select * from listings where id = ${id}`;
	if (!l) throw new Error(`没有商品稿 ${id}`);
	const [row] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${l.shop}`;
	const s = settingsOf(row!);
	const imageMode = imageModeOf(options.imageMode, l.images);
	if (imageMode === "processed" && !s.mark) return save(sql, id, {}, ["水印：店铺设置里缺这家店的水印（两家店的封面要不一样）"]);

	log(`读货源 ${l.offer_id}`);
	let o: Offer;
	try {
		o = await readOffer1688(l.offer_id);
	} catch (e) {
		if (e instanceof Gone) return save(sql, id, {}, ["货源：已在 1688 下架"]);
		throw e;
	}
	const detail = o.detailUrl
		? await from1688(() => detailImages(o.detailUrl!)).catch((e) => {
				log(`详情图取不到：${(e as Error).message}`);
				return [] as string[];
			})
		: [];

	const freight = freightOf(o, l.freight_rmb);
	const { specs, problems } = specsAndPrices(o, s, {
		removed: l.removed_variants ?? [],
		prev: specsOf(l.variants),
		weightKg: num(l.weight_kg),
		freightRmb: freight,
	});

	const browser: Runner = (fn) => inShopQueued(s.shopId, fn);
	const pics: Pics = await makeImages(
		sql,
		{
			shop: s.shop,
			mark: s.mark,
			imageMode,
			browser,
			main: (o.images ?? [o.image]).slice(0, CANDIDATE_MAIN),
			detail: detail.slice(0, CANDIDATE_DETAIL),
			options: (specs.tiers[0]?.options ?? []).map((x) => x.image).filter((x): x is string => Boolean(x)),
		},
		log,
	);
	const done: Record<string, unknown> = { images: pics };
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
				if (s.categories && !s.categories.has(String(leaf))) problems.push(`类目：推荐的「${names.get(String(leaf)) ?? leaf}」不在本店允许的类目里`);
				const attrs = pickAttributes(await attributeTree(leaf));
				Object.assign(out, { attributes: attrs.attributes, attributes_text: attrs.text.join("\n") || null });
				if (attrs.missing.length) problems.push(`属性：必填的「${attrs.missing.join("、")}」待人工填写`);
				const days = daysToShip(leaf, (await shippingDays()).rules);
				if (days === null) problems.push("备货天数：无法读取这个类目的备货天数规则");
				out.days_to_ship = days;
				return out;
			}),
		);

	return save(
		sql,
		id,
		{
			...done,
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
			pricing: { ...pricingPolicy(s), freightRmb: freight, at: new Date().toISOString() },
		},
		problems,
	);
}

async function save(sql: Sql, id: string, fields: Record<string, unknown>, problems: string[]): Promise<{ id: string; problems: string[] }> {
	const json = new Set(["images", "offer", "variants", "pricing", "attributes", "category_path"]);
	const set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, json.has(k) && v !== null && v !== undefined ? sql.json(v as Json) : v]));
	await sql`update listings set ${sql({ ...set, problems: problems.join("\n") || null, updated_at: new Date() })} where id = ${id}`;
	return { id, problems };
}
