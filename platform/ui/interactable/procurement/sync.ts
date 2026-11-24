import type { Monitor, Quantities, SkuDemand } from "../../../web/procurement.ts";

export function preserveMonitor(previous: Monitor | null, current: Monitor): Monitor {
	if (!Array.isArray(current?.orders)) throw new Error(current?.error || "采购数据缺少订单列表，请重新读取");
	if (previous?.purchases && current.purchases && previous.purchases.account !== current.purchases.account) return current;
	return current.error && previous
		? { ...current, orders: previous.orders, demand: previous.demand, checkedAt: previous.checkedAt ?? current.checkedAt }
		: current;
}

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
