// 每代连接共享一次初始化；失败和关闭只处理所属代，不自动重试调用方的操作。
type Generation<T> = { value: T; ready: Promise<T> | null; disposing: Promise<void> | null };

export function databaseLifecycle<T>(options: { create: () => T; initialize: (value: T) => Promise<void>; dispose: (value: T) => Promise<void> }) {
	let current: Generation<T> | null = null;
	const dispose = (generation: Generation<T>) => (generation.disposing ??= Promise.resolve().then(() => options.dispose(generation.value)));

	return {
		active: () => current !== null,
		get(): Promise<T> {
			if (current) return current.ready!;
			const generation: Generation<T> = { value: options.create(), ready: null, disposing: null };
			current = generation;
			generation.ready = Promise.resolve()
				.then(() => options.initialize(generation.value))
				.then(() => generation.value)
				.catch(async (error: unknown) => {
					if (current === generation) current = null;
					// 清理失败不覆盖原初始化错误；另一个调用可以建立新代。
					await dispose(generation).catch(() => {});
					throw error;
				});
			return generation.ready;
		},
		async close(): Promise<void> {
			const generation = current;
			current = null;
			if (generation) await dispose(generation);
		},
	};
}
