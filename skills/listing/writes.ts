// 上品的写操作：译图（象寄）、建商品、上架（Shopee）。写入引擎（platform/writes.ts）按 prepare → 记意图 → submit → check 调；
// prepare 是业务上的保护：建商品前照商品稿现组一遍，和人同意时交给 x2 的一样才建
import { z } from "zod";
import { fetchImage } from "../../connectors/services/image/api.ts";
import { translate } from "../../connectors/services/xiangji/api.ts";
import { allProducts, channels, createProduct, productInfo, productPage, setUnlisted } from "../../connectors/sites/shopee/products.ts";
import { inShop } from "../../platform/browser/accounts.ts";
import { db, type Sql } from "../../platform/db/index.ts";
import type { WriteOp } from "../../platform/writes.ts";
import { minPrice } from "./price.ts";
import { settingsOf } from "./pricing.ts";
import { readbackProblems } from "./product.ts";
import { productOf } from "./ready.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const translateParams = z.object({
	items: z
		.array(z.object({ sha: z.string(), url: z.string() }))
		.min(1)
		.max(5),
});
type TranslateP = z.infer<typeof translateParams>;

/** 原图的译图结果记在它那一行的 checks.译图：{ url }（象寄给的地址，付过钱了）或 { failed }（象寄说译不成） */
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

/** 译图：交象寄把图上的简体字译成繁体。交一次收一次钱：先记意图再交；象寄说译不成的记在原图上（那张图不用了）；
 * 答复里没有的、没拿到答复的是结果未知，不重交。做商品稿时马上执行（一张约 0.025 元） */
const translateOp: WriteOp<TranslateP> = {
	describe: "交象寄把图上的简体字译成繁体（收费）",
	params: translateParams,
	target: (p) => `xiangji:${p.items.map((i) => i.sha.slice(0, 12)).join(",")}`,
	key: (p) =>
		`xiangji:${p.items
			.map((i) => i.sha)
			.sort()
			.join(",")}`,
	display: (p) => `译图 ${p.items.length} 张`,
	where: (_sql, _p, fn) => fn(),
	async prepare(sql, p) {
		const state = await translationState(
			sql,
			p.items.map((i) => i.sha),
		);
		const items = p.items.filter((i) => !state.has(i.sha));
		return items.length ? { params: { items }, before: {} } : { skip: "这几张都译过了" };
	},
	async submit(sql, p) {
		const r = await translate(p.items.map((i) => i.url));
		if (r.kind !== "done") return r;
		const shaOf = new Map(p.items.map((i) => [i.url, i.sha]));
		const at = new Date().toISOString();
		for (const t of r.results) await sql`update images set checks = checks || ${sql.json({ 译图: { url: t.url, at } })} where sha256 = ${shaOf.get(t.origin)!}`;
		for (const f of r.failed)
			await sql`update images set checks = checks || ${sql.json({ 译图: { failed: f.why, at } })} where sha256 = ${shaOf.get(f.origin)!}`;
		// 记下了地址再取图：取不回来下次照地址再取，不用再付钱
		for (const t of r.results) await saveTranslation(sql, shaOf.get(t.origin)!, t.url).catch(() => {});
		if (r.missing.length) return { kind: "unknown", why: `象寄的答复里没有 ${r.missing.length} 张（不知道扣没扣钱）` };
		return { kind: "done", data: { translated: r.results.length, failed: r.failed } };
	},
	async check(p) {
		const state = await translationState(
			await db(),
			p.items.map((i) => i.sha),
		);
		const done = p.items.every((i) => state.get(i.sha)?.url || state.get(i.sha)?.failed || state.get(i.sha)?.saved);
		return { done: done ? true : null, readback: Object.fromEntries(state) };
	},
};

// ── 上品：建商品、上架 ──

/** 现在的商品稿：库里的一行、店铺设置、现组的 product_info */
async function listingNow(sql: Sql, id: string) {
	const [l] = await sql`select * from listings where id = ${id}`;
	if (!l) return null;
	const [row] = await sql`select * from shop_settings where shop = ${l.shop}`;
	const s = settingsOf(row);
	return { l, s, r: productOf(l, s) };
}

/** 建商品结果未知时按货号找：新建的是下架，在售列表里没有，翻全部商品；名字一样的再读详情核对货号 */
async function findBySku(parentSku: string, name: string): Promise<string | null> {
	for (let page = 1; page <= 20; page++) {
		const r = await allProducts(page);
		for (const p of r.rows.filter((x) => x.name === name)) if ((await productInfo(p.productId)).parent_sku === parentSku) return p.productId;
		if (page * 48 >= r.total || r.rows.length === 0) break;
	}
	return null;
}

// name：商品稿的叫法「简称（店铺）」，只给人看（x2 status、写入的输出）
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

/** 建商品：在这家店的卖家中心页面里发 create_product_info，先建成下架，读回来逐项核对。
 * 人同意以后商品稿又改过（现组的 product_info 和交给 x2 的不一样）就不建；用现在的店铺设置再核一次价 */
const createOp: WriteOp<CreateP> = {
	describe: "在 Shopee 上建商品（先建成下架）",
	params: createParams,
	target: (p) => `shopee:${p.shopId}:${p.parentSku}`,
	key: (p) => `create:${p.shop}:${p.parentSku}`,
	display: (p) => `建商品 ${p.name ?? `${p.shop}「${String(p.productInfo.name ?? "").slice(0, 24)}」`}`,
	where: (_sql, p, fn) => inShop(p.shopId, fn),
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
		const w = await createProduct(p.productInfo);
		if (w.kind === "refused") return { kind: "refused", why: `${w.code ?? ""} ${w.why}`.trim() };
		if (w.kind !== "done") return w;
		const id = String(w.data?.product_id ?? w.data?.id ?? "");
		if (!/^\d+$/.test(id) || id === "0") return { kind: "unknown", why: "Shopee 说建好了，但没回商品 id" };
		await sql`update listings set product_id = ${id}, updated_at = now() where id = ${p.listingId}`;
		return { kind: "done", data: { productId: id } };
	},
	async check(p) {
		const sql = await db();
		let [{ product_id: id }] = (await sql`select product_id from listings where id = ${p.listingId}`) as any;
		if (!id) {
			id = await findBySku(p.parentSku, String(p.productInfo.name));
			if (!id) return { done: null, readback: { found: false } };
			await sql`update listings set product_id = ${id}, updated_at = now() where id = ${p.listingId}`;
		}
		// 刚建完读得到要几秒：对不上就隔 3 秒再读，最多 3 次
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

/** 上架：建好的商品从下架翻成在售（update_product_info 的 unlisted: false），读回来确认在售 */
const liveOp: WriteOp<LiveP> = {
	describe: "把建好的商品上架（下架 → 在售）",
	params: liveParams,
	target: (p) => `shopee:${p.shopId}:${p.parentSku}`,
	key: (p) => `live:${p.shop}:${p.parentSku}`,
	display: (p) => `上架 ${p.name ?? `${p.shop}「${String(p.title ?? p.parentSku).slice(0, 24)}」`}`,
	where: (_sql, p, fn) => inShop(p.shopId, fn),
	async prepare(sql, p) {
		const [l] = await sql`select product_id, listed_at, cancelled from listings where id = ${p.listingId}`;
		if (!l || l.cancelled) return { skip: "商品稿已放弃" };
		if (!l.product_id) return { skip: "还没建好（建商品没成功）" };
		if (l.listed_at) return { skip: "已经上架了" };
		return { params: { ...p, productId: String(l.product_id) }, before: {} };
	},
	async submit(_sql, p) {
		const w = await setUnlisted(p.productId!, false);
		return w.kind === "done" ? { kind: "done" } : w.kind === "refused" ? { kind: "refused", why: `${w.code ?? ""} ${w.why}`.trim() } : w;
	},
	async check(p, _before, fresh) {
		// 翻在售以后要十几秒才读得到：隔 3 秒读一次，最多 6 次
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

/** 上品的写操作（写入表的 op → 声明） */
export const LISTING_WRITES: Record<string, WriteOp> = { 译图: translateOp, 建商品: createOp, 上架: liveOp };
