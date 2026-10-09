// 对采购单：付完款，按 1688 规格把采购单对回加购（加购的写入记着每次为哪张订单的哪个规格加了几件），得出每一行：
// 付了没、寄到哪、快递单号、签收了没。每轮现算，不记账。见 docs/orders.md「对采购单」
// 同一个 1688 规格：采购单的件数按加购的先后分给订单（先加的先分）；分不到的再看购物车里还有没有；都没有是「不见了」（人从购物车删了，或在别处买了）

export type CartWrite = { id: string; account: string; offerId: string; skuId: string; at: Date; lines: { sn: string; modelId: string; qty: number }[] };
export type Purchase = {
	account: string; orderId: string; offerId: string; offerSkuId: string | null; qty: number; createdAt: Date | null; status: string;
	toChanboss: boolean | null; trackingNo: string | null; signed: boolean;
};
export type CartLine = { account: string; offerId: string; skuId: string; qty: number };

export type Line = {
	sn: string; modelId: string; qty: number; writeId: string; account: string; offerId: string; skuId: string;
	/** 已付款：件数都在采购单里；在购物车：还没付完，差的购物车里有；不见了：采购单、购物车里都没有 */
	state: "已付款" | "在购物车" | "不见了";
	paidQty: number; cartQty: number;
	purchases: { orderId: string; qty: number; toChanboss: boolean | null; trackingNo: string | null; signed: boolean }[];
};

/** 采购单关了、取消了的不算（1688 的状态还没有真数据核对过：按字面认） */
const closed = (p: Purchase) => /cancel|close|关闭|取消/i.test(p.status);
/** 加购和下单之间允许的时钟误差 */
const SKEW_MS = 3600_000;

const keyOf = (account: string, offerId: string, skuId: string) => `${account}|${offerId}|${skuId}`;

export function reconcile(writes: CartWrite[], purchases: Purchase[], cart: CartLine[]): Line[] {
	const pool = new Map<string, { p: Purchase; left: number }[]>();
	for (const p of purchases) {
		if (closed(p) || !p.offerSkuId) continue;
		const k = keyOf(p.account, p.offerId, p.offerSkuId);
		pool.set(k, [...(pool.get(k) ?? []), { p, left: p.qty }]);
	}
	for (const list of pool.values()) list.sort((a, b) => (a.p.createdAt?.getTime() ?? Infinity) - (b.p.createdAt?.getTime() ?? Infinity));
	const inCart = new Map<string, number>();
	for (const c of cart) inCart.set(keyOf(c.account, c.offerId, c.skuId), (inCart.get(keyOf(c.account, c.offerId, c.skuId)) ?? 0) + c.qty);

	const out: Line[] = [];
	for (const w of [...writes].sort((a, b) => a.at.getTime() - b.at.getTime() || Number(a.id) - Number(b.id))) {
		const k = keyOf(w.account, w.offerId, w.skuId);
		for (const l of w.lines) {
			let need = l.qty;
			const used: Line["purchases"] = [];
			for (const slot of pool.get(k) ?? []) {
				if (need === 0) break;
				if (slot.left === 0 || (slot.p.createdAt && slot.p.createdAt.getTime() < w.at.getTime() - SKEW_MS)) continue;
				const take = Math.min(need, slot.left);
				slot.left -= take;
				need -= take;
				used.push({ orderId: slot.p.orderId, qty: take, toChanboss: slot.p.toChanboss, trackingNo: slot.p.trackingNo, signed: slot.p.signed });
			}
			const paidQty = l.qty - need;
			const cartQty = Math.min(need, inCart.get(k) ?? 0);
			inCart.set(k, (inCart.get(k) ?? 0) - cartQty);
			need -= cartQty;
			out.push({
				sn: l.sn, modelId: l.modelId, qty: l.qty, writeId: w.id, account: w.account, offerId: w.offerId, skuId: w.skuId,
				state: paidQty === l.qty ? "已付款" : need === 0 ? "在购物车" : "不见了", paidQty, cartQty, purchases: used,
			});
		}
	}
	return out;
}
