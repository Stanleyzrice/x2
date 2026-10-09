// 站点的写操作：只由 x2 run 执行批准过的写入（x2 propose 写成待批准，人在收件箱批准）。读操作在 op.ts，写不进那个通用入口。
// 每个写操作分四步，x2 run 按顺序调：
// 1. prepare：现读，看还该不该做（订单取消了、货源下架了就不做），记下做之前站点上是什么样（before）
// 2. 记意图：x2 run 把写入改成「已提交」再提交（进程这时挂了，下一轮当结果未知，先读回来）
// 3. submit：提交一次，回三态：做了、被拒、结果未知（没拿到答复）
// 4. check：读回来，和 before 比：做了、没做、看不出（看不出就是结果未知，不重发）
import { z } from "zod";
import { in1688 } from "../accounts.ts";
import type { Sql } from "../db/index.ts";
import { fetchOffer } from "../sync/1688.ts";
import { account as alibabaAccount, addToCart, cart as readCart, type CartLine } from "./1688.ts";
import { forecast, NO_TRACKING, orders as chanbossOrders } from "./chanboss.ts";

export type Submitted = { kind: "done"; data?: unknown } | { kind: "refused"; why: string } | { kind: "blocked"; why: string } | { kind: "unknown"; why: string };
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
	/** 还没在真站点上跑过：第一次要和运营约好一个对象，一起跑 x2 run --try <操作> */
	untried?: string;
	/** 在哪个浏览器里做 */
	where: <T>(p: P, fn: () => Promise<T>) => Promise<T>;
	prepare: (sql: Sql, p: P) => Promise<Prepared<P>>;
	submit: (sql: Sql, p: P) => Promise<Submitted>;
	/** fresh：刚提交完就读（这时没变化就是没做）；不是 fresh 时（过了一阵再核）没变化也可能是人动过，只认「做了」 */
	check: (p: P, before: any, fresh: boolean) => Promise<{ done: boolean | null; readback: unknown }>;
	/** 做成了以后在库里记的（例 随加购一起批准的货源写进规格） */
	after?: (sql: Sql, p: P) => Promise<void>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inCart = (lines: CartLine[], offerId: string, skuId: string) => lines.filter((c) => c.offerId === offerId && c.skuId === skuId).reduce((n, c) => n + c.quantity, 0);

/** 现读 chanboss 上这几张订单 */
async function liveOrders(sns: string[]): Promise<Map<string, any>> {
	const now = Math.floor(Date.now() / 1000);
	const r = await chanbossOrders(now - 90 * 86400, now, 1, sns, 100);
	return new Map(r.rows.map((o: any) => [String(o.sn), o]));
}

const cartParams = z.object({
	offerId: z.string(), skuId: z.string(), qty: z.number().int().positive(), title: z.string(), sku: z.string(), price: z.number().nullable(),
	lines: z.array(z.object({ sn: z.string(), modelId: z.string(), qty: z.number().int().positive() })).min(1),
	/** 随这次加购一起批准的新货源（规格 id）：加上了才写进规格 */
	newSources: z.array(z.string()).default([]),
	/** 加在哪个 1688 账号（userId）：不给就用登录着的那个，执行时记下 */
	account: z.string().optional(),
	/** 1688 规格的 specId：执行时现读货源填上 */
	specId: z.string().optional(),
});
type CartP = z.infer<typeof cartParams>;

/** 加购：把一个 1688 规格加进购物车（同一个规格的几张订单合成一行）。同一个规格加两次，车里是两倍：结果未知不重发 */
const cart: WriteOp<CartP> = {
	describe: "把一个 1688 规格加进购物车",
	params: cartParams,
	target: (p) => `1688:${p.offerId}:${p.skuId}`,
	key: (p) => `cart:${p.lines.map((l) => `${l.sn}:${l.modelId}`).sort().join(",")}`,
	display: (p) => `${p.title} / ${p.sku} × ${p.qty}（订单 ${[...new Set(p.lines.map((l) => l.sn))].join("、")}）${p.newSources.length ? "（新货源）" : ""}`,
	where: (p, fn) => (p.account ? in1688(p.account, fn) : fn()),
	async prepare(sql, p) {
		const account = p.account ?? (await alibabaAccount()).userId;
		const live = await liveOrders([...new Set(p.lines.map((l) => l.sn))]);
		for (const l of p.lines) {
			const o = live.get(l.sn);
			if (!o) return { skip: `chanboss 上读不到订单 ${l.sn}` };
			if (o.platform_status !== "READY_TO_SHIP") return { skip: `订单 ${l.sn} 不是待出货了（${o.platform_status}）` };
			if (o.status !== "paid") return { skip: `订单 ${l.sn} 在 chanboss 上已经不是待处理了（${o.status}）：在别处买过了？` };
		}
		const offer = await fetchOffer(sql, p.offerId);
		if (!offer) return { skip: "货源在 1688 上下架了" };
		const sku = offer.skus.find((s) => s.skuId === p.skuId);
		if (!sku) return { skip: "1688 上没有这个规格了" };
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
	async after(sql, p) {
		for (const modelId of p.newSources) {
			await sql`update skus set offer_id = ${p.offerId}, offer_sku_id = ${p.skuId}, sourced_at = now() where model_id = ${modelId} and offer_id is null`;
		}
	},
};

const forecastParams = z.object({
	sn: z.string(), chanbossId: z.string(), chanbossTime: z.number(),
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
	untried: "预报的请求体是照 chanboss 页面的 JS 拼的，还没在真订单上跑过：和运营约好一张单，一起跑 x2 run --try 预报，跑完在 chanboss 上看一眼",
	where: (_p, fn) => fn(),
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
			orderId: p.chanbossId, orderTime: p.chanbossTime, sendwayId: Number(s!.sendway_id), lineId: Number(s!.line_id), warehouseId: Number(s!.warehouse_id),
			lines: p.lines.map((l) => ({ platformModelId: l.modelId, modelId: l.chanbossModelId, count: l.qty, trackNum: l.trackingNo ?? NO_TRACKING })),
		});
	},
	async check(p, _before, fresh) {
		const o = (await liveOrders([p.sn])).get(p.sn);
		const done = o && o.status !== "paid" && o.status !== "other" ? true : fresh && o?.status === "paid" ? false : null;
		return { done, readback: { status: o?.status ?? null, sendway: o?.sendway_name ?? null } };
	},
};

export const WRITES: Record<string, WriteOp> = { 加购: cart, 预报: forecastOp };
