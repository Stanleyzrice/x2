// 站点的写操作：人在终端里同意了，agent 用 x2 do（加购、预报）、x2 listing publish（建商品、上架）交给 run.ts 执行。读操作在 op.ts，写不进那个通用入口。
// 每个写操作分四步，run.ts 按顺序调：
// 1. prepare：现读，看还该不该做（订单取消了、货源下架了就不做），记下做之前站点上是什么样（before）
// 2. 记意图：run.ts 把写入改成「已提交」再提交（进程这时挂了，下一轮当结果未知，先读回来）
// 3. submit：提交一次，回三态：做了、被拒、结果未知（没拿到答复）
// 4. check：读回来，和 before 比：做了、没做、看不出（看不出就是结果未知，不重发）
import { z } from "zod";
import type { Sql } from "../core/db.ts";
import { db } from "../core/db.ts";
import { NeedsHuman } from "../core/errors.ts";
import { minPrice } from "../domain/listing/price.ts";
import { settingsOf } from "../domain/listing/pricing.ts";
import { readbackProblems } from "../domain/listing/product.ts";
import { productOf } from "../domain/listing/ready.ts";
import { fetchImage } from "../services/image.ts";
import { translate } from "../services/xiangji.ts";
import { addToCart, type CartLine, Gone, cart as readCart, offer as readOffer } from "../sites/1688.ts";
import { buyAccount, in1688, inShop } from "../sites/accounts.ts";
import { orders as chanbossOrders, forecast, NO_TRACKING } from "../sites/chanboss.ts";
import { allProducts, channels, createProduct, productInfo, productPage, setUnlisted } from "../sites/shopee/products.ts";
import { current } from "./check.ts";

export type Submitted =
	| { kind: "done"; data?: unknown }
	| { kind: "refused"; why: string }
	| { kind: "blocked"; why: string }
	| { kind: "unknown"; why: string };
export type Prepared<P> = { skip: string } | { params: P; before: unknown };

export type WriteOp<P = any> = {
	describe: string;
	params: z.ZodType<P>;
	/** 对象：同一个对象上有没核清的写入，先读回来，再准备新的 */
	target: (p: P) => string;
	/** 防重复的 key：同一个 key 已有成功、结果未知的写入，不再提交 */
	key: (p: P) => string;
	/** 给人看的一行 */
	display: (p: P) => string;
	/** 还没在真站点上跑过：第一次要和运营约好一个对象，一起跑 x2 do --try <操作> */
	untried?: string;
	/** 在哪个浏览器里做 */
	where: <T>(sql: Sql, p: P, fn: () => Promise<T>) => Promise<T>;
	prepare: (sql: Sql, p: P) => Promise<Prepared<P>>;
	submit: (sql: Sql, p: P) => Promise<Submitted>;
	/** fresh：刚提交完就读（这时没变化就是没做）；不是 fresh 时（过了一阵再核）没变化也可能是人动过，只认「做了」 */
	check: (p: P, before: any, fresh: boolean) => Promise<{ done: boolean | null; readback: unknown }>;
	/** 做成了以后在库里记的（例 随加购一起定下的货源写进规格） */
	after?: (sql: Sql, p: P) => Promise<void>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inCart = (lines: CartLine[], offerId: string, skuId: string) =>
	lines.filter((c) => c.offerId === offerId && c.skuId === skuId).reduce((n, c) => n + c.quantity, 0);

/** 现读 chanboss 上这几张订单 */
async function liveOrders(sns: string[]): Promise<Map<string, any>> {
	const now = Math.floor(Date.now() / 1000);
	const r = await chanbossOrders(now - 90 * 86400, now, 1, sns, 100);
	return new Map(r.rows.map((o: any) => [String(o.sn), o]));
}

const cartParams = z.object({
	offerId: z.string(),
	skuId: z.string(),
	qty: z.number().int().positive(),
	title: z.string(),
	sku: z.string(),
	price: z.number().nullable(),
	lines: z.array(z.object({ sn: z.string(), modelId: z.string(), qty: z.number().int().positive() })).min(1),
	/** 随这次加购一起定下的新货源（店里的商品 id）：加上了才标成「选用」 */
	newSources: z.array(z.string()).default([]),
	/** 加在哪个 1688 账号（userId）：执行时填采购账号，记下 */
	account: z.string().optional(),
	/** 货源的规格的 specId：执行时现读货源填上 */
	specId: z.string().optional(),
});
type CartP = z.infer<typeof cartParams>;

/** 加购：把货源的一个规格加进购物车（同一个规格的几张订单合成一行）。同一个规格加两次，车里是两倍：结果未知不重发 */
const cart: WriteOp<CartP> = {
	describe: "把货源的一个规格加进购物车",
	params: cartParams,
	target: (p) => `1688:${p.offerId}:${p.skuId}`,
	key: (p) =>
		`cart:${p.lines
			.map((l) => `${l.sn}:${l.modelId}`)
			.sort()
			.join(",")}`,
	display: (p) => `${p.title} / ${p.sku} × ${p.qty}（订单 ${[...new Set(p.lines.map((l) => l.sn))].join("、")}）${p.newSources.length ? "（新货源）" : ""}`,
	// 只往采购账号加购：在登录着它的浏览器里做
	where: async (sql, p, fn) => {
		const a = await buyAccount(sql);
		if (!a) throw new NeedsHuman("订单设置里没填采购账号（1688 会员名）");
		return in1688(p.account ?? a.userId, fn);
	},
	async prepare(sql, p) {
		const account = (await buyAccount(sql))!.userId;
		if (p.account && p.account !== account) return { skip: `只往采购账号加购，这一项写的是另一个账号 ${p.account}` };
		// 现读 1688 的购物车和采购单再对一次：准备和执行之间有人外部采购了、或者已经加进购物车了，就不加（免得买重）。
		// 同一次 x2 do 里 2 分钟内读过的复用（一批几项不用每项重读）；读不全就停
		const covered = (await current(sql)).covered;
		const dup = p.lines.filter((l) => covered.has(`${l.sn}:${l.modelId}`));
		if (dup.length) return { skip: `订单 ${dup.map((l) => l.sn).join("、")} 的货已经买了或者在购物车里了（刚读的采购单、购物车）` };
		const live = await liveOrders([...new Set(p.lines.map((l) => l.sn))]);
		for (const l of p.lines) {
			const o = live.get(l.sn);
			if (!o) return { skip: `chanboss 上读不到订单 ${l.sn}` };
			if (o.platform_status !== "READY_TO_SHIP") return { skip: `订单 ${l.sn} 不是待出货了（${o.platform_status}）` };
			if (o.status !== "paid") return { skip: `订单 ${l.sn} 在 chanboss 上已经不是待处理了（${o.status}）：在别处买过了？` };
		}
		// 现读 1688 商品：下架了、没这个规格了，把这个货源标成不可用（检查当成缺货源，agent 重新找）
		const broken = async (why: string) => {
			await sql`update sources set broken = ${why}, read_at = now() where offer_id = ${p.offerId} and chosen`;
			return { skip: why };
		};
		const offer = await readOffer(p.offerId).catch((e) => {
			if (e instanceof Gone) return null;
			throw e;
		});
		if (!offer) return broken("货源已在 1688 下架");
		const sku = offer.skus.find((s) => s.skuId === p.skuId);
		if (!sku) return broken("1688 上已无这个规格");
		if (sku.stock < p.qty) return { skip: `1688 库存 ${sku.stock}，要 ${p.qty}` };
		if (p.price !== null && sku.price > p.price * 1.1) return { skip: `1688 价格从 ¥${p.price} 涨到 ¥${sku.price}（超过 10%）` };
		await sleep(1500);
		return { params: { ...p, account, specId: sku.specId }, before: { inCart: inCart(await readCart(), p.offerId, p.skuId) } };
	},
	async submit(_sql, p) {
		const r = await addToCart(p.offerId, p.specId ?? "", p.qty);
		return r.kind === "sent" ? { kind: "done" } : r;
	},
	async check(p, before, fresh) {
		const now = inCart(await readCart(), p.offerId, p.skuId);
		const d = now - Number(before?.inCart ?? 0);
		return { done: d >= p.qty ? true : fresh && d === 0 ? false : null, readback: { inCart: now } };
	},
	// 随这次加购一起定下的新货源（店里的商品 id）：那一行标成「选用」（这个商品还没定货源时）
	async after(sql, p) {
		for (const itemId of p.newSources) {
			await sql`update sources set chosen = true, chosen_at = now() where item_id = ${itemId} and offer_id = ${p.offerId}
				and not exists (select 1 from sources c where c.item_id = ${itemId} and c.chosen)`;
		}
	},
};

const forecastParams = z.object({
	sn: z.string(),
	chanbossId: z.string(),
	chanbossTime: z.number(),
	lines: z.array(z.object({ modelId: z.string(), chanbossModelId: z.string(), qty: z.number().int().positive(), trackingNo: z.string().nullable() })).min(1),
});
type ForecastP = z.infer<typeof forecastParams>;

/** 预报：在 chanboss 上报这张订单的货怎么来。寄到我们这里 = 海快 + 无单号；寄到 chanboss = 海快 + 每件的快递单号 */
const forecastOp: WriteOp<ForecastP> = {
	describe: "在 chanboss 上预报一张订单",
	params: forecastParams,
	target: (p) => `chanboss:${p.sn}`,
	key: (p) => `forecast:${p.sn}`,
	display: (p) => `订单 ${p.sn}：${p.lines.every((l) => !l.trackingNo) ? "无单号" : p.lines.map((l) => l.trackingNo).join("、")}`,
	untried: "预报的请求体是照 chanboss 页面的 JS 拼的，还没在真订单上跑过：和运营约好一张单，一起跑 x2 do --try 预报，跑完在 chanboss 上看一眼",
	where: (_sql, _p, fn) => fn(),
	async prepare(_sql, p) {
		const o = (await liveOrders([p.sn])).get(p.sn);
		if (!o) return { skip: `chanboss 上读不到订单 ${p.sn}` };
		if (o.platform_status !== "READY_TO_SHIP") return { skip: `订单不是待出货了（${o.platform_status}）` };
		if (o.status !== "paid") return { skip: `chanboss 上已经是 ${o.status} 了：预报过了？` };
		return { params: p, before: { status: o.status } };
	},
	async submit(sql, p) {
		// 线路、仓库在订单设置里
		const [s] = await sql`select sendway_id, line_id, warehouse_id from order_settings where id = 1`;
		return forecast({
			orderId: p.chanbossId,
			orderTime: p.chanbossTime,
			sendwayId: Number(s!.sendway_id),
			lineId: Number(s!.line_id),
			warehouseId: Number(s!.warehouse_id),
			lines: p.lines.map((l) => ({ platformModelId: l.modelId, modelId: l.chanbossModelId, count: l.qty, trackNum: l.trackingNo ?? NO_TRACKING })),
		});
	},
	async check(p, _before, fresh) {
		const o = (await liveOrders([p.sn])).get(p.sn);
		const done = o && o.status !== "paid" && o.status !== "other" ? true : fresh && o?.status === "paid" ? false : null;
		return { done, readback: { status: o?.status ?? null, sendway: o?.sendway_name ?? null } };
	},
};

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

/** 译图：交象寄把图上的简体字译成繁体（docs/listing.md「图」）。交一次收一次钱：先记意图再交；象寄说译不成的记在原图上（那张图不用了）；
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

// ── 上品：建商品、上架（docs/listing.md「建商品、上架」） ──

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
		if (now.r.hash !== p.hash) return { skip: "商品稿刚改过：给人重新看过再 x2 listing publish" };
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

export const WRITES: Record<string, WriteOp> = { 加购: cart, 预报: forecastOp, 译图: translateOp, 建商品: createOp, 上架: liveOp };
