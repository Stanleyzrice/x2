import type { Monitor } from "./types.ts";

export function preserveMonitor(previous: Monitor | null, current: Monitor): Monitor {
	if (!Array.isArray(current?.orders)) throw new Error(current?.error || "采购数据缺少订单列表，请重新读取");
	if (previous?.purchases && current.purchases && previous.purchases.account !== current.purchases.account) return current;
	return current.error && previous
		? { ...current, orders: previous.orders, demand: previous.demand, checkedAt: previous.checkedAt ?? current.checkedAt }
		: current;
}
