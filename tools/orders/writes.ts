// 订单的写操作：加购（1688 购物车）、预报（chanboss）。写入引擎（platform/writes.ts）按 prepare → 记意图 → submit → check 调；
// prepare 是业务上的保护：现读还该不该做（订单取消了、货源下架了、已经买了就不做）；提交是连接器的写（1688 的 cart-add、chanboss 的 forecast），读回对账用连接器的读（购物车、订单）
import { z } from "zod";
import { type CartLine, Gone, OfferId, cart as readCart, offer as readOffer, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import { cartAdd } from "../../connectors/sites/1688/index.ts";
import { ChanbossOrderId, ordersBySn as liveOrders, NO_TRACKING, OrderSn } from "../../connectors/sites/chanboss/api.ts";
import { forecastOrder } from "../../connectors/sites/chanboss/index.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import { NeedsHuman } from "../../platform/errors.ts";
import type { WriteOp } from "../../platform/writes.ts";
import { buyAccount } from "./read.ts";
import { current } from "./status.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inCart = (lines: CartLine[], offerId: string, skuId: string) =>
	lines.filter((c) => c.offerId === offerId && c.skuId === skuId).reduce((n, c) => n + c.quantity, 0);

export const cartParams = z.object({
	offerId: OfferId,
	skuId: SkuId,
	qty: z.number().int().positive(),
	title: z.string(),
	sku: z.string(),
	price: z.number().nullable(),
	lines: z.array(z.object({ sn: OrderSn, modelId: z.string(), qty: z.number().int().positive() })).min(1),
	newSources: z.array(z.string()).default([]),
	account: z.string().optional(),
	specId: SpecId.optional(),
});
type CartP = z.infer<typeof cartParams>;

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
	where: async (sql, p, fn) => {
		const a = await buyAccount(sql);
		if (!a) throw new NeedsHuman("订单设置里没填采购账号（1688 会员名）");
		return inAccount("1688", p.account ?? a.userId, fn);
	},
	async prepare(sql, p) {
		const account = (await buyAccount(sql))!.userId;
		if (p.account && p.account !== account) return { skip: `只往采购账号加购，这一项写的是另一个账号 ${p.account}` };
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
	submit: (_sql, p) => cartAdd.submit({ offerId: p.offerId, specId: p.specId ?? SpecId.parse(""), qty: p.qty }),
	async check(p, before, fresh) {
		const now = inCart(await readCart(), p.offerId, p.skuId);
		const d = now - Number(before?.inCart ?? 0);
		return { done: d >= p.qty ? true : fresh && d === 0 ? false : null, readback: { inCart: now } };
	},
	async after(sql, p) {
		for (const itemId of p.newSources) {
			await sql`update sources set chosen = true, chosen_at = now() where item_id = ${itemId} and offer_id = ${p.offerId}
				and not exists (select 1 from sources c where c.item_id = ${itemId} and c.chosen)`;
		}
	},
};

export const forecastParams = z.object({
	sn: OrderSn,
	chanbossId: ChanbossOrderId,
	chanbossTime: z.number(),
	lines: z.array(z.object({ modelId: z.string(), chanbossModelId: z.string(), qty: z.number().int().positive(), trackingNo: z.string().nullable() })).min(1),
});
type ForecastP = z.infer<typeof forecastParams>;

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
	async check(p, _before, fresh) {
		const o = (await liveOrders([p.sn])).get(p.sn);
		const done = o && o.status !== "paid" && o.status !== "other" ? true : fresh && o?.status === "paid" ? false : null;
		return { done, readback: { status: o?.status ?? null, sendway: o?.sendway_name ?? null } };
	},
};

export const ORDER_WRITES: Record<string, WriteOp> = { 加购: cart, 预报: forecastOp };
