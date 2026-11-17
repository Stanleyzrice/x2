// 人工浏览会话：只在当前 X2 页所在浏览器新开标签，通过 CDP binding 回收点击；平台数据由调用方读取、保存。
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isRelayConnectionFailure, RelayClient, RelayError } from "@wuwe1/booey";
import { z } from "zod";
import { NeedsHuman, Usage } from "../errors.ts";
import { siteDef } from "./browser.ts";
import { browserPageUrl, browsersForPage } from "./connection.ts";

export type CollectionConfig = {
	pageUrl: string;
	marker: string;
	origin: string;
	site: string;
	resultHash: string;
	hosts: string[];
	linkPattern: string;
	canonicalize?: (url: string) => string | null;
	/** 自包含的站点原生节点适配：null 拒绝冲突，undefined 继续检查正常链接。 */
	extractLink?: (node: Element) => string | null | undefined;
};
export type CollectionResult = { url: string; submittedUrl?: string; status: "added" | "exists" | "failed" | "cancelled"; title?: string; error?: string };
export type CollectionSession = {
	id: string;
	site: string;
	browserId: string;
	browserLabel: string;
	tabId: number;
	url: string;
	status: "browsing" | "scanning" | "collecting" | "complete" | "stopped" | "error";
	mode: "single" | "all" | null;
	currentUrl: string | null;
	pendingUrls: string[];
	queued: number;
	cancelled: number;
	stopping: boolean;
	acknowledgedSeq: number;
	epoch: number;
	scanned: number;
	processed: number;
	added: number;
	existing: number;
	failed: number;
	total: number | null;
	complete: boolean;
	error: string | null;
	results: CollectionResult[];
};
type Collect = (url: string, context: { browserId: string; sessionId: string }) => Promise<{ status: "added" | "exists"; title?: string }>;
type CollectionTab = {
	tabId: number;
	url: string;
	targetId: string;
	scriptId: string;
	since: number;
	acknowledgedSeq: number;
	blockedChallenge: boolean;
	navigationSince: number | null;
};
type Active = {
	state: CollectionSession;
	config: CollectionConfig;
	client: RelayClient;
	queue: CollectionQueue;
	nonce: string;
	binding: string;
	script: string;
	tabs: Map<number, CollectionTab>;
	baselineTabs: Set<number>;
	popups: { url: string; openerId: string; at: number }[];
	busy: boolean;
	stopped: boolean;
	listUrl: string | null;
	listTabId: number | null;
	polling: Promise<void> | null;
	disposed: boolean;
	timer: ReturnType<typeof setInterval> | null;
	work: Promise<void> | null;
};
const sessions = new Map<string, Active>();
const command = z.object({
	token: z.string(),
	action: z.enum(["one", "all", "stop", "open"]),
	url: z.string().optional(),
	seq: z.number().int().positive().safe(),
	epoch: z.number().int().nonnegative().safe(),
});
const bindingEvent = z.object({ name: z.string(), payload: z.string() });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

type CollectionTask = { url: string; submittedUrl: string };
type Collected = Awaited<ReturnType<Collect>>;

/** 已点选的商品串行读取；浏览器检查与读取可注入，队列测试不需要连接站点。 */
export class CollectionQueue {
	#pending: CollectionTask[] = [];
	#current: CollectionTask | null = null;
	#work: Promise<void> | null = null;
	#stopped = false;
	#scannedComplete = true;
	readonly state: CollectionSession;
	readonly #collect: (url: string) => Promise<Collected>;
	readonly #check: () => Promise<unknown>;

	constructor(state: CollectionSession, collect: (url: string) => Promise<Collected>, check: () => Promise<unknown>) {
		this.state = state;
		this.#collect = collect;
		this.#check = check;
	}

	get busy(): boolean {
		return this.#work !== null;
	}

	wait(): Promise<void> {
		return this.#work ?? Promise.resolve();
	}

	prepare(mode: "single" | "all"): void {
		if (this.busy) throw new Usage("请等待当前采集结束或停止后再试");
		this.#stopped = false;
		this.#scannedComplete = true;
		Object.assign(this.state, {
			mode,
			status: mode === "all" ? "scanning" : "collecting",
			currentUrl: null,
			pendingUrls: [],
			queued: 0,
			cancelled: 0,
			stopping: false,
			scanned: 0,
			processed: 0,
			added: 0,
			existing: 0,
			failed: 0,
			total: mode === "all" ? null : 0,
			complete: false,
			error: null,
			results: [],
		});
	}

	submit(url: string, submittedUrl = url, epoch = this.state.epoch): boolean {
		if (epoch !== this.state.epoch) {
			this.reject(url, submittedUrl, "此前任务已停止，这次迟到的点击未开始采集；请重新点击加入");
			return false;
		}
		if (this.state.stopping || (this.busy && this.#stopped) || (this.state.mode === "all" && ["scanning", "collecting"].includes(this.state.status))) {
			this.reject(url, submittedUrl, "当前任务正在停止或采集整页，这件商品未开始采集；请稍后重新加入");
			return false;
		}
		if (!this.busy) this.prepare("single");
		if (this.#current?.url === url || this.#pending.some((item) => item.url === url)) return false;
		this.#pending.push({ url, submittedUrl });
		this.state.scanned++;
		this.state.total = (this.state.total ?? 0) + 1;
		this.#sync();
		if (!this.busy) this.#work = Promise.resolve().then(() => this.#drain());
		return true;
	}

	async all(urls: string[], scannedComplete: boolean): Promise<void> {
		if (this.busy || this.#stopped) return;
		this.#scannedComplete = scannedComplete;
		this.#pending = urls.map((url) => ({ url, submittedUrl: url }));
		this.state.total = urls.length + this.state.cancelled;
		this.#sync();
		this.#work = Promise.resolve().then(() => this.#drain());
		await this.#work;
	}

	acknowledge(seq: number, epoch: number, receipt: { acknowledgedSeq: number } = this.state): "duplicate" | "stale" | "current" {
		if (seq <= receipt.acknowledgedSeq) return "duplicate";
		receipt.acknowledgedSeq = seq;
		return epoch === this.state.epoch ? "current" : "stale";
	}

	reject(url: string, submittedUrl: string, message: string): void {
		this.state.results.push({ url, submittedUrl, status: "cancelled", error: message });
		this.state.cancelled++;
		this.state.total = (this.state.total ?? 0) + 1;
		this.state.complete = false;
		this.state.error = message;
		if (!this.busy && !["scanning", "stopped", "error"].includes(this.state.status)) this.state.status = "stopped";
	}

	cancel(message: string, status: "stopped" | "error" = "stopped"): void {
		this.#stopped = true;
		this.state.epoch++;
		for (const item of this.#pending) {
			this.state.results.push({ ...item, status: "cancelled", error: message });
			this.state.cancelled++;
		}
		this.#pending = [];
		this.#sync();
		this.state.status = status;
		this.state.error = message;
		this.state.complete = false;
		this.state.stopping = this.busy;
		if (!this.busy) this.state.mode = null;
	}

	#sync(): void {
		this.state.currentUrl = this.#current?.submittedUrl ?? null;
		this.state.pendingUrls = this.#pending.map((item) => item.submittedUrl);
		this.state.queued = this.#pending.length;
	}

	async #drain(): Promise<void> {
		try {
			if (this.#stopped) return;
			this.state.status = "collecting";
			while (this.#pending.length && !this.#stopped) {
				await this.#check();
				if (this.#stopped) break;
				const item = this.#pending.shift()!;
				this.#current = item;
				this.#sync();
				try {
					const result = await this.#collect(item.url);
					this.state.results.push({ ...item, ...result });
					if (result.status === "added") this.state.added++;
					else this.state.existing++;
				} catch (e) {
					this.state.failed++;
					this.state.results.push({ ...item, status: "failed", error: reason(e) });
					if (e instanceof NeedsHuman) this.cancel(reason(e), "error");
				}
				this.state.processed++;
				this.#current = null;
				this.#sync();
			}
		} catch (e) {
			this.cancel(reason(e), "error");
		} finally {
			this.#current = null;
			this.#work = null;
			this.#sync();
			this.state.stopping = false;
			this.state.mode = null;
			if (!this.#stopped) {
				this.state.complete = this.#scannedComplete && this.state.failed === 0 && this.state.cancelled === 0;
				this.state.status = "complete";
			}
		}
	}
}

/** 不匹配浏览器名字：一次性地址标记只能在发起操作的那个 X2 标签中出现一次。 */
export function collectionPageUrl(pageUrl: string, marker: string): string {
	try {
		return browserPageUrl(pageUrl, marker);
	} catch {
		throw new Usage("请从当前 X2 页面重新打开采集平台");
	}
}

/** 结果页仍在发起操作的 X2 服务，目标页由调用方配置，不在浏览器层认识业务路由。 */
export function collectionResultUrl(pageUrl: string, resultHash: string): string {
	const url = new URL(pageUrl);
	url.searchParams.delete("x2BrowserConnect");
	url.hash = resultHash;
	return url.href;
}

export function collectionUrl(url: string, config: Pick<CollectionConfig, "hosts" | "linkPattern" | "canonicalize">): string | null {
	try {
		const parsed = new URL(url);
		if (
			!["http:", "https:"].includes(parsed.protocol) ||
			parsed.username ||
			parsed.password ||
			!config.hosts.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`)) ||
			!new RegExp(config.linkPattern).test(parsed.href)
		)
			return null;
		parsed.protocol = "https:";
		parsed.hash = "";
		if (!config.canonicalize) return parsed.href;
		const canonical = config.canonicalize(parsed.href);
		return canonical ? collectionUrl(canonical, { hosts: config.hosts, linkPattern: config.linkPattern }) : null;
	} catch {
		return null;
	}
}

/** 查询串代表列表页的筛选与页码；hash 不参与，正常页内定位不会中断。 */
export function sameCollectionPage(left: string, right: string): boolean {
	try {
		const a = new URL(left),
			b = new URL(right);
		a.hash = "";
		b.hash = "";
		return a.href === b.href;
	} catch {
		return false;
	}
}

const allowedHost = (url: string, hosts: string[]) => {
	try {
		const u = new URL(url);
		return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
	} catch {
		return false;
	}
};

async function currentTab(active: Active, tabId = active.listTabId ?? active.state.tabId) {
	const tab = (await active.client.tabs()).find((t) => t.tabId === tabId);
	if (!tab || !allowedHost(tab.url, active.config.hosts)) throw new Usage("采集标签已关闭或离开当前平台，已停止");
	return tab;
}

async function removeTabOverlay(active: Active, tab: CollectionTab, removeRoot: boolean) {
	if (removeRoot)
		await active.client
			.evalFn(tab.tabId, (id: string) => (window as unknown as Record<string, OverlayState>)[`__x2_collection_${id}`]?.dispose(), active.state.id)
			.catch(() => {});
	await active.client.send(tab.tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier: tab.scriptId }).catch(() => {});
	await active.client.send(tab.tabId, "Runtime.removeBinding", { name: active.binding }).catch(() => {});
}

async function dispose(active: Active) {
	interrupt(active, "采集会话已关闭，未开始的排队商品已取消");
	active.disposed = true;
	if (active.timer) clearInterval(active.timer);
	await Promise.all([active.work?.catch(() => {}), active.queue.wait().catch(() => {}), active.polling?.catch(() => {})]);
	const current = await active.client.tabs().catch(() => []);
	await Promise.all(
		[...active.tabs.values()].map((tab) =>
			removeTabOverlay(
				active,
				tab,
				current.some((t) => t.tabId === tab.tabId && allowedHost(t.url, active.config.hosts)),
			),
		),
	);
	active.tabs.clear();
}

export async function stopCollections(): Promise<void> {
	const active = [...sessions.values()];
	sessions.clear();
	await Promise.all(active.map(dispose));
}

type OverlayConfig = { id: string; nonce: string; binding: string; hosts: string[]; linkPattern: string };
type HoverTarget = { url: string; left: number; top: number; width: number };
type OverlayState = { draw: (state: CollectionSession) => void; hover: (target: HoverTarget | null) => void; dispose: () => void };
type Mount = (container: HTMLElement, send: (action: "one" | "all" | "stop" | "open", url?: string) => number) => OverlayState;
type ExtractLink = CollectionConfig["extractLink"];

/** hover 与整页扫描共用一个链接入口；平台只校验地址，不解释站点的商品编号。 */
function productLink(node: Element, config: Pick<CollectionConfig, "hosts" | "linkPattern">, extractLink: ExtractLink, pageUrl: string): string | null {
	const accepted = (value: string) => {
		try {
			const u = new URL(value, pageUrl);
			return ["http:", "https:"].includes(u.protocol) &&
				!u.username &&
				!u.password &&
				config.hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`)) &&
				new RegExp(config.linkPattern).test(u.href)
				? u.href
				: null;
		} catch {
			return null;
		}
	};
	const native = extractLink?.(node);
	if (native !== undefined) return native === null ? null : accepted(native);
	for (let parent: Element | null = node, depth = 0; parent && depth < 6; parent = parent.parentElement, depth++) {
		const anchor = parent.matches("a[href]") ? parent : parent.querySelector("a[href]");
		const href = anchor?.getAttribute("href");
		const selected = href ? accepted(href) : null;
		if (selected) return selected;
	}
	return accepted(pageUrl);
}

/** 只负责桥接与命中图像；浮球、按钮和面板由同一份 shadcn 组件渲染，不复制产品样式。 */
function installOverlay(config: OverlayConfig, mount: Mount, css: string, findLink: typeof productLink, extractLink: ExtractLink) {
	if (window.top !== window) return;
	if (!config.hosts.some((h) => location.hostname === h || location.hostname.endsWith(`.${h}`))) return;
	const scope = window as unknown as Record<string, unknown>;
	const key = `__x2_collection_${config.id}`;
	const installed = scope[key] as OverlayState | undefined;
	if (installed && document.querySelector(`[data-x2-collection="${config.id}"]`)?.isConnected) return;
	installed?.dispose();
	if (!document.documentElement || document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", () => installOverlay(config, mount, css, findLink, extractLink), { once: true });
		return;
	}
	const root = document.createElement("div");
	root.dataset.x2Collection = config.id;
	root.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483646;pointer-events:none;font:14px/1.5 system-ui,-apple-system,sans-serif";
	const shadow = root.attachShadow({ mode: "closed" });
	const style = document.createElement("style");
	style.textContent = css;
	const container = document.createElement("div");
	shadow.append(style, container);
	document.documentElement.append(root);
	let seq = 0;
	let epoch = 0;
	const ui = mount(container, (action, url) => {
		const fn = scope[config.binding];
		seq++;
		if (typeof fn === "function") fn(JSON.stringify({ token: config.nonce, action, url, seq, epoch }));
		return seq;
	});
	let previous: HoverTarget | null = null;
	const show = (target: HoverTarget | null) => {
		if (previous?.url === target?.url && previous?.left === target?.left && previous?.top === target?.top && previous?.width === target?.width) return;
		previous = target;
		ui.hover(target);
	};
	const visibleAt = (img: HTMLImageElement, x: number, y: number) => {
		const r = img.getBoundingClientRect();
		if (
			r.width < 80 ||
			r.height < 80 ||
			x < r.left ||
			x > r.right ||
			y < r.top ||
			y > r.bottom ||
			!img.checkVisibility({ opacityProperty: true, visibilityProperty: true })
		)
			return false;
		// 轮播图未显示的 slide 仍有布局尺寸，必须同时处于所有裁剪容器可见范围。
		for (let parent = img.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
			const box = parent.getBoundingClientRect(),
				computed = getComputedStyle(parent);
			if (/(?:hidden|clip|scroll|auto)/.test(computed.overflowX) && (x < box.left || x > box.right)) return false;
			if (/(?:hidden|clip|scroll|auto)/.test(computed.overflowY) && (y < box.top || y > box.bottom)) return false;
		}
		return true;
	};
	const move = (event: MouseEvent) => {
		if (!(event.target instanceof Element) || root.contains(event.target)) return;
		let img = event.target instanceof HTMLImageElement && visibleAt(event.target, event.clientX, event.clientY) ? event.target : null;
		// 图片可能被放大镜、价格或链接蒙层覆盖；在附近容器里按鼠标位置找真正可见的图。
		for (
			let parent: Element | null = event.target, depth = 0;
			!img && parent && parent !== document.body && depth < 4;
			parent = parent.parentElement, depth++
		) {
			img = Array.from(parent.querySelectorAll("img")).find((candidate) => visibleAt(candidate, event.clientX, event.clientY)) ?? null;
		}
		if (!img) {
			show(null);
			return;
		}
		const selected = findLink(img, config, extractLink, location.href);
		if (!selected) {
			show(null);
			return;
		}
		const rect = img.getBoundingClientRect();
		const width = rect.width - 12;
		show({
			url: selected,
			width,
			left: Math.max(8, Math.min(rect.left + 6, document.documentElement.clientWidth - width - 8)),
			top: Math.max(8, Math.min(rect.bottom - 50, innerHeight - 52)),
		});
	};
	const scroll = () => show(null);
	document.addEventListener("mousemove", move);
	document.addEventListener("scroll", scroll, true);
	scope[key] = {
		draw: (state: CollectionSession) => {
			if (state.epoch < epoch) return;
			seq = Math.max(seq, state.acknowledgedSeq);
			epoch = state.epoch;
			ui.draw(state);
		},
		hover: (target: HoverTarget | null) => ui.hover(target),
		dispose: () => {
			ui.dispose();
			root.remove();
			document.removeEventListener("mousemove", move);
			document.removeEventListener("scroll", scroll, true);
			delete scope[key];
		},
	} satisfies OverlayState;
}

async function overlaySource(config: OverlayConfig, extractLink: ExtractLink): Promise<string> {
	const [js, css] = await Promise.all([
		readFile(new URL("../ui/dist/collection-ui.js", import.meta.url), "utf8"),
		readFile(new URL("../ui/dist/collection-ui.css", import.meta.url), "utf8"),
	]);
	const scopedCss = `:host{all:initial;font:14px/1.5 system-ui,-apple-system,sans-serif}${css.replace(/:root\b/g, ":host")}`;
	const allowed = `(${JSON.stringify(config.hosts)}).some(h=>location.hostname===h||location.hostname.endsWith("."+h))`;
	return `(()=>{if(!${allowed})return;${js};(${installOverlay.toString()})(${JSON.stringify(config)},X2CollectionUI.mount,${JSON.stringify(scopedCss)},(${productLink.toString()}),${extractLink ? `(${extractLink.toString()})` : "undefined"});})()`;
}

function snapshot(active: Active, tab?: CollectionTab): CollectionSession {
	return structuredClone(tab ? { ...active.state, tabId: tab.tabId, url: tab.url, acknowledgedSeq: tab.acknowledgedSeq } : active.state);
}
export function collectionSession(id: string): CollectionSession {
	const active = sessions.get(id);
	if (!active) throw new Usage("采集会话已结束，请重新打开平台");
	return snapshot(active);
}
export function stopCollection(id: string): CollectionSession {
	const active = sessions.get(id);
	if (!active) throw new Usage("采集会话已结束，请重新打开平台");
	interrupt(active, "已停止采集，未开始的排队商品已取消");
	return snapshot(active);
}

function interrupt(active: Active, message: string, status: "stopped" | "error" = "stopped") {
	active.stopped = true;
	active.queue.cancel(message, status);
	active.state.stopping = active.busy || active.queue.busy;
}

function scanDocument(config: Pick<CollectionConfig, "hosts" | "linkPattern">, findLink: typeof productLink, extractLink: ExtractLink) {
	const candidates = [
		document.scrollingElement ?? document.documentElement,
		...document.querySelectorAll<HTMLElement>("main, [role=main], [class*=scroll], [class*=list]"),
	];
	const scroller =
		candidates
			.filter((el) => el.clientHeight > 200 && el.scrollHeight > el.clientHeight + 8)
			.sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0] ??
		document.scrollingElement ??
		document.documentElement;
	for (const marked of document.querySelectorAll("[data-x2-scroll]")) marked.removeAttribute("data-x2-scroll");
	scroller.setAttribute("data-x2-scroll", "current");
	return {
		url: location.href,
		links: Array.from(document.querySelectorAll("img"))
			.map((img) => findLink(img, config, extractLink, location.href))
			.filter((url) => url !== null),
		height: scroller.scrollHeight,
		top: scroller.scrollTop,
		left: scroller.scrollLeft,
		viewport: scroller.clientHeight,
	};
}

async function links(active: Active, tabId: number) {
	const { hosts, linkPattern, extractLink } = active.config;
	const raw = await active.client.eval(
		tabId,
		`(${scanDocument.toString()})(${JSON.stringify({ hosts, linkPattern })},(${productLink.toString()}),${extractLink ? `(${extractLink.toString()})` : "undefined"})`,
	);
	return z.object({ url: z.string(), links: z.array(z.string()), height: z.number(), top: z.number(), left: z.number(), viewport: z.number() }).parse(raw);
}

async function runAll(active: Active, tabId: number) {
	if (active.busy || active.queue.busy || active.disposed) return;
	active.queue.prepare("all");
	active.busy = true;
	active.stopped = false;
	active.listTabId = tabId;
	try {
		const initial = await currentTab(active, tabId);
		const listUrl = initial.url;
		active.listUrl = listUrl;
		active.state.url = listUrl;
		const found = new Set<string>();
		let scannedComplete = false;
		{
			const start = await links(active, tabId);
			if (!sameCollectionPage(start.url, listUrl)) throw new Usage("采集期间页面已切换，请在目标列表重新采集");
			try {
				await active.client.evalFn(tabId, () => {
					document.querySelector('[data-x2-scroll="current"]')?.scrollTo({ top: 0, behavior: "instant" });
				});
				let stable = 0;
				for (let iteration = 0; iteration < 100 && !active.stopped; iteration++) {
					const page = await links(active, tabId);
					if (!sameCollectionPage(page.url, listUrl)) throw new Usage("采集期间页面已切换，未混入新页面商品；请在目标列表重新采集");
					const before = found.size;
					for (const link of [...page.links, page.url]) {
						const accepted = collectionUrl(link, active.config);
						if (accepted) found.add(accepted);
					}
					active.state.scanned = found.size;
					if (found.size > 1000) throw new Usage("本页超过 1000 件，请缩小列表范围后采集");
					stable = page.top + page.viewport >= page.height - 8 && found.size === before ? stable + 1 : 0;
					if (stable >= 4) {
						scannedComplete = true;
						break;
					}
					await active.client.evalFn(tabId, () => {
						const el = document.querySelector('[data-x2-scroll="current"]') ?? document.scrollingElement ?? document.documentElement;
						el.scrollTo({ top: Math.min(el.scrollTop + el.clientHeight * 0.85, el.scrollHeight), behavior: "instant" });
					});
					await sleep(500);
				}
			} finally {
				if (sameCollectionPage((await currentTab(active, tabId)).url, listUrl))
					await active.client.evalFn(
						tabId,
						(top: number, left: number) => document.querySelector('[data-x2-scroll="current"]')?.scrollTo({ top, left, behavior: "instant" }),
						start.top,
						start.left,
					);
			}
		}
		active.state.scanned = found.size;
		active.state.total = found.size;
		if (!found.size && !active.stopped) throw new Usage("本页没有识别到商品链接，请在商品列表或详情页重试");
		if (!scannedComplete && !active.stopped) active.state.error = "本页仍在继续加载，已保存已发现的商品；本次未覆盖全部商品。";
		if (!active.stopped) await active.queue.all([...found], scannedComplete);
	} catch (e) {
		interrupt(active, reason(e), "error");
	} finally {
		active.busy = false;
		active.listUrl = null;
		active.listTabId = null;
		active.state.stopping = active.queue.busy;
		if (!active.queue.busy) active.state.mode = null;
	}
}

const collectionEvents = ["nav", "Page.windowOpen", "Runtime.bindingCalled"];
const targetInfo = z.object({ targetInfo: z.object({ targetId: z.string().min(1), openerId: z.string().optional(), url: z.string().optional() }) });
const popupEvent = z.object({ url: z.string(), userGesture: z.boolean().optional() });

/** 导航销毁旧执行上下文属于短暂切页；其它脚本或连接错误不能无限吞掉。 */
function navigationChanged(error: unknown): boolean {
	return (
		error instanceof RelayError &&
		error.code === "DEBUGGER_ERROR" &&
		/Execution context was destroyed|Cannot find (?:default execution )?context|Inspected target navigated/i.test(error.message)
	);
}

async function addTab(active: Active, tabId: number, url: string, info?: z.output<typeof targetInfo>["targetInfo"]): Promise<CollectionTab> {
	await active.client.attach(tabId, { events: collectionEvents });
	const target = info ?? targetInfo.parse(await active.client.send(tabId, "Target.getTargetInfo")).targetInfo;
	await active.client.send(tabId, "Runtime.addBinding", { name: active.binding });
	const { identifier } = await active.client.send<{ identifier: string }>(tabId, "Page.addScriptToEvaluateOnNewDocument", { source: active.script });
	const tab: CollectionTab = {
		tabId,
		url,
		targetId: target.targetId,
		scriptId: identifier,
		since: 0,
		acknowledgedSeq: 0,
		blockedChallenge: false,
		navigationSince: null,
	};
	active.tabs.set(tabId, tab);
	try {
		await active.client.eval(tabId, active.script);
	} catch (error) {
		if (!navigationChanged(error)) throw error;
		tab.navigationSince = Date.now();
	}
	return tab;
}

/** 只跟随本会话页确切打开的子页；会话前已有标签和没有 opener 证据的页面绝不注入。 */
async function followPopups(active: Active, current: { tabId: number; url: string }[]) {
	active.popups = active.popups.filter((popup) => Date.now() - popup.at < 15_000);
	for (const popup of [...active.popups]) {
		if (active.disposed) return;
		const matches = current.filter((tab) => !active.baselineTabs.has(tab.tabId) && !active.tabs.has(tab.tabId) && sameCollectionPage(tab.url, popup.url));
		if (matches.length !== 1) continue;
		const candidate = matches[0]!;
		const wasAttached = (await active.client.browsers()).find((browser) => browser.id === active.state.browserId)?.attached.includes(candidate.tabId) ?? false;
		let approved = false;
		try {
			// 初次附着只读目标身份，不更改未知页面的既有订阅或执行页面脚本。
			if (active.disposed) return;
			await active.client.attach(candidate.tabId);
			const info = targetInfo.parse(await active.client.send(candidate.tabId, "Target.getTargetInfo")).targetInfo;
			if (active.disposed) return;
			if (info.openerId !== popup.openerId || !sameCollectionPage(info.url ?? candidate.url, popup.url)) {
				active.baselineTabs.add(candidate.tabId);
				continue;
			}
			approved = true;
			await addTab(active, candidate.tabId, candidate.url, info);
			active.popups = active.popups.filter((pending) => pending !== popup);
		} catch (error) {
			if (isRelayConnectionFailure(error) && !(error instanceof RelayError && error.code === "TAB_DETACHED")) throw error;
			// 候选刚被关闭不影响原采集页；无法确认浏览器仍可达时保留原错误。
			const vanished = await active.client
				.tabs()
				.then((tabs) => !tabs.some((tab) => tab.tabId === candidate.tabId))
				.catch(() => false);
			if (!vanished) throw error;
			active.baselineTabs.add(candidate.tabId);
		} finally {
			if (!approved && !wasAttached) await active.client.detach(candidate.tabId).catch(() => {});
		}
	}
}

async function draw(active: Active, tab: CollectionTab) {
	const update = () =>
		active.client.evalFn(
			tab.tabId,
			(id: string, state: CollectionSession) => {
				const overlay = (window as unknown as Record<string, OverlayState>)[`__x2_collection_${id}`];
				if (!overlay || !document.querySelector(`[data-x2-collection="${id}"]`)?.isConnected) return false;
				overlay.draw(state);
				return true;
			},
			active.state.id,
			snapshot(active, tab),
		);
	if (!(await update())) {
		await active.client.eval(tab.tabId, active.script);
		await update();
	}
}

async function pollTab(active: Active, tab: CollectionTab) {
	if (!active.stopped && active.listTabId === tab.tabId && active.listUrl && !sameCollectionPage(tab.url, active.listUrl))
		interrupt(active, "整页采集期间页面已切换，排队商品已取消；已保存商品保留。", "error");
	const events = await active.client.readEvents(tab.tabId, { since: tab.since, filter: "^(Runtime\\.bindingCalled|Page\\.windowOpen)$" });
	if (active.disposed) return;
	if (events.truncated) {
		tab.since = events.nextSeq;
		interrupt(active, "采集指令事件已丢失，本批未开始的任务已取消；请重新打开平台，已保存商品保留。", "error");
		await draw(active, tab);
		return;
	}
	for (const event of events.events) {
		if (event.method !== "Page.windowOpen") continue;
		const popup = popupEvent.safeParse(event.params);
		if (!popup.success || popup.data.userGesture === false || !allowedHost(popup.data.url, active.config.hosts)) continue;
		if (!active.popups.some((pending) => pending.openerId === tab.targetId && sameCollectionPage(pending.url, popup.data.url)))
			active.popups.push({ url: popup.data.url, openerId: tab.targetId, at: Date.now() });
	}
	const challenger = siteDef(active.state.site).challenge;
	const blocked = challenger ? challenger.seen((await active.client.evalFn(tab.tabId, challenger.look)) as never) : false;
	if (blocked) {
		if (!tab.blockedChallenge) interrupt(active, "平台要求安全验证，请在 Ego 当前采集标签中手动完成；未开始的任务已取消，验证后重新点击采集。", "error");
		tab.blockedChallenge = true;
	} else if (tab.blockedChallenge && !active.busy && !active.queue.busy) {
		tab.blockedChallenge = false;
		active.state.status = "browsing";
		active.state.error = null;
	}
	for (const event of events.events) {
		if (active.disposed) break;
		if (event.method !== "Runtime.bindingCalled") continue;
		const p = bindingEvent.safeParse(event.params);
		if (!p.success || p.data.name !== active.binding) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(p.data.payload);
		} catch {
			continue;
		}
		const c = command.safeParse(parsed);
		if (!c.success || c.data.token !== active.nonce) continue;
		const receipt = active.queue.acknowledge(c.data.seq, c.data.epoch, tab);
		if (receipt === "duplicate") continue;
		active.state.tabId = tab.tabId;
		active.state.url = tab.url;
		if (c.data.action === "one") {
			const accepted = c.data.url && collectionUrl(c.data.url, active.config);
			if (!accepted) {
				active.state.error = "这不是当前平台的商品链接";
				continue;
			}
			if (blocked) active.queue.reject(accepted, c.data.url!, "平台需要安全验证，这件商品未开始采集；验证后请重新加入");
			else if (active.queue.submit(accepted, c.data.url, c.data.epoch)) active.stopped = false;
		} else if (c.data.action === "stop") {
			if (receipt === "current") stopCollection(active.state.id);
		} else if (c.data.action === "open") {
			await active.client.openTab(collectionResultUrl(active.config.pageUrl, active.config.resultHash));
		} else if (receipt === "stale" || blocked || active.busy || active.queue.busy) {
			active.state.error = "当前任务尚未结束或此前已停止，整页采集未开始；请稍后重新点击";
		} else active.work = runAll(active, tab.tabId);
	}
	tab.since = events.nextSeq;
	if (!active.disposed) await draw(active, tab);
}

async function poll(active: Active) {
	if (active.polling || active.disposed) return;
	const finished = Promise.withResolvers<void>();
	active.polling = finished.promise;
	try {
		const current = await active.client.tabs();
		for (const tab of [...active.tabs.values()]) {
			if (active.disposed) return;
			const existing = current.find((candidate) => candidate.tabId === tab.tabId);
			if (!existing || !allowedHost(existing.url, active.config.hosts)) {
				if (active.listTabId === tab.tabId) interrupt(active, "整页采集标签已关闭或离开平台，未开始的任务已取消", "error");
				await removeTabOverlay(active, tab, false);
				active.tabs.delete(tab.tabId);
				continue;
			}
			tab.url = existing.url;
			try {
				await pollTab(active, tab);
				tab.navigationSince = null;
			} catch (error) {
				if (!navigationChanged(error) || (tab.navigationSince !== null && Date.now() - tab.navigationSince > 15_000)) throw error;
				tab.navigationSince ??= Date.now();
			}
		}
		if (active.disposed) return;
		await followPopups(active, current);
		if (!active.tabs.size) throw new Usage("采集标签已关闭或离开当前平台，已停止");
		if (!active.tabs.has(active.state.tabId)) {
			const remaining = active.tabs.values().next().value!;
			active.state.tabId = remaining.tabId;
			active.state.url = remaining.url;
		}
	} catch (error) {
		interrupt(active, `采集浏览器连接中断：${reason(error)}`, "error");
		if (active.timer) clearInterval(active.timer);
	} finally {
		active.polling = null;
		finished.resolve();
	}
}

export async function openCollection(
	config: CollectionConfig,
	collect: Collect,
	options: { overlaySource?: typeof overlaySource } = {},
): Promise<CollectionSession> {
	const source = collectionPageUrl(config.pageUrl, config.marker);
	const origin = new URL(config.origin);
	if (origin.protocol !== "https:" || !config.hosts.length || !config.hosts.some((h) => origin.hostname === h || origin.hostname.endsWith(`.${h}`)))
		throw new Usage("采集平台地址无效");
	new RegExp(config.linkPattern);
	const matches = await browsersForPage(source);
	if (matches.length !== 1)
		throw new NeedsHuman(matches.length ? "当前 X2 页面连接标记重复，请重新打开采集平台" : "当前 Ego 的 CDP 插件尚未连接，请确认 cdp-relay 已连接后重试");
	const browser = matches[0]!;
	for (const [id, active] of sessions)
		if (active.state.browserId === browser.id && active.state.site === config.site) {
			await dispose(active);
			sessions.delete(id);
		}
	const client = new RelayClient({ browser: browser.id });
	const baselineTabs = new Set((await client.tabs()).map((tab) => tab.tabId));
	const id = randomUUID(),
		nonce = randomUUID(),
		binding = `__x2Collect_${id.replaceAll("-", "")}`;
	const script = await (options.overlaySource ?? overlaySource)(
		{ id, nonce, binding, hosts: config.hosts, linkPattern: config.linkPattern },
		config.extractLink,
	);
	const tab = await client.openTab(config.origin);
	const state: CollectionSession = {
		id,
		site: config.site,
		browserId: browser.id,
		browserLabel: browser.label || "Ego",
		tabId: tab.tabId,
		url: config.origin,
		status: "browsing",
		mode: null,
		currentUrl: null,
		pendingUrls: [],
		queued: 0,
		cancelled: 0,
		stopping: false,
		acknowledgedSeq: 0,
		epoch: 0,
		scanned: 0,
		processed: 0,
		added: 0,
		existing: 0,
		failed: 0,
		total: null,
		complete: false,
		error: null,
		results: [],
	};
	const active: Active = {
		state,
		config,
		client,
		queue: new CollectionQueue(
			state,
			(url) => collect(url, { browserId: browser.id, sessionId: id }),
			async () => {
				if (!active.tabs.size) throw new Usage("采集页面已关闭，请重新打开平台");
				if (active.listTabId !== null) {
					const current = await currentTab(active, active.listTabId);
					if (active.listUrl && !sameCollectionPage(current.url, active.listUrl))
						throw new Usage("整页采集期间页面已切换，排队商品已取消；此前保存的商品保留。");
					if (active.tabs.get(active.listTabId)?.blockedChallenge) throw new NeedsHuman("平台需要安全验证，未开始的排队商品已取消");
				}
			},
		),
		nonce,
		binding,
		script,
		tabs: new Map(),
		baselineTabs,
		popups: [],
		busy: false,
		stopped: false,
		listUrl: null,
		listTabId: null,
		polling: null,
		disposed: false,
		timer: null,
		work: null,
	};
	try {
		const primary = await addTab(active, tab.tabId, config.origin);
		await client.send(tab.tabId, "Page.bringToFront");
		await client.send(tab.tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
		await client.settled(tab.tabId, { timeoutMs: 8000 });
		await draw(active, primary);
	} catch (error) {
		await dispose(active);
		throw error;
	}
	active.timer = setInterval(() => void poll(active), 750);
	active.timer.unref();
	sessions.set(id, active);
	return snapshot(active);
}
