// 做商品稿（x2 listing make）：读货源 → 排规格、核价 → 做图 → 类目、属性、备货天数 → 记进商品稿。docs/listing.md「每一步怎样算做完」。
// 缺的（类目不在本店范围、要填字的属性……）记成问题，检查把它们放进收件箱给人；人处理了以后再跑一次，做过的不重做。
// 1688 没给的重量、读不到的国内运费不算问题：agent 估（x2 listing estimate，只填空着的），写完照货源快照重新核价（reprice），不用再读 1688。
// 几份同时做（x2 listing make --jobs）：碰浏览器的（读 1688 货源、加水印、传图、类目、属性、备货天数）按浏览器排队，读 1688 隔几秒（queue.ts）；
// 问 Gemini、交象寄、取图不排队。报价（quote，选品用）用第 2 步的同一套代码，不做图、不存库
import { alibabaAccounts } from "../accounts.ts";
import { type Sql } from "../db/index.ts";
import { NeedsHuman } from "../errors.ts";
import { detailImages, Gone, offerIdOf, offer as readOffer, type Offer } from "../site/1688.ts";
import { attributes as attributeTree, type Category, categoryTree, recommendedCategory, shippingDays } from "../site/shopee/products.ts";
import { daysToShip, pickAttributes, recommendedPath } from "./category.ts";
import { makeImages, type Pics } from "./images.ts";
import { minPrice, type PriceParams, priceParams } from "./price.ts";
import { from1688, inShopQueued, on1688, type Runner } from "./queue.ts";
import { nicknameFor } from "./text.ts";
import { limitProblems, priceRange, removedOf, type Specs, specsFrom, specsOf, specsText, structureProblems, type Variant } from "./variants.ts";
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

/** 每个规格核价：售价、重量（1688 没给的用商品稿的「重量」）、库存（1688 现在的库存和库存上限的小的）。缺重量、缺国内运费的不算（售价是 null）。
 * 定不了价的、超过上限的在 pricingProblems */
export function priceVariants(variants: Variant[], s: Settings, opts: { weightKg: number | null; freightRmb: number | null }): Variant[] {
	return variants.map((v): Variant => {
		const weightKg = v.weightKg && v.weightKg > 0 ? v.weightKg : opts.weightKg;
		const stock = Math.min(v.stock, s.stockCap);
		if (!weightKg || opts.freightRmb === null) return { ...v, weightKg, stock, priceTwd: null };
		return { ...v, weightKg, stock, priceTwd: minPrice(v.costRmb, opts.freightRmb, weightKg, s.params, s.preOrder) };
	});
}

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

/** 国内运费（元 / 件）：商品稿的「国内运费」（agent 估的、人填的）；空着就用 1688 页面上寄到我们这里买 1 件的运费（包邮是 0）；都没有是 null */
export const freightOf = (offer: Partial<Offer> | null | undefined, column: unknown): number | null =>
	num(column) ?? offer?.freight?.costRmb ?? (offer?.tags?.freeShipping ? 0 : null);

/** 货源快照里 1688 给的每个规格的重量（规格 id → kg；没给的不在里面） */
const weightsOf = (offer: Partial<Offer> | null | undefined) => new Map((offer?.skus ?? []).filter((k) => (k.weightKg ?? 0) > 0).map((k) => [k.skuId, k.weightKg!]));

export type Need = "重量" | "国内运费";
/** agent 要估的：重量（有规格 1688 没给重量，「重量」也空着）、国内运费（1688 读不到，「国内运费」也空着）。人填过的不算缺 */
export function estimateNeeds(l: any): Need[] {
	const specs = specsOf(l.variants);
	if (!l.offer || !specs) return [];
	const weights = weightsOf(l.offer);
	const needs: Need[] = [];
	if (num(l.weight_kg) === null && specs.variants.some((v) => !weights.has(v.skuId))) needs.push("重量");
	if (freightOf(l.offer, l.freight_rmb) === null) needs.push("国内运费");
	return needs;
}

/** 核价以后的问题（现算，不存进商品稿的 problems：「重量」「国内运费」一改就变）：缺的先由 agent 估；都有了还有规格定不了价的、超过上限的给人 */
export function pricingProblems(specs: Specs, needs: Need[]): string[] {
	if (needs.length) return [`缺${needs.join("、")}：agent 估（x2 listing estimate）`];
	return [...(specs.variants.some((v) => v.priceTwd === null) ? ["核价：有规格怎么定价都过不了毛利的两道门"] : []), ...limitProblems(specs)];
}

/** 重新核价（不读 1688）：照货源快照里 1688 给的重量，和商品稿的「重量」「国内运费」，重算每个规格的重量、售价。还没做商品稿回 null。
 * changed：用的重量、国内运费和存着的不一样（agent 估了、人改了「重量」「国内运费」），要存 */
export function reprice(l: any, s: Settings): { specs: Specs; freightRmb: number | null; changed: boolean } | null {
	const specs = specsOf(l.variants);
	if (!l.offer || !specs) return null;
	const weights = weightsOf(l.offer);
	const freightRmb = freightOf(l.offer, l.freight_rmb);
	const variants = priceVariants(specs.variants.map((v) => ({ ...v, weightKg: weights.get(v.skuId) ?? null })), s, { weightKg: num(l.weight_kg), freightRmb });
	const changed = (l.pricing?.freightRmb ?? null) !== freightRmb || variants.some((v, i) => v.weightKg !== specs.variants[i]!.weightKg);
	return { specs: { tiers: specs.tiers, variants }, freightRmb, changed };
}

/** 重新核价，用的重量、国内运费变了才存（规格、规格和价格、核价参数）。l 跟着改；回存了没有 */
export async function savePrices(sql: Sql, l: any, s: Settings): Promise<boolean> {
	const r = reprice(l, s);
	if (!r?.changed) return false;
	const fields = { variants: r.specs, variants_text: specsText(r.specs, removedOf(l.offer, l.removed_variants)), pricing: { params: s.params, preOrder: s.preOrder, freightRmb: r.freightRmb, at: new Date().toISOString() } };
	await sql`update listings set variants = ${sql.json(fields.variants as any)}, variants_text = ${fields.variants_text}, pricing = ${sql.json(fields.pricing as any)}, updated_at = now() where id = ${l.id}`;
	Object.assign(l, fields);
	return true;
}

let tree: Map<string, string> | null = null;
/** 类目 id → 名字（类目树一个进程读一次） */
async function categoryNames(): Promise<Map<string, string>> {
	if (tree) return tree;
	const walk = (list: Category[], out: Map<string, string>) => { for (const c of list) { out.set(c.id, c.name); walk(c.children, out); } return out; };
	return (tree = walk(await categoryTree(), new Map()));
}

/** 读 1688 货源：在一个登录着 1688 的浏览器里（读货源不用采购账号），排在这个浏览器的队里，和上一次读 1688 隔几秒 */
export async function readOffer1688(offerId: string): Promise<Offer> {
	const a = (await alibabaAccounts())[0];
	if (!a) throw new NeedsHuman("没有登录着 1688 的浏览器：读不了货源");
	return on1688(a.userId, () => readOffer(offerId));
}

/** 货源 → 排好、核好价的规格（做商品稿的第 2 步，报价也用它）：有货的、没移除的规格排成 Shopee 的规格（prev：上一版，名字按 1688 层名、原值对回去），
 * 每个规格核价（weightKg、freightRmb 是 1688 没给重量时、国内运费用的），再核一遍规格的结构。problems 是要人处理的（起订量、规格图、结构） */
export function specsAndPrices(o: Offer, s: Settings, opts: { removed?: string[]; prev?: Specs | null; weightKg: number | null; freightRmb: number | null }): { specs: Specs; problems: string[] } {
	const built = specsFrom(o, opts.removed ?? [], opts.prev ?? null);
	const specs: Specs = { tiers: built.specs.tiers, variants: priceVariants(built.specs.variants, s, { weightKg: opts.weightKg, freightRmb: opts.freightRmb }) };
	return { specs, problems: [...(o.minQty > 1 ? [`货源：起订量 ${o.minQty}，无法单件购买`] : []), ...built.problems, ...structureProblems(specs)] };
}


/** 报价（选品用，x2 listing quote）：照做商品稿的第 2 步排规格、按店铺设置核价，不做图、不存库。1688 没给重量的规格按 assume.weightKg 算、
 * 读不到国内运费的按 assume.freightRmb 算（往重了、往高了估），用了估的写出来 */
export function quote(o: Offer, s: Settings, assume: { weightKg: number; freightRmb: number }) {
	const read = freightOf(o, null);
	const freightRmb = read ?? assume.freightRmb;
	const { specs, problems } = specsAndPrices(o, s, { weightKg: assume.weightKg, freightRmb });
	const given = new Map(o.skus.map((k) => [k.skuId, k]));
	const list = specs.variants.map((v) => {
		const k = given.get(v.skuId);
		return { sku: v.sku, spec: (k?.attrs ?? []).filter(Boolean).join(" / ") || k?.name || "（单规格）", priceTwd: v.priceTwd, weightKg: v.weightKg, weightAssumed: !((k?.weightKg ?? 0) > 0), costRmb: v.costRmb, stock: v.stock };
	});
	const guessed = list.filter((x) => x.weightAssumed).length;
	return {
		offerId: o.offerId, url: o.url, title: o.title, shop: s.shop, minQty: o.minQty,
		tags: { onePsale: Boolean(o.tags?.onePsale), ship48h: Boolean(o.tags?.ship48h), freeShipping: Boolean(o.tags?.freeShipping), deliveryDays: o.tags?.deliveryDays ?? null },
		freightRmb, freightAssumed: read === null,
		weightAssumed: guessed ? `${guessed} 个规格 1688 没给重量，按 ${assume.weightKg} kg 算` : null,
		variants: list.length, priceTwd: priceRange(specs.variants), specs: specsText(specs), list,
		problems: [...problems, ...pricingProblems(specs, [])],
	};
}

/** 做一份商品稿。回这一轮的问题（给人看的） */
export async function make(sql: Sql, id: string, log: (s: string) => void = console.error): Promise<{ id: string; problems: string[] }> {
	const [l] = await sql`select * from listings where id = ${id}`;
	if (!l) throw new Error(`没有商品稿 ${id}`);
	const [row] = await sql`select * from shop_settings where shop = ${l.shop}`;
	if (!row) return save(sql, id, {}, [`店铺：店铺设置里缺「${l.shop}」`]);
	// 人在 NocoDB 表单里贴的是整个链接：改成货源 id
	const offerId = offerIdOf(String(l.offer_id));
	if (!offerId) return save(sql, id, {}, [`货源：无法识别「${l.offer_id}」（贴 1688 的商品链接）`]);
	if (offerId !== l.offer_id) {
		const [dup] = await sql`select id from listings where shop = ${l.shop} and offer_id = ${offerId} and id <> ${id}`;
		if (dup) return save(sql, id, { cancelled: true, note: `和商品稿 ${dup.id} 重复` }, []);
		await sql`update listings set offer_id = ${offerId} where id = ${id}`;
		l.offer_id = offerId;
	}
	const s = settingsOf(row);
	if (!s.mark) return save(sql, id, {}, ["水印：店铺设置里缺这家店的水印（两家店的封面要不一样）"]);

	// 1. 货源（1688 的页面、详情图的地址：排队，和上一次读 1688 隔几秒）
	log(`读货源 ${l.offer_id}`);
	let o: Offer;
	try { o = await readOffer1688(l.offer_id); } catch (e) {
		if (e instanceof Gone) return save(sql, id, {}, ["货源：已在 1688 下架"]);
		throw e;
	}
	const detail = o.detailUrl ? await from1688(() => detailImages(o.detailUrl!)).catch((e) => { log(`详情图取不到：${(e as Error).message}`); return [] as string[]; }) : [];

	// 2. 规格、核价。缺重量、缺国内运费的售价先空着（agent 估）；定不了价的、超过上限的现算（pricingProblems），不存
	const freight = freightOf(o, l.freight_rmb);
	const { specs, problems } = specsAndPrices(o, s, { removed: l.removed_variants ?? [], prev: specsOf(l.variants), weightKg: num(l.weight_kg), freightRmb: freight });

	// 3. 图：问 Gemini、交象寄、取图不排队；加水印、传图在这家店的浏览器里排队。
	// 候选：主图前 12 张、详情图前 16 张（最后用 9 张、12 张；多看几张是给筛掉的留余地，再多就白花筛字和译图的钱）
	const browser: Runner = (fn) => inShopQueued(s.shopId, fn);
	const pics: Pics = await makeImages(sql, { shop: s.shop, mark: s.mark, browser, main: (o.images ?? [o.image]).slice(0, 12), detail: detail.slice(0, 16), options: (specs.tiers[0]?.options ?? []).map((x) => x.image).filter((x): x is string => Boolean(x)) }, log);
	// 上次放进 NocoDB 附件的（images.shown）留着：人删了哪张靠它认
	const done: Record<string, unknown> = { images: { ...pics, shown: l.images?.shown } };
	const cover = pics.main.find((p) => p.imageId);
	if (!cover) problems.push("图：缺可用的主图");
	// 4. 类目、属性、备货天数：卖家中心的接口，在这家店的浏览器里排队
	else Object.assign(done, await browser(async () => {
		const out: Record<string, unknown> = {};
		let path: number[] = l.category_path ?? [];
		if (!path.length) {
			log("推荐类目");
			const rec = recommendedPath(await recommendedCategory(o.title, cover.imageId!));
			if (!rec) { problems.push("类目：Shopee 未推荐类目，待人定"); return out; }
			path = rec.path;
		}
		const leaf = path[path.length - 1]!;
		const names = await categoryNames().catch(() => new Map<string, string>());
		Object.assign(out, { category_path: path, category_id: leaf, category_name: path.map((c) => names.get(String(c)) ?? String(c)).join(" > ") });
		if (s.categories && !s.categories.has(String(leaf))) problems.push(`类目：推荐的「${names.get(String(leaf)) ?? leaf}」不在本店允许的类目里`);
		const attrs = pickAttributes(await attributeTree(leaf));
		Object.assign(out, { attributes: attrs.attributes, attributes_text: attrs.text.join("\n") || null });
		if (attrs.missing.length) problems.push(`属性：必填的「${attrs.missing.join("、")}」待人工填写`);
		const days = daysToShip(leaf, (await shippingDays()).rules);
		if (days === null) problems.push("备货天数：无法读取这个类目的备货天数规则");
		out.days_to_ship = days;
		return out;
	}));

	return save(sql, id, {
		...done,
		// 简称：空着的、还是上一版自动填的，先填 1688 标题的前 12 个字；人改过、agent 写过的不动
		nickname: nicknameFor(l.nickname, l.offer?.title, o.title),
		offer: { offerId: o.offerId, url: o.url, title: o.title, images: o.images, detail, tags: o.tags, freight: o.freight, minQty: o.minQty, props: o.props, skus: o.skus },
		offer_read_at: new Date(),
		variants: specs,
		variants_text: specsText(specs, removedOf(o, l.removed_variants)),
		pricing: { params: s.params, preOrder: s.preOrder, freightRmb: freight, at: new Date().toISOString() },
	}, problems);
}

async function save(sql: Sql, id: string, fields: Record<string, unknown>, problems: string[]): Promise<{ id: string; problems: string[] }> {
	const json = new Set(["images", "offer", "variants", "pricing", "attributes", "category_path"]);
	const set = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, json.has(k) && v !== null && v !== undefined ? sql.json(v as any) : v]));
	await sql`update listings set ${sql({ ...set, problems: problems.join("\n") || null, updated_at: new Date() } as any)} where id = ${id}`;
	return { id, problems };
}
