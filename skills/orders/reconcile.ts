// 采购单分给订单：付完款，按货源的规格把采购单里的件数分回加购（加购的写入记着每次为哪张订单的哪个规格加了几件），得出每一行：
// 付了没、收货地址、快递单号、签收了没。每轮现算，不记账。要分是因为 1688 的采购单不记为哪张订单买：同一个货源一起付款，几张订单的货在一张采购单里；
// 一张订单的几样从几家买，又分在几张采购单里。
// 1. 经 x2 加购的：同一个货源的规格，采购单的件数按加购的先后分给订单（先加的先分）；分不到的再看购物车里还有没有；都没有是「不见了」（人从购物车删了，或在别处买了）
// 2. 不是经 x2 加购的（外部采购，或者 x2 加了购、人另外又买了一份）：剩下没分出去的采购单，按货源的规格分给还没付款的订单行（先下单的先分），
//    够数的算「已付款」，标成外部采购。只有一个采购账号时，这个账号买的每一件都看得到，所以能这样推断

export type CartWrite = { id: string; account: string; offerId: string; skuId: string; at: Date; lines: { sn: string; modelId: string; qty: number }[] };
export type Purchase = {
	account: string;
	orderId: string;
	offerId: string;
	offerSkuId: string | null;
	qty: number;
	createdAt: Date | null;
	paidAt?: Date | null;
	/** 这一行的状态：waitsellersend 待发货、waitbuyerreceive 已发货、success 已收货、cancel 交易关闭…… */
	status: string;
	toChanboss: boolean | null;
	trackingNo: string | null;
	signed: boolean;
	refund?: { status: string; label: string; kind: string | null } | null;
};
export type CartLine = { account: string; offerId: string; skuId: string; qty: number };
export type Need = { sn: string; modelId: string; qty: number; offerId: string; skuId: string; createdAt: Date; until?: Date | null };

export type Bought = {
	orderId: string;
	qty: number;
	status: string;
	toChanboss: boolean | null;
	trackingNo: string | null;
	signed: boolean;
	refund: Purchase["refund"];
};
export type Line = {
	sn: string;
	modelId: string;
	qty: number;
	writeId: string;
	account: string;
	offerId: string;
	skuId: string;
	state: "已付款" | "在购物车" | "不见了";
	outside: boolean;
	paidQty: number;
	cartQty: number;
	purchases: Bought[];
};

const closed = (p: Purchase) => /cancel|close|关闭|取消/i.test(p.status) || p.refund?.status === "refundsuccess";
const SKEW_MS = 3600_000;

const keyOf = (account: string, offerId: string, skuId: string) => `${account}|${offerId}|${skuId}`;
type Slot = { p: Purchase; left: number };

export function reconcile(writes: CartWrite[], purchases: Purchase[], cart: CartLine[], needs: Need[] = []): Line[] {
	const pool = new Map<string, Slot[]>();
	for (const p of purchases) {
		if (closed(p) || !p.offerSkuId) continue;
		const k = keyOf(p.account, p.offerId, p.offerSkuId);
		pool.set(k, [...(pool.get(k) ?? []), { p, left: p.qty }]);
	}
	for (const list of pool.values()) list.sort((a, b) => (a.p.createdAt?.getTime() ?? Infinity) - (b.p.createdAt?.getTime() ?? Infinity));
	const inCart = new Map<string, number>();
	for (const c of cart) inCart.set(keyOf(c.account, c.offerId, c.skuId), (inCart.get(keyOf(c.account, c.offerId, c.skuId)) ?? 0) + c.qty);
	const take = (slots: Slot[], wanted: number, after: Date): Bought[] => {
		let need = wanted;
		const used: Bought[] = [];
		for (const slot of slots) {
			if (need === 0) break;
			if (slot.left === 0 || (slot.p.createdAt && slot.p.createdAt.getTime() < after.getTime() - SKEW_MS)) continue;
			const n = Math.min(need, slot.left);
			slot.left -= n;
			need -= n;
			used.push({
				orderId: slot.p.orderId,
				qty: n,
				status: slot.p.status,
				toChanboss: slot.p.toChanboss,
				trackingNo: slot.p.trackingNo,
				signed: slot.p.signed,
				refund: slot.p.refund ?? null,
			});
		}
		return used;
	};

	const out: Line[] = [];
	for (const w of [...writes].sort((a, b) => a.at.getTime() - b.at.getTime() || Number(a.id) - Number(b.id))) {
		const k = keyOf(w.account, w.offerId, w.skuId);
		for (const l of w.lines) {
			const used = take(pool.get(k) ?? [], l.qty, w.at);
			const paidQty = used.reduce((n, u) => n + u.qty, 0);
			const cartQty = Math.min(l.qty - paidQty, inCart.get(k) ?? 0);
			inCart.set(k, (inCart.get(k) ?? 0) - cartQty);
			out.push({
				sn: l.sn,
				modelId: l.modelId,
				qty: l.qty,
				writeId: w.id,
				account: w.account,
				offerId: w.offerId,
				skuId: w.skuId,
				outside: false,
				state: paidQty === l.qty ? "已付款" : paidQty + cartQty === l.qty ? "在购物车" : "不见了",
				paidQty,
				cartQty,
				purchases: used,
			});
		}
	}

	const paid = new Set(out.filter((l) => l.state === "已付款").map((l) => `${l.sn}:${l.modelId}`));
	for (const n of [...needs].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.sn.localeCompare(b.sn))) {
		if (paid.has(`${n.sn}:${n.modelId}`)) continue;
		const slots = [...pool.entries()]
			.filter(([k]) => k.endsWith(`|${n.offerId}|${n.skuId}`))
			.flatMap(([, s]) => s)
			.filter((s) => !n.until || !s.p.createdAt || s.p.createdAt.getTime() <= n.until.getTime());
		const free = slots.filter((s) => !s.p.createdAt || s.p.createdAt.getTime() >= n.createdAt.getTime() - SKEW_MS).reduce((sum, s) => sum + s.left, 0);
		if (free < n.qty) continue;
		const used = take(
			slots.sort((a, b) => (a.p.createdAt?.getTime() ?? Infinity) - (b.p.createdAt?.getTime() ?? Infinity)),
			n.qty,
			n.createdAt,
		);
		const account = slots.find((s) => s.p.orderId === used[0]?.orderId)?.p.account ?? "";
		out.push({
			sn: n.sn,
			modelId: n.modelId,
			qty: n.qty,
			writeId: "",
			account,
			offerId: n.offerId,
			skuId: n.skuId,
			outside: true,
			state: "已付款",
			paidQty: n.qty,
			cartQty: 0,
			purchases: used,
		});
	}
	return out;
}
