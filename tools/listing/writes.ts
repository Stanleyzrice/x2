// 上品的写：建商品、上架（Shopee，经至多一次写入）；译图（象寄，直接调）。写入引擎（platform/writes.ts）按 prepare → 记意图 → submit → check 调；
// prepare 是业务上的保护：建商品前照商品稿现组一遍，和人同意时交给 x2 的一样才建
import { z } from "zod";
import { fetchImage } from "../../connectors/services/image/api.ts";
import type { Outcome } from "../../connectors/services/xiangji/api.ts";
import { translateImages } from "../../connectors/services/xiangji/index.ts";
import { channels, productInfo, productPage } from "../../connectors/sites/shopee/products.ts";
import { createListing, findByParentSku, listProduct } from "../../connectors/sites/shopee/publish.ts";
import { inAccount } from "../../platform/browser/accounts.ts";
import { db, type Sql } from "../../platform/db/index.ts";
import type { WriteOp } from "../../platform/writes.ts";
import { minPrice } from "./price.ts";
import { settingsOf } from "./pricing.ts";
import { readbackProblems } from "./product.ts";
import { productOf } from "./ready.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function translationState(sql: Sql, shas: string[]): Promise<Map<string, { url?: string; failed?: string; saved: boolean }>> {
	const rows =
		await sql`select o.sha256, o.checks->'译图' as t, exists (select 1 from images t where t.kind = '译图' and t.from_sha = o.sha256) as saved from images o where o.sha256 in ${sql(shas)}`;
	return new Map(rows.filter((r) => r.t || r.saved).map((r) => [r.sha256 as string, { url: r.t?.url, failed: r.t?.failed, saved: Boolean(r.saved) }]));
}

/** 象寄的地址大约 80 天失效：拿到就取回来存进库 */
export async function saveTranslation(sql: Sql, origin: string, url: string): Promise<void> {
	const b = await fetchImage(url);
	await sql`insert into images ${sql({ sha256: b.sha256, kind: "译图", source: url, from_sha: origin, mime: b.mime, width: b.width, height: b.height, bytes: Buffer.from(b.bytes) })} on conflict (sha256) do nothing`;
}

export async function translate(sql: Sql, items: { sha: string; url: string }[]): Promise<void> {
	const w = await translateImages.submit({ urls: items.map((i) => i.url) });
	const at = new Date().toISOString();
	const mark = async (sha: string, v: Record<string, string>) =>
		sql`update images set checks = checks || ${sql.json({ 译图: { ...v, at } })} where sha256 = ${sha}`;
	if (w.kind === "refused") throw new Error(`象寄没译：${w.why}`);
	if (w.kind !== "done") throw new Error(`象寄没答复，这 ${items.length} 张下次重交：${w.why}`);
	const r = w.data as Extract<Outcome, { kind: "done" }>;
	const shaOf = new Map(items.map((i) => [i.url, i.sha]));
	for (const t of r.results) await mark(shaOf.get(t.origin)!, { url: t.url });
	for (const f of r.failed) await mark(shaOf.get(f.origin)!, { failed: f.why });
	for (const t of r.results) await saveTranslation(sql, shaOf.get(t.origin)!, t.url).catch(() => {});
}

async function listingNow(sql: Sql, id: string) {
	const [l] = await sql`select * from listings where id = ${id}`;
	if (!l) return null;
	const [row] = await sql`select * from shop_settings where shop = ${l.shop}`;
	const s = settingsOf(row);
	return { l, s, r: productOf(l, s) };
}

const createParams = z.object({
	listingId: z.string(),
	shop: z.string(),
	shopId: z.string(),
	parentSku: z.string(),
	productInfo: z.record(z.string(), z.unknown()),
	hash: z.string(),
	name: z.string().optional(),
});
type CreateP = z.infer<typeof createParams>;

const createOp: WriteOp<CreateP> = {
	describe: "在 Shopee 上建商品（先建成下架）",
	params: createParams,
	target: (p) => `shopee:${p.shopId}:${p.parentSku}`,
	key: (p) => `create:${p.shop}:${p.parentSku}`,
	display: (p) => `建商品 ${p.name ?? `${p.shop}「${String(p.productInfo.name ?? "").slice(0, 24)}」`}`,
	where: (_sql, p, fn) => inAccount("shopee", p.shopId, fn),
	async prepare(sql, p) {
		const now = await listingNow(sql, p.listingId);
		if (!now || now.l.cancelled) return { skip: "商品稿已放弃" };
		if (now.l.product_id) return { skip: `已经建好了（商品 ${now.l.product_id}）` };
		if (now.s.paused) return { skip: `暂停上品：${now.s.paused}` };
		if (!now.r.info) return { skip: `商品稿还缺：${now.r.problems.join("；")}` };
		if (now.r.hash !== p.hash) return { skip: "商品稿刚改过：给人重新看过再 x2 listing publish --ids …" };
		const freight = Number(now.l.pricing?.freightRmb ?? 0);
		for (const v of now.r.product!.variants) {
			const min = minPrice(v.costRmb, freight, v.weightKg!, now.s.params, now.s.preOrder);
			if (min === null || min > v.priceTwd) return { skip: `按现在的店铺设置，规格 ${v.sku} 的售价 NT$${v.priceTwd} 不够（要 ${min ?? "—"}）：重新做商品稿` };
		}
		await productPage();
		return { params: p, before: {} };
	},
	async submit(sql, p) {
		const w = await createListing.submit({ productInfo: p.productInfo });
		if (w.kind === "done")
			await sql`update listings set product_id = ${(w.data as { productId: string }).productId}, updated_at = now() where id = ${p.listingId}`;
		return w;
	},
	async check(p) {
		const sql = await db();
		let [{ product_id: id }] = (await sql`select product_id from listings where id = ${p.listingId}`) as any;
		if (!id) {
			id = await findByParentSku(p.parentSku, String(p.productInfo.name));
			if (!id) return { done: null, readback: { found: false } };
			await sql`update listings set product_id = ${id}, updated_at = now() where id = ${p.listingId}`;
		}
		// 读回对账：读回来和提交的 product_info 逐项比。刚建完读得到要几秒：对不上就隔 3 秒再读，最多 3 次
		let problems: string[] = [];
		for (let i = 0; i < 3; i++) {
			if (i) await sleep(3000);
			const info = await productInfo(id);
			const path = (p.productInfo.category_path as number[]) ?? [];
			problems = readbackProblems(p.productInfo, info, await channels(id, path[path.length - 1]!));
			if (!problems.length) break;
		}
		return { done: problems.length === 0, readback: { productId: id, problems } };
	},
};

const liveParams = z.object({
	listingId: z.string(),
	shop: z.string(),
	shopId: z.string(),
	parentSku: z.string(),
	title: z.string().nullable().optional(),
	name: z.string().optional(),
	productId: z.string().optional(),
});
type LiveP = z.infer<typeof liveParams>;

const liveOp: WriteOp<LiveP> = {
	describe: "把建好的商品上架（下架 → 在售）",
	params: liveParams,
	target: (p) => `shopee:${p.shopId}:${p.parentSku}`,
	key: (p) => `live:${p.shop}:${p.parentSku}`,
	display: (p) => `上架 ${p.name ?? `${p.shop}「${String(p.title ?? p.parentSku).slice(0, 24)}」`}`,
	where: (_sql, p, fn) => inAccount("shopee", p.shopId, fn),
	async prepare(sql, p) {
		const [l] = await sql`select product_id, listed_at, cancelled from listings where id = ${p.listingId}`;
		if (!l || l.cancelled) return { skip: "商品稿已放弃" };
		if (!l.product_id) return { skip: "还没建好（建商品没成功）" };
		if (l.listed_at) return { skip: "已经上架了" };
		return { params: { ...p, productId: String(l.product_id) }, before: {} };
	},
	submit: (_sql, p) => listProduct.submit({ productId: p.productId! }),
	// 读回对账：在售是做了，禁卖是没做。翻在售以后要十几秒才读得到：隔 3 秒读一次，最多 6 次
	async check(p, _before, fresh) {
		let info: any = null;
		for (let i = 0; i < (fresh ? 6 : 1); i++) {
			if (i) await sleep(3000);
			info = await productInfo(p.productId!);
			if (Number(info.status) === 1 && !info.is_unlisted) return { done: true, readback: { status: info.status } };
			if (Number(info.status) === 3) return { done: false, readback: { status: info.status, why: "禁卖" } };
		}
		return { done: null, readback: { status: info?.status ?? null, unlisted: info?.is_unlisted ?? null } };
	},
	async after(sql, p) {
		await sql`update listings set listed_at = now(), updated_at = now() where id = ${p.listingId}`;
	},
};

export const LISTING_WRITES: Record<string, WriteOp> = { 建商品: createOp, 上架: liveOp };
