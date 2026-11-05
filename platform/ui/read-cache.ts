// 浏览器会话内的只读缓存：合并并发请求、限制容量，失效后不让旧请求覆盖新值；不持久化商品或买家数据。
export function readCache<T>(ttl = 30_000, limit = 80, now = Date.now) {
	type Entry = { value?: T; at: number; pending?: Promise<T> };
	const entries = new Map<string, Entry>();
	const put = (key: string, entry: Entry) => {
		entries.delete(key);
		entries.set(key, entry);
		while (entries.size > limit) entries.delete(entries.keys().next().value!);
	};
	return {
		peek(key: string): T | null {
			return entries.get(key)?.value ?? null;
		},
		async read(key: string, load: () => Promise<T>, force = false): Promise<T> {
			const previous = entries.get(key);
			if (previous?.pending) return previous.pending;
			if (!force && previous?.value !== undefined && now() - previous.at < ttl) return previous.value;
			const entry: Entry = { value: previous?.value, at: previous?.at ?? 0 };
			put(key, entry);
			entry.pending = Promise.resolve()
				.then(load)
				.then(
					(value) => {
						if (entries.get(key) === entry) put(key, { value, at: now() });
						return value;
					},
					(error: unknown) => {
						if (entries.get(key) === entry) {
							if (entry.value !== undefined) put(key, { value: entry.value, at: entry.at });
							else entries.delete(key);
						}
						throw error;
					},
				);
			return entry.pending;
		},
		invalidate(prefix: string) {
			for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
		},
	};
}
