// 通知与采购页共享短时同步请求；缓存命中不重新发布旧同步结果，避免覆盖较新的订单快照。
import { readCache } from "../../read-cache.ts";
import type { Monitor } from "./types.ts";

export function monitorSync(
	load: (item: string, shops: string[]) => Promise<Monitor>,
	publish: (item: string, shops: string[], value: Monitor) => void,
	epoch: (item: string) => number = () => 0,
	ttl = 45_000,
) {
	const reads = readCache<Monitor>(ttl, 20);
	return (item: string, shops: string[], force = false) =>
		reads.read(
			JSON.stringify([item, [...new Set(shops)].sort()]),
			async () => {
				const version = epoch(item);
				const value = await load(item, shops);
				if (epoch(item) === version) publish(item, shops, value);
				return value;
			},
			force,
		);
}

export function preserveMonitor(previous: Monitor | null, current: Monitor): Monitor {
	if (previous?.purchases && current.purchases && previous.purchases.account !== current.purchases.account) return current;
	return current.error && previous ? { ...current, orders: previous.orders, checkedAt: previous.checkedAt ?? current.checkedAt } : current;
}
