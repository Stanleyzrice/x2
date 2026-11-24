// 采购工作区只展示服务端给出的订单事实与写入结果，不在浏览器里拼采购规格。
export type PurchaseMatch = {
	state: "paid" | "unpaid" | "partial" | "refund" | "closed" | "unmatched" | "unknown";
	label: string;
	paidQty: number;
	unpaidQty: number;
	requiredQty: number;
	reason: string | null;
	matches: { orderId: string; qty: number; status: string; paidAt: string | null; url: string }[];
	canPurchase: boolean;
};
export type OrderLine = {
	itemId: string;
	modelId: string;
	name: string;
	spec: string;
	qty: number;
	image: string | null;
	sources: {
		offerId: string;
		url: string;
		title: string;
		chosen: boolean;
		broken: string | null;
		origin: "chosen" | "listing";
	}[];
	purchase?: PurchaseMatch;
};
export type Order = {
	sn: string;
	shop: string;
	createdAt: string | null;
	shipBy: string | null;
	items: string;
	lines: OrderLine[];
	step: string;
	cartPending: boolean;
	cartDone: boolean;
	purchase?: PurchaseMatch;
};
export type Quantities = { qty: number; paidQty: number; unpaidQty: number; buyQty: number; reviewQty: number };
export type SkuDemand = Quantities & {
	key: string;
	name: string;
	spec: string;
	target: { offerId: string; skuId: string } | null;
	orders: (Quantities & { sn: string; shop: string })[];
};
export type Monitor = {
	checkedAt: string | null;
	error: string | null;
	orders: Order[];
	demand?: SkuDemand[];
	purchases?: { selected?: string | null; account: string | null; loginId: string | null; capturedAt: string | null; complete: boolean; error: string | null };
};
export type PurchaseResult = {
	state: string;
	outcome?: { ran: { id: string; display: string; status: string; why?: string }[]; unknown: boolean; blocked: string | null } | null;
};

export function selectedDemand(rows: SkuDemand[], selected: Set<string>): SkuDemand[] {
	if (!selected.size) return rows;
	return rows.flatMap((row) => {
		const orders = row.orders.filter((order) => selected.has(order.sn));
		if (!orders.length) return [];
		const totals: Quantities = { qty: 0, paidQty: 0, unpaidQty: 0, buyQty: 0, reviewQty: 0 };
		for (const order of orders) {
			for (const key of ["qty", "paidQty", "unpaidQty", "buyQty", "reviewQty"] as const) totals[key] += order[key];
		}
		return [{ ...row, ...totals, orders }];
	});
}
