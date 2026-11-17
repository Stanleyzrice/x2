export const errorOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function saved(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function remember(key: string, value: string | null): void {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// 可选的本地记忆失败不阻止当前操作；业务结果仍以服务端为准。
	}
}
