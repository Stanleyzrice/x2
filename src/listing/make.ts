// 做商品稿（x2 listing make）：读货源 → 排规格、核价 → 做图 → 类目、属性、备货天数 → 记进商品稿。docs/listing.md「每一步怎样算做完」。
// 缺的（重量、国内运费、类目不在本店范围、要填字的属性）记成问题，检查把它们放进收件箱给人；人填了以后再跑一次，做过的不重做
import { alibabaAccounts, in1688, inShop } from "../accounts.ts";
import { type Sql } from "../db/index.ts";
import { NeedsHuman } from "../errors.ts";
import { detailImages, Gone, offerIdOf, offer as readOffer, type Offer } from "../site/1688.ts";
import { attributes as attributeTree, type Category, categoryTree, recommendedCategory, shippingDays } from "../site/shopee/products.ts";
import { daysToShip, pickAttributes, recommendedPath } from "./category.ts";
import { makeImages, type Pics } from "./images.ts";
import { minPrice, type PriceParams, priceParams } from "./price.ts";
import { type Variant, variantsOf } from "./variants.ts";
import type { Mark } from "./watermark.ts";

/** 店铺设置（库里的一行）→ 核价参数、水印、上品的默认值 */
export function settingsOf(row: any) {
	const n = (v: unknown) => Number(v);
	const params: PriceParams = priceParams.parse({
		fx: n(row.fx), pricePerKgRmb: n(row.price_per_kg_rmb), labelFeeRmb: n(row.label_fee_rmb), weightRoundingKg: n(row.weight_rounding_kg),
		returnLossRate: n(row.return_loss_rate), minMarginRate: n(row.min_margin_rate), minMarginRmb: n(row.min_margin_rmb),
		commissionRate: n(row.commission_rate), preOrderRate: n(row.pre_order_rate), paymentRate: n(row.payment_rate), coinRate: n(row.coin_rate),
		freeShippingRate: n(row.free_shipping_rate), freeShippingMinTwd: n(row.free_shipping_min_twd), shippingNetTwd: n(row.shipping_net_twd),
	});
	const mark: Mark | null = row.watermark_text ? { text: row.watermark_text, size: n(row.watermark_size), opacity: n(row.watermark_opacity), position: row.watermark_position } : null;
	return {
		shop: String(row.shop), shopId: String(row.shop_id), params, mark, paused: row.paused ? String(row.paused) : null,
		preOrder: Boolean(row.pre_order), minPurchase: n(row.min_purchase), stockCap: n(row.stock_cap),
		channels: String(row.channels ?? "").split(/[,，\s]+/).filter(Boolean),
		categories: Array.isArray(row.categories) && row.categories.length ? new Set((row.categories as unknown[]).map(String)) : null,
	};
}
export type Settings = ReturnType<typeof settingsOf>;

/** 商品稿的一个规格：加上售价（核价）、库存（1688 现在的库存和库存上限的小的） */
export type Priced = Variant & { priceTwd: number | null };

/** 每个规格核价。缺重量、缺国内运费的不算（售价是 null），问题写出来 */
export function priceVariants(variants: Variant[], s: Settings, opts: { weightKg: number | null; freightRmb: number | null }): { variants: Priced[]; problems: string[] } {
	const problems: string[] = [];
	const noWeight = variants.filter((v) => !(v.weightKg && v.weightKg > 0)) ;
	if (noWeight.length && !opts.weightKg) problems.push(`重量：1688 没给 ${noWeight.length} 个规格的重量，要人在「重量」里填（kg）`);
	if (opts.freightRmb === null) problems.push("国内运费：货源不包邮，要人在「国内运费」里填（元 / 件；包邮填 0）");
	const out = variants.map((v): Priced => {
		const weightKg = v.weightKg && v.weightKg > 0 ? v.weightKg : opts.weightKg;
		const stock = Math.min(v.stock, s.stockCap);
		if (!weightKg || opts.freightRmb === null) return { ...v, weightKg, stock, priceTwd: null };
		return { ...v, weightKg, stock, priceTwd: minPrice(v.costRmb, opts.freightRmb, weightKg, s.params, s.preOrder) };
	});
	if (out.some((v) => v.priceTwd === null) && !problems.length) problems.push("核价：有规格怎么定价都过不了毛利的两道门");
	const prices = out.map((v) => v.priceTwd).filter((p): p is number => p !== null);
	if (prices.length && Math.max(...prices) > Math.min(...prices) * 5) problems.push("规格：最高价超过最低价的 5 倍，Shopee 不收（去掉太贵或太便宜的规格，或分成两个商品）");
	if (variants.length > 50) problems.push(`规格：有货的规格 ${variants.length} 个，最多 50 个`);
	return { variants: out, problems };
}

let tree: Map<string, string> | null = null;
/** 类目 id → 名字（类目树一个进程读一次） */
async function categoryNames(): Promise<Map<string, string>> {
	if (tree) return tree;
	const walk = (list: Category[], out: Map<string, string>) => { for (const c of list) { out.set(c.id, c.name); walk(c.children, out); } return out; };
	return (tree = walk(await categoryTree(), new Map()));
}

/** 在一个登录着 1688 的浏览器里读货源（读货源不用采购账号） */
async function read1688<T>(fn: () => Promise<T>): Promise<T> {
	const a = (await alibabaAccounts())[0];
	if (!a) throw new NeedsHuman("没有登录着 1688 的浏览器：读不了货源");
	return in1688(a.userId, fn);
}

/** 做一份商品稿。回这一轮的问题（给人看的） */
export async function make(sql: Sql, id: string, log: (s: string) => void = console.error): Promise<{ id: string; problems: string[] }> {
	const [l] = await sql`select * from listings where id = ${id}`;
	if (!l) throw new Error(`没有商品稿 ${id}`);
	const [row] = await sql`select * from shop_settings where shop = ${l.shop}`;
	if (!row) return save(sql, id, {}, [`店铺：店铺设置里没有「${l.shop}」`]);
	// 人在 NocoDB 表单里贴的是整个链接：改成货源 id
	const offerId = offerIdOf(String(l.offer_id));
	if (!offerId) return save(sql, id, {}, [`货源：认不出「${l.offer_id}」（贴 1688 的商品链接）`]);
	if (offerId !== l.offer_id) {
		const [dup] = await sql`select id from listings where shop = ${l.shop} and offer_id = ${offerId} and id <> ${id}`;
		if (dup) return save(sql, id, { cancelled: true, note: `和商品稿 ${dup.id} 重复` }, []);
		await sql`update listings set offer_id = ${offerId} where id = ${id}`;
		l.offer_id = offerId;
	}
	const s = settingsOf(row);
	if (!s.mark) return save(sql, id, {}, ["水印：店铺设置里还没写这家店的水印（两家店的封面要不一样）"]);

	// 1. 货源
	log(`读货源 ${l.offer_id}`);
	let o: Offer;
	try { o = await read1688(() => readOffer(l.offer_id)); } catch (e) {
		if (e instanceof Gone) return save(sql, id, {}, ["货源：1688 上下架了"]);
		throw e;
	}
	const detail = o.detailUrl ? await detailImages(o.detailUrl).catch((e) => { log(`详情图取不到：${(e as Error).message}`); return [] as string[]; }) : [];
	const problems: string[] = [];
	if (o.minQty > 1) problems.push(`货源：起订量 ${o.minQty}，一件一件买不了`);

	// 2. 规格、核价
	// 国内运费：人填的；没填就用 1688 页面上寄到我们这里买 1 件的运费（包邮是 0）；都没有才要人填
	const freight = l.freight_rmb !== null ? Number(l.freight_rmb) : o.freight?.costRmb ?? (o.tags?.freeShipping ? 0 : null);
	const priced = priceVariants(variantsOf(o), s, { weightKg: l.weight_kg !== null ? Number(l.weight_kg) : null, freightRmb: freight });
	problems.push(...priced.problems);

	// 3. 图、类目、属性、备货天数：在这家店的浏览器里
	const done = await inShop(s.shopId, async () => {
		// 候选：主图前 12 张、详情图前 16 张（最后用 9 张、12 张；多看几张是给筛掉的留余地，再多就白花筛字和译图的钱）
		const pics: Pics = await makeImages(sql, { shop: s.shop, mark: s.mark!, main: (o.images ?? [o.image]).slice(0, 12), detail: detail.slice(0, 16), options: priced.variants.map((v) => v.image).filter((x): x is string => Boolean(x)) }, log);
		// 上次放进 NocoDB 附件的（images.shown）留着：人删了哪张靠它认
		const out: Record<string, unknown> = { images: { ...pics, shown: l.images?.shown } };
		const cover = pics.main.find((p) => p.imageId);
		if (!cover) { problems.push("图：没有能用的主图"); return out; }
		if (pics.waiting.length) problems.push(`图：${pics.waiting.length} 张译图结果未知，等人核对（「写入」里改成已核对或被拒）`);
		let path: number[] = l.category_path ?? [];
		if (!path.length) {
			log("推荐类目");
			const rec = recommendedPath(await recommendedCategory(o.title, cover.imageId!));
			if (!rec) { problems.push("类目：Shopee 没推荐出类目，要人定"); return out; }
			path = rec.path;
		}
		const leaf = path[path.length - 1]!;
		const names = await categoryNames().catch(() => new Map<string, string>());
		Object.assign(out, { category_path: path, category_id: leaf, category_name: path.map((c) => names.get(String(c)) ?? String(c)).join(" > ") });
		if (s.categories && !s.categories.has(String(leaf))) problems.push(`类目：推荐的「${names.get(String(leaf)) ?? leaf}」不在本店允许的类目里`);
		const attrs = pickAttributes(await attributeTree(leaf));
		Object.assign(out, { attributes: attrs.attributes, attributes_text: attrs.text.join("\n") || null });
		if (attrs.missing.length) problems.push(`属性：必填的「${attrs.missing.join("、")}」要人填字`);
		const days = daysToShip(leaf, (await shippingDays()).rules);
		if (days === null) problems.push("备货天数：这个类目读不到备货天数的规则");
		out.days_to_ship = days;
		return out;
	});

	return save(sql, id, {
		...done,
		offer: { offerId: o.offerId, url: o.url, title: o.title, images: o.images, detail, tags: o.tags, freight: o.freight, minQty: o.minQty, props: o.props, skus: o.skus },
		offer_read_at: new Date(),
		variants: priced.variants,
		variants_text: priced.variants.map((v) => `${v.specs.map((x) => x.value).join(" / ") || "（单规格）"}：${v.priceTwd ? `NT$${v.priceTwd}` : "未定价"}，库存 ${v.stock}，${v.weightKg ?? "?"} kg`).join("\n"),
		pricing: { params: s.params, preOrder: s.preOrder, freightRmb: freight, at: new Date().toISOString() },
	}, problems);
}

async function save(sql: Sql, id: string, fields: Record<string, unknown>, problems: string[]): Promise<{ id: string; problems: string[] }> {
	const json = new Set(["images", "offer", "variants", "pricing", "attributes", "category_path"]);
	const set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, json.has(k) && v !== null && v !== undefined ? sql.json(v as any) : v]));
	await sql`update listings set ${sql({ ...set, problems: problems.join("\n") || null, updated_at: new Date() } as any)} where id = ${id}`;
	return { id, problems };
}
