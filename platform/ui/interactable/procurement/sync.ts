// 通知与采购页共享同步请求；安全验证期间自动保留快照，只有人明确重试才重新读取，缓存命中不重复发布。
import { readCache } from "../../read-cache.ts";
import type { Monitor } from "./types.ts";

export function monitorSync(
	load: (item: string, shops: string[]) => Promise<Monitor>,
	publish: (item: string, shops: string[], value: Monitor) => void,
	epoch: (item: string) => number = () => 0,
	current: (item: string, shops: string[]) => Monitor | null = () => null,
	ttl = 45_000,
) {
	const reads = readCache<Monitor>(ttl, 20);
	return (item: string, shops: string[], force = false) => {
		const key = JSON.stringify([item, [...new Set(shops)].sort()]);
		const saved = current(item, shops) ?? reads.peek(key);
		if (!force && saved && [saved.error, saved.purchases?.error].some((message) => /滑块|安全验证/.test(message ?? ""))) return Promise.resolve(saved);
		return reads.read(
			key,
			async () => {
				const version = epoch(item);
				const value = await load(item, shops);
				if (epoch(item) === version) publish(item, shops, value);
				return value;
			},
			force,
		);
	};
}

export function preserveMonitor(previous: Monitor | null, current: Monitor): Monitor {
	if (previous?.purchases && current.purchases && previous.purchases.account !== current.purchases.account) return current;
	return current.error && previous ? { ...current, orders: previous.orders, checkedAt: previous.checkedAt ?? current.checkedAt } : current;
}
