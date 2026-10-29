// 订单的写操作：加购（1688 购物车）、预报（chanboss）。写入引擎（platform/writes.ts）按 prepare → 记意图 → submit → check 调；
// prepare 是业务上的保护：现读还该不该做（订单取消了、货源下架了、已经买了就不做）；提交和读回来核对是连接器的写工具（1688 的 cart-add、chanboss 的 forecast）
import { z } from "zod";
import { Gone, offer as readOffer } from "../../connectors/sites/1688/api.ts";
import { cartAdd } from "../../connectors/sites/1688/index.ts";
import { ordersBySn as liveOrders, NO_TRACKING } from "../../connectors/sites/chanboss/api.ts";
import { forecastOrder } from "../../connectors/sites/chanboss/index.ts";
import { inAccount } from "../../platform/browser/accounts.ts";
import { NeedsHuman } from "../../platform/errors.ts";
import type { WriteOp } from "../../platform/writes.ts";
import { buyAccount } from "./read.ts";
import { current } from "./status.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 1688 加购工具的参数 */
const cartAddOf = (p: CartP) => ({ offerId: p.offerId, skuId: p.skuId, specId: p.specId ?? "", qty: p.qty });

export const cartParams = z.object({
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
	link: "https://cart.1688.com/cart.htm",
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
		return inAccount("1688", p.account ?? a.userId, fn);
	},
	async prepare(sql, p) {
		const account = (await buyAccount(sql))!.userId;
		if (p.account && p.account !== account) return { skip: `只往采购账号加购，这一项写的是另一个账号 ${p.account}` };
		// 现读 1688 的购物车和采购单再对一次：准备和执行之间有人外部采购了、或者已经加进购物车了，就不加（免得买重）。
		// 同一次加购里 2 分钟内读过的复用（一批几项不用每项重读）；读不全就停
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
		const params = { ...p, account, specId: sku.specId };
		return { params, before: await cartAdd.before!(cartAddOf(params)) };
	},
	submit: (_sql, p) => cartAdd.submit(cartAddOf(p)),
	check: (p, before, fresh) => cartAdd.check!(cartAddOf(p), before, fresh),
	// 随这次加购一起定下的新货源（店里的商品 id）：那一行标成「选用」（这个商品还没定货源时）
	async after(sql, p) {
		for (const itemId of p.newSources) {
			await sql`update sources set chosen = true, chosen_at = now() where item_id = ${itemId} and offer_id = ${p.offerId}
				and not exists (select 1 from sources c where c.item_id = ${itemId} and c.chosen)`;
		}
	},
};

export const forecastParams = z.object({
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
	untried: "预报的请求体是照 chanboss 页面的 JS 拼的，还没在真订单上跑过：和运营约好一张单，一起跑 x2 orders forecast --try，跑完在 chanboss 上看一眼",
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
		return forecastOrder.submit({
			sn: p.sn,
			orderId: p.chanbossId,
			orderTime: p.chanbossTime,
			sendwayId: Number(s!.sendway_id),
			lineId: Number(s!.line_id),
			warehouseId: Number(s!.warehouse_id),
			lines: p.lines.map((l) => ({ platformModelId: l.modelId, modelId: l.chanbossModelId, count: l.qty, trackNum: l.trackingNo ?? NO_TRACKING })),
		});
	},
	check: (p, before, fresh) => forecastOrder.check!({ sn: p.sn }, before, fresh),
};

/** 订单的写操作（写入表的 op → 声明） */
export const ORDER_WRITES: Record<string, WriteOp> = { 加购: cart, 预报: forecastOp };
