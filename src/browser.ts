// 唯一碰 cdp-relay 的地方：在运营登录着的 Chrome 里，用 x2 自己开的标签页做事，不碰她正在用的标签页。
// 一个站点（origin）一个标签页，标签页的 window.name 是记号，下次按记号找回来。页面自己带着登录态（cookie），所以请求在页面里发。
// 连着几个浏览器时用 X2_BROWSER（浏览器在 cdp-relay 扩展里的名字或 id）选一个；只连着一个时不用设。
import { RelayClient, type TabInfo } from "@wuwe1/cdp-relay";

const MARK = "x2";

export type Page = {
	/** 在页面里调用一个函数：fn 要自给自足（不引用外面的变量），参数经 JSON 传进去 */
	run<A extends readonly unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<Awaited<R>>;
	/** 导航到一个地址，等到页面加载完 */
	goto(url: string): Promise<void>;
};

async function client(): Promise<RelayClient> {
	const browser = process.env.X2_BROWSER;
	const c = new RelayClient(browser ? { browser } : {});
	const all = await c.browsers().catch(() => { throw new Error("连不上 cdp-relay：Chrome 开着吗？扩展连上了吗？"); });
	if (all.length === 0) throw new Error("没有连上的浏览器：打开 Chrome，确认 cdp-relay 扩展已连接");
	if (all.length > 1 && !browser) throw new Error(`连着 ${all.length} 个浏览器，用 X2_BROWSER 选一个：${all.map((b) => b.label || b.id).join("、")}`);
	return c;
}

/** 这个 origin 的 x2 标签页：有就用，没有就在后台开一个（不抢前台） */
export async function page(origin: string): Promise<Page> {
	const c = await client();
	const tabs = (await c.tabs()).filter((t) => t.url.startsWith(origin));
	let tab: TabInfo | undefined;
	for (const t of tabs) {
		await c.attach(t.tabId);
		if ((await c.eval<string>(t.tabId, "window.name")) === MARK) { tab = t; break; }
	}
	if (!tab) {
		tab = await c.openTab(origin);
		await c.attach(tab.tabId);
		await waitLoaded(c, tab.tabId);
		await c.eval(tab.tabId, `window.name = ${JSON.stringify(MARK)}`);
	}
	const id = tab.tabId;
	// 后台标签页当成有焦点：不然有的页面不启动（2026-09-30：聊聊在后台标签页里不登录、不发请求）
	await c.send(id, "Emulation.setFocusEmulationEnabled", { enabled: true });
	return {
		run: (fn, ...args) => c.evalFn(id, fn, ...args),
		goto: async (url) => {
			await c.navigate(id, url);
			await waitLoaded(c, id);
			await c.eval(id, `window.name = ${JSON.stringify(MARK)}`);
		},
	};
}

async function waitLoaded(c: RelayClient, tabId: number, timeoutMs = 30_000): Promise<void> {
	const until = Date.now() + timeoutMs;
	for (;;) {
		const state = await c.eval<string>(tabId, "document.readyState").catch(() => "loading");
		if (state === "complete") return;
		if (Date.now() > until) throw new Error(`页面 ${timeoutMs / 1000} 秒还没加载完`);
		await new Promise((r) => setTimeout(r, 300));
	}
}
