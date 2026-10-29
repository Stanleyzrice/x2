// 做商品稿（x2 listing make）：读货源 → 排规格、核价 → 做图 → 类目、属性、备货天数 → 记进商品稿。
// 缺的（类目不在本店范围、要填字的属性……）记成问题，x2 status 提醒人；人处理了以后再跑一次，做过的不重做。
// 1688 没给的重量、读不到的国内运费不算问题：agent 估（x2 listing estimate，只填空着的），写完照货源快照重新核价（reprice），不用再读 1688。
// 几份同时做（x2 listing make --jobs）：碰浏览器的（读 1688 货源、加水印、传图、类目、属性、备货天数）按浏览器排队，读 1688 隔几秒（queue.ts）；
// 问 Gemini、交象寄、取图不排队。报价（quote，选品用）用第 2 步的同一套代码，不做图、不存库

import { detailImages, Gone, type Offer, offer as readOffer } from "../../connectors/sites/1688/api.ts";
import { attributes as attributeTree, type Category, categoryTree, recommendedCategory, shippingDays } from "../../connectors/sites/shopee/products.ts";
import { alibabaAccounts } from "../../platform/browser/accounts.ts";
import type { Sql } from "../../platform/db/index.ts";
import { NeedsHuman } from "../../platform/errors.ts";
import { daysToShip, pickAttributes, recommendedPath } from "./category.ts";
import { makeImages } from "./images.ts";
import type { Pics } from "./pics.ts";
import { freightOf, num, reprice, type Settings, settingsOf, specsAndPrices } from "./pricing.ts";
import { from1688, inShopQueued, on1688, type Runner } from "./queue.ts";
import { nicknameFor } from "./text.ts";
import { specsOf } from "./variants.ts";

/** 重新核价，用的重量、国内运费变了才存（规格、核价参数）。l 跟着改；回存了没有 */
export async function savePrices(sql: Sql, l: any, s: Settings): Promise<boolean> {
	const r = reprice(l, s);
	if (!r?.changed) return false;
	const fields = { variants: r.specs, pricing: { params: s.params, preOrder: s.preOrder, freightRmb: r.freightRmb, at: new Date().toISOString() } };
	await sql`update listings set variants = ${sql.json(fields.variants as any)}, pricing = ${sql.json(fields.pricing as any)}, updated_at = now() where id = ${l.id}`;
	Object.assign(l, fields);
	return true;
}

let tree: Map<string, string> | null = null;
/** 类目 id → 名字（类目树一个进程读一次） */
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

/** 读 1688 货源：在一个登录着 1688 的浏览器里（读货源不用采购账号），排在这个浏览器的队里，和上一次读 1688 隔几秒 */
export async function readOffer1688(offerId: string): Promise<Offer> {
	const a = (await alibabaAccounts())[0];
	if (!a) throw new NeedsHuman("没有登录着 1688 的浏览器：读不了货源");
	return on1688(a.userId, () => readOffer(offerId));
}

/** 做一份商品稿。回这一轮的问题（给人看的） */
export async function make(sql: Sql, id: string, log: (s: string) => void = console.error): Promise<{ id: string; problems: string[] }> {
	const [l] = await sql`select * from listings where id = ${id}`;
	if (!l) throw new Error(`没有商品稿 ${id}`);
	// 店铺有外键：一定有店铺设置
	const [row] = await sql`select * from shop_settings where shop = ${l.shop}`;
	const s = settingsOf(row!);
	if (!s.mark) return save(sql, id, {}, ["水印：店铺设置里缺这家店的水印（两家店的封面要不一样）"]);

	// 1. 货源（1688 的页面、详情图的地址：排队，和上一次读 1688 隔几秒）
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

	// 2. 规格、核价。缺重量、缺国内运费的售价先空着（agent 估）；定不了价的、超过上限的现算（pricingProblems），不存
	const freight = freightOf(o, l.freight_rmb);
	const { specs, problems } = specsAndPrices(o, s, {
		removed: l.removed_variants ?? [],
		prev: specsOf(l.variants),
		weightKg: num(l.weight_kg),
		freightRmb: freight,
	});

	// 3. 图：问 Gemini、交象寄、取图不排队；加水印、传图在这家店的浏览器里排队。
	// 候选：主图前 12 张、详情图前 16 张（最后用 9 张、12 张；多看几张是给筛掉的留余地，再多就白花筛字和译图的钱）
	const browser: Runner = (fn) => inShopQueued(s.shopId, fn);
	const pics: Pics = await makeImages(
		sql,
		{
			shop: s.shop,
			mark: s.mark,
			browser,
			main: (o.images ?? [o.image]).slice(0, 12),
			detail: detail.slice(0, 16),
			options: (specs.tiers[0]?.options ?? []).map((x) => x.image).filter((x): x is string => Boolean(x)),
		},
		log,
	);
	const done: Record<string, unknown> = { images: pics };
	const cover = pics.main.find((p) => p.imageId);
	if (!cover) problems.push("图：缺可用的主图");
	// 4. 类目、属性、备货天数：卖家中心的接口，在这家店的浏览器里排队
	else
		Object.assign(
			done,
			await browser(async () => {
				const out: Record<string, unknown> = {};
				// 已经有类目的（上次推荐的，人定的：x2 listing category）不再问推荐，照用
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
				// 类目树读不到：已经有的类目的名字照旧
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
			// 简称：空着的、还是上一版自动填的，先填 1688 标题的前 12 个字；人改过、agent 写过的不动
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
			pricing: { params: s.params, preOrder: s.preOrder, freightRmb: freight, at: new Date().toISOString() },
		},
		problems,
	);
}

async function save(sql: Sql, id: string, fields: Record<string, unknown>, problems: string[]): Promise<{ id: string; problems: string[] }> {
	const json = new Set(["images", "offer", "variants", "pricing", "attributes", "category_path"]);
	const set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, json.has(k) && v !== null && v !== undefined ? sql.json(v as any) : v]));
	await sql`update listings set ${sql({ ...set, problems: problems.join("\n") || null, updated_at: new Date() } as any)} where id = ${id}`;
	return { id, problems };
}
