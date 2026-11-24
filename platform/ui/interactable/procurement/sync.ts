// 通知与采购页共享同步请求；安全验证期间自动保留快照，只有人明确重试才重新读取，缓存命中不重复发布。
import { readCache } from "../../read-cache.ts";
import type { Monitor } from "./types.ts";

export function monitorSync(
	load: (item: string, shops: string[], force: boolean) => Promise<Monitor>,
	publish: (item: string, shops: string[], value: Monitor) => void,
	epoch: (item: string) => number = () => 0,
	current: (item: string, shops: string[]) => Monitor | null = () => null,
	ttl = 45_000,
) {
	const reads = readCache<Monitor>(ttl, 20);
	const active = new Map<string, Promise<Monitor>>();
	return async (item: string, shops: string[], force = false) => {
		const key = JSON.stringify([item, [...new Set(shops)].sort()]);
		const saved = current(item, shops) ?? reads.peek(key);
		if (!force && saved && /滑块|安全验证/.test(saved.error ?? "")) return Promise.resolve(saved);
		if (force && active.has(key)) await active.get(key)?.catch(() => {});
		const result = reads.read(
			key,
			async () => {
				const version = epoch(item);
				const value = await load(item, shops, force);
				if (epoch(item) === version) publish(item, shops, value);
				return value;
			},
			force,
		);
		if (!force) active.set(key, result);
		try {
			return await result;
		} finally {
			if (active.get(key) === result) active.delete(key);
		}
	};
}

export function preserveMonitor(previous: Monitor | null, current: Monitor): Monitor {
	if (!Array.isArray(current?.orders)) throw new Error(current?.error || "采购数据缺少订单列表，请重新读取");
	if (previous?.purchases && current.purchases && previous.purchases.account !== current.purchases.account) return current;
	return current.error && previous
		? { ...current, orders: previous.orders, demand: previous.demand, checkedAt: previous.checkedAt ?? current.checkedAt }
		: current;
}
