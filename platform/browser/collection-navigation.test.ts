// 采集跨标签与页面导航回归：模拟中继，只操作测试会话，不连接浏览器或读取构建产物。
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { RelayClient, RelayError, type RelayEvent } from "@wuwe1/booey";
import { registerSite } from "./browser.ts";
import { type CollectionConfig, type CollectionSession, collectionSession, openCollection, stopCollections } from "./collection.ts";

const marker = "4cdb5bf8-9671-444c-b2ea-c02d84404c09";
const browser = "collection-navigation-browser";
const site = "collection-navigation-test";
const origin = "https://shop.example/";
const pageUrl = `http://127.0.0.1:5170/?x2BrowserConnect=${marker}#manual-collection`;
const searchUrl = `${origin}search?q=toy`;
const config: CollectionConfig = { pageUrl, marker, site, origin, resultHash: "candidates", hosts: ["shop.example"], linkPattern: "/offer/\\d+\\.html" };
registerSite({ key: site, title: "测试采购平台", origin, hosts: (host) => host === "shop.example", login: { identify: async () => null } });

type Tab = { tabId: number; url: string; targetId: string; openerId?: string; mounted: boolean; events: RelayEvent[]; binding: string };

function relay(t: TestContext) {
	const tabs = new Map<number, Tab>();
	const injected: number[] = [];
	const attached: number[] = [];
	const detached: number[] = [];
	const activeAttachments = new Set<number>();
	const drawn: { tabId: number; state: CollectionSession }[] = [];
	let sequence = 0;
	let nonce = "";
	let failEvaluation = 0;
	let vanishOnAttach: number | undefined;
	let poll: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let stopped = false;
	const add = (tabId: number, url: string, openerId?: string) => {
		const tab: Tab = { tabId, url, targetId: `target-${tabId}`, ...(openerId ? { openerId } : {}), mounted: false, events: [], binding: "" };
		tabs.set(tabId, tab);
		return tab;
	};
	add(1, pageUrl);
	add(20, searchUrl);
	const event = (tabId: number, method: string, params: unknown) => tabs.get(tabId)!.events.push({ seq: ++sequence, method, params, ts: Date.now() });
	const nativeSetInterval = globalThis.setInterval;
	const nativeClearInterval = globalThis.clearInterval;
	t.mock.method(globalThis, "setInterval", ((run: () => void) => {
		poll = run;
		timer = nativeSetInterval(() => {}, 2_000_000_000);
		return timer;
	}) as typeof setInterval);
	t.mock.method(globalThis, "clearInterval", ((value: ReturnType<typeof setInterval>) => {
		if (value === timer) stopped = true;
		nativeClearInterval(value);
	}) as typeof clearInterval);
	t.mock.method(RelayClient.prototype, "browsers", async () => [
		{ id: browser, label: "测试 Ego", attached: [...activeAttachments], tabCount: tabs.size, inflight: 0, subscriptions: {}, stats: null },
	]);
	t.mock.method(RelayClient.prototype, "tabs", async () => [...tabs.values()].map((tab) => ({ tabId: tab.tabId, url: tab.url, title: "测试页面" })));
	t.mock.method(RelayClient.prototype, "openTab", async (url: string) => {
		const tab = add(100, url);
		return { tabId: tab.tabId, url: tab.url, title: "采集首页" };
	});
	t.mock.method(RelayClient.prototype, "attach", async (tabId: number, options?: { events?: string[] }) => {
		if (tabId === vanishOnAttach) {
			tabs.delete(tabId);
			vanishOnAttach = undefined;
			throw new RelayError("候选标签已关闭", "NOT_FOUND", false);
		}
		attached.push(tabId);
		activeAttachments.add(tabId);
		return { events: options?.events ?? [], enabled: ["Page", "Runtime"], failed: [] };
	});
	t.mock.method(RelayClient.prototype, "detach", async (tabId: number) => {
		detached.push(tabId);
		activeAttachments.delete(tabId);
	});
	t.mock.method(RelayClient.prototype, "send", async <T>(tabId: number, method: string, params?: Record<string, unknown>) => {
		const tab = tabs.get(tabId)!;
		if (method === "Target.getTargetInfo") return { targetInfo: { targetId: tab.targetId, openerId: tab.openerId } } as T;
		if (method === "Runtime.addBinding") tab.binding = String(params!.name);
		return { identifier: `script-${tabId}` } as T;
	});
	t.mock.method(RelayClient.prototype, "settled", async () => ({ revision: 0, quiet: true }));
	t.mock.method(RelayClient.prototype, "readEvents", async (tabId: number, options?: { since?: number; filter?: string | RegExp }) => {
		const events = tabs.get(tabId)!.events;
		const filter = typeof options?.filter === "string" ? new RegExp(options.filter) : options?.filter;
		return {
			events: events.filter((entry) => entry.seq > (options?.since ?? 0) && (!filter || filter.test(entry.method))),
			nextSeq: events.at(-1)?.seq ?? 0,
			truncated: false,
			dropped: 0,
		};
	});
	t.mock.method(RelayClient.prototype, "eval", async <T>(tabId: number) => {
		injected.push(tabId);
		tabs.get(tabId)!.mounted = true;
		return undefined as T;
	});
	t.mock.method(
		RelayClient.prototype,
		"evalFn",
		async <A extends readonly unknown[], R>(tabId: number, fn: (...args: A) => R, ...args: A): Promise<Awaited<R>> => {
			if (failEvaluation > 0) {
				failEvaluation--;
				throw new RelayError("Execution context was destroyed.", "DEBUGGER_ERROR", false);
			}
			if (fn.toString().includes("draw")) {
				if (!tabs.get(tabId)!.mounted) return false as Awaited<R>;
				drawn.push({ tabId, state: args[1] as CollectionSession });
				return true as Awaited<R>;
			}
			return undefined as Awaited<R>;
		},
	);
	t.after(stopCollections);
	return {
		tabs,
		injected,
		attached,
		detached,
		drawn,
		add,
		options: {
			overlaySource: async (overlay: { nonce: string }) => {
				nonce = overlay.nonce;
				return "mock-overlay";
			},
		},
		popup: (parent: number, url: string) => event(parent, "Page.windowOpen", { url, userGesture: true, windowName: "", windowFeatures: [] }),
		click: (tabId: number, url: string, seq = 1) =>
			event(tabId, "Runtime.bindingCalled", { name: tabs.get(tabId)!.binding, payload: JSON.stringify({ token: nonce, action: "one", url, seq, epoch: 0 }) }),
		failEvaluation: () => {
			failEvaluation = 1;
		},
		vanishOnAttach: (tabId: number) => {
			vanishOnAttach = tabId;
		},
		tick: async () => {
			if (!stopped) poll?.();
			await setImmediate();
		},
	};
}

test("搜索子标签复用采集队列，首页和结果页相同点击序号均被接纳", async (t) => {
	const f = relay(t);
	const first = Promise.withResolvers<{ status: "added" }>();
	const collected: string[] = [];
	const state = await openCollection(
		config,
		async (url) => {
			collected.push(url);
			return collected.length === 1 ? first.promise : { status: "added" };
		},
		f.options,
	);
	const child = f.add(101, searchUrl, "target-100");
	f.popup(100, searchUrl);
	for (let i = 0; i < 3 && !f.injected.includes(child.tabId); i++) await f.tick();
	assert.equal(f.injected.includes(child.tabId), true);
	assert.equal(f.injected.includes(20), false);
	f.click(100, `${origin}offer/1.html`);
	await f.tick();
	f.click(child.tabId, `${origin}offer/2.html`);
	await f.tick();
	assert.deepEqual(collected, [`${origin}offer/1.html`]);
	first.resolve({ status: "added" });
	await setImmediate();
	assert.deepEqual(collected, [`${origin}offer/1.html`, `${origin}offer/2.html`]);
	assert.equal(collectionSession(state.id).added, 2);
	await f.tick();
	for (const tabId of [100, child.tabId]) assert.equal(f.drawn.findLast((draw) => draw.tabId === tabId)?.state.acknowledgedSeq, 1);
});

test("仅管理明确来自采集页的新子标签，不接管已有页或伪装同网址的其他页", async (t) => {
	const f = relay(t);
	await openCollection(config, async () => ({ status: "added" }), f.options);
	f.add(101, searchUrl, "unrelated-target");
	f.popup(100, searchUrl);
	for (let i = 0; i < 3; i++) await f.tick();
	assert.deepEqual(f.injected, [100]);
	assert.equal(f.attached.includes(20), false);
	assert.deepEqual(f.detached, [101]);
	f.add(102, `${origin}unrelated`, "target-100");
	await f.tick();
	assert.deepEqual(f.injected, [100]);
});

test("搜索候选在附着前关闭不会停止原采集页，后续点击仍可采集", async (t) => {
	const f = relay(t);
	const collected: string[] = [];
	const state = await openCollection(
		config,
		async (url) => {
			collected.push(url);
			return { status: "added" };
		},
		f.options,
	);
	f.add(101, searchUrl, "target-100");
	f.vanishOnAttach(101);
	f.popup(100, searchUrl);
	await f.tick();
	assert.equal(f.tabs.has(101), false);
	assert.notEqual(collectionSession(state.id).status, "error");
	f.click(100, `${origin}offer/1.html`);
	await f.tick();
	assert.deepEqual(collected, [`${origin}offer/1.html`]);
	assert.equal(collectionSession(state.id).added, 1);
	assert.deepEqual(f.injected, [100]);
});

test("同页搜索导航短暂销毁上下文后继续轮询，控件节点消失时重新注入", async (t) => {
	const f = relay(t);
	const state = await openCollection(config, async () => ({ status: "added" }), f.options);
	const home = f.tabs.get(100)!;
	home.url = searchUrl;
	home.mounted = false;
	f.failEvaluation();
	await f.tick();
	await f.tick();
	await f.tick();
	assert.equal(f.injected.filter((tabId) => tabId === 100).length, 2);
	assert.equal(home.mounted, true);
	assert.notEqual(collectionSession(state.id).status, "error");
	assert.equal(f.drawn.findLast((draw) => draw.tabId === 100)?.state.url, searchUrl);
});
