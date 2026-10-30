// 零销量商品下架：人给出商品编号和统计期间，现读两种销量与在售状态，再交平台写入引擎；只改 unlisted，结果未知不重发。
// 期间已结束仍可能有统计回补，执行中的销量最多复用两分钟；每个商品提交前还会现读详情。商品稿不因下架而被标成放弃。
import { z } from "zod";
import { liveProducts, type Performance, type Product, performance, productInfo } from "../../connectors/sites/shopee/products.ts";
import { unlistProduct } from "../../connectors/sites/shopee/publish.ts";
import { ItemId } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { day, str, strs } from "../../platform/tool.ts";
import { type WriteOp, writeOp } from "../../platform/writes.ts";

const productId = ItemId.refine((id) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0, "商品 id 要是正整数且不丢精度");
export const unlistParams = z
	.object({
		shop: str("店铺账号名（店铺设置里的 shop）"),
		ids: strs("人同意下架的 Shopee 商品 id，逗号分隔；不是商品稿编号").pipe(z.array(productId)),
		start: day("零销量统计开始"),
		end: day("零销量统计结束", true),
		period: z.enum(["past7days", "past30days"]).default("past30days"),
	})
	.refine((p) => p.end >= p.start, { message: "结束不能早于开始", path: ["end"] });
type Input = z.output<typeof unlistParams>;
type Live = Pick<Product, "productId" | "name" | "parentSku">;
type Metric = Pick<Performance, "id" | "confirmed_units" | "paid_units">;

/** 只在明确的双零和在售交集里选；人的清单外的商品即使也是零销量也不碰 */
export function eligibleUnlists(ids: ItemId[], live: Live[], metrics: Metric[]): { ready: Live[]; skipped: { productId: ItemId; why: string }[] } {
	const products = new Map(live.map((p) => [p.productId, p]));
	const sales = new Map(metrics.map((p) => [p.id, p]));
	const ready: Live[] = [],
		skipped: { productId: ItemId; why: string }[] = [];
	for (const productId of new Set(ids)) {
		const p = products.get(productId),
			s = sales.get(productId);
		const why = !p
			? "当前在售列表没有这个商品，不提交下架"
			: !s
				? "期间商品表现未返回"
				: s.confirmed_units == null || s.paid_units == null
					? "期间销量未知"
					: s.confirmed_units !== 0 || s.paid_units !== 0
						? "期间确认销量或已付款件数不为零"
						: null;
		if (why) skipped.push({ productId, why });
		else if (p) ready.push(p);
	}
	return { ready, skipped };
}

/** 在售可能只是异步更新还没到，不能据此认定没做成后再发 */
export const unlistState = (p: { status?: unknown; is_unlisted?: unknown }): true | null => (p.is_unlisted === true || Number(p.status) === 8 ? true : null);
export const firstUnlistBlock = (count: number, tried: boolean): string | null =>
	count > 1 && !tried ? "下架还没有核对成功的试跑：先和运营约一个商品一起跑 --try，再批量" : null;

async function allPages<R>(fetch: (page: number) => Promise<{ total: number; rows: R[] }>): Promise<R[]> {
	const rows: R[] = [];
	let total: number | undefined;
	for (let n = 1; ; n++) {
		const r = await fetch(n);
		if (!Number.isSafeInteger(r.total) || r.total < 0 || (total !== undefined && r.total !== total)) throw new Error("商品列表条数变了：重新读取，不执行下架");
		total = r.total;
		rows.push(...r.rows);
		if (rows.length >= total) return rows;
		if (!r.rows.length) throw new Error("商品列表未读全：不执行下架");
	}
}

type Window = Pick<Input, "start" | "end" | "period">;
const metricsCache = new Map<string, { at: number; value: Promise<Performance[]> }>();
async function metricsIn(shopId: string, p: Window, fresh = false): Promise<Performance[]> {
	const key = `${shopId}:${p.start}:${p.end}:${p.period}`;
	let cached = metricsCache.get(key);
	if (fresh || !cached || Date.now() - cached.at > 120_000) {
		cached = { at: Date.now(), value: allPages((n) => performance(p.start, p.end, p.period, n)) };
		metricsCache.set(key, cached);
	}
	try {
		return await cached.value;
	} catch (e) {
		metricsCache.delete(key);
		throw e;
	}
}

async function shopIdOf(sql: Sql, shop: string): Promise<string> {
	const [row] = await sql<{ shop_id: string }[]>`select shop_id from shop_settings where shop = ${shop}`;
	if (!row) throw new Usage(`店铺设置里没有 ${shop}`);
	return row.shop_id;
}

export async function previewUnlist(sql: Sql, p: Input) {
	const shopId = await shopIdOf(sql, p.shop);
	return inAccount("shopee", shopId, async () => {
		const live = await allPages((n) => liveProducts(n));
		const metrics = await metricsIn(shopId, p, true);
		const r = eligibleUnlists(p.ids, live, metrics);
		return { shop: p.shop, shopId, start: p.start, end: p.end, period: p.period, checkedAt: new Date().toISOString(), requested: new Set(p.ids).size, ...r };
	});
}

export async function planUnlist(sql: Sql, p: Input) {
	const preview = await previewUnlist(sql, p);
	if (preview.skipped.length)
		throw new Usage(`${preview.skipped.map((x) => `${x.productId}：${x.why}`).join("\n")}\n一份都没做；先用 listing unlist-preview 核对清单`);
	const tried = await sql<{ id: string }[]>`select id::text from writes where op = '下架' and status in ('成功', '已核对') limit 1`;
	const first = firstUnlistBlock(preview.ready.length, tried.length > 0);
	if (first) throw new Usage(first);
	return [preview.ready.map((r) => ({ op: "下架", params: { ...r, shop: p.shop, shopId: preview.shopId, start: p.start, end: p.end, period: p.period } }))];
}

const params = z.object({
	productId,
	parentSku: z.string(),
	name: z.string(),
	shop: z.string(),
	shopId: z.string(),
	start: z.number(),
	end: z.number(),
	period: z.enum(["past7days", "past30days"]),
});
type Params = z.output<typeof params>;
const unlist: WriteOp<Params, { status: unknown; unlisted: unknown }> = {
	describe: "把零销量商品从在售改成下架",
	params,
	target: (p) => `shopee:${p.shopId}:${p.parentSku || p.productId}`,
	key: (p) => `unlist:${p.shopId}:${p.productId}`,
	display: (p) => `${p.shop}「${p.name}」（商品 ${p.productId}）`,
	link: "https://seller.shopee.tw/portal/product/list/all",
	untried: "下架是新写操作：先和运营约一个商品一起跑 --try，核对后再批量",
	where: (_sql, p, fn) => inAccount("shopee", p.shopId, fn),
	async prepare(sql, p) {
		if ((await shopIdOf(sql, p.shop)) !== p.shopId) return { skip: "店铺设置刚改过：重新确认店铺" };
		const now = await productInfo(p.productId);
		if (unlistState(now)) return { skip: "现读已经下架，不再提交" };
		if (Number(now.status) !== 1 || now.is_unlisted !== false) return { skip: "现读不能明确确认在售，不提交下架" };
		if (now.name !== p.name || (now.parent_sku ?? "") !== p.parentSku) return { skip: "商品名称或货号刚改过：重新确认后再下架" };
		const metric = (await metricsIn(p.shopId, p)).find((m) => m.id === p.productId);
		if (metric?.confirmed_units !== 0 || metric.paid_units !== 0) return { skip: "期间表现未返回、未知或已经有销量，不提交下架" };
		return { params: p, before: { status: now.status, unlisted: now.is_unlisted } };
	},
	submit: (_sql, p) => unlistProduct.submit({ productId: p.productId }),
	async check(p, _before, fresh) {
		for (let n = 0; n < (fresh ? 6 : 1); n++) {
			if (n) await new Promise((ok) => setTimeout(ok, 3000));
			const now = await productInfo(p.productId);
			const done = unlistState(now);
			if (done || !fresh || n === 5) return { done, readback: { status: now.status, unlisted: now.is_unlisted, name: now.name } };
		}
		return { done: null, readback: null };
	},
};
export const UNLIST_WRITES = { 下架: writeOp(unlist) };
