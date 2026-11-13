// 只保留由服务端创建或确认过的标签；验证按钮只能聚焦该浏览器、该站点最后一次确切受阻的 owned 页。
export type VerificationDriver = {
	tabs: (browser: string) => Promise<{ tabId: number; url: string }[]>;
	focus: (browser: string, tabId: number) => Promise<void>;
};

export function createVerificationRegistry(options: { now?: () => number; maxAgeMs?: number } = {}) {
	const now = options.now ?? Date.now;
	const maxAgeMs = options.maxAgeMs ?? 30 * 60_000;
	const owned = new Map<string, Set<number>>();
	const blocked = new Map<string, { tabId: number; at: number }>();
	const keyOf = (site: string, browser: string) => JSON.stringify([site, browser]);
	const context = (site: string, browser: string) => {
		const key = keyOf(site, browser);
		const value = blocked.get(key);
		if (!value || now() - value.at >= maxAgeMs || !owned.get(key)?.has(value.tabId)) {
			blocked.delete(key);
			return undefined;
		}
		return value;
	};
	const currentTab = async (site: string, browser: string, matchesUrl: (url: string) => boolean, driver: Pick<VerificationDriver, "tabs">) => {
		const value = context(site, browser);
		if (!value) return undefined;
		const tab = (await driver.tabs(browser)).find((t) => t.tabId === value.tabId);
		try {
			if (tab && matchesUrl(tab.url)) return tab.tabId;
		} catch {}
		const key = keyOf(site, browser);
		blocked.delete(key);
		owned.get(key)?.delete(value.tabId);
		return undefined;
	};
	return {
		own(site: string, browser: string, tabId: number): void {
			const key = keyOf(site, browser);
			const tabs = owned.get(key) ?? new Set<number>();
			tabs.add(tabId);
			owned.set(key, tabs);
		},
		challenge(site: string, browser: string, tabId: number): void {
			const key = keyOf(site, browser);
			if (owned.get(key)?.has(tabId)) blocked.set(key, { tabId, at: now() });
		},
		async canOpen(site: string, browser: string, matchesUrl: (url: string) => boolean, driver: Pick<VerificationDriver, "tabs">): Promise<boolean> {
			try {
				return (await currentTab(site, browser, matchesUrl, driver)) !== undefined;
			} catch {
				return false;
			}
		},
		async focus(site: string, browser: string, matchesUrl: (url: string) => boolean, driver: VerificationDriver): Promise<void> {
			const tabId = await currentTab(site, browser, matchesUrl, driver);
			if (tabId === undefined) throw new Error("原 X2 验证页已关闭、过期或无法准确定位，请重新检测；不会选择其他页面");
			await driver.focus(browser, tabId);
		},
	};
}
