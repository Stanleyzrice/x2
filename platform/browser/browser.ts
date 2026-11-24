// 站点会话复用运营登录态，只操作 X2 自有标签页；身份探测失败关闭临时页，验证挑战立即停止。
// 同浏览器、同站点用进程间锁串行访问，账号身份只在当前进程缓存，显式连接时重新识别。
import { AsyncLocalStorage } from "node:async_hooks";
import { isRelayConnectionFailure, RelayClient, RelayError } from "@wuwe1/booey";
import { Challenge, NeedsHuman, Usage } from "../errors.ts";
import { acquire, type Lock, spaced } from "./lock.ts";
import { createVerificationRegistry, type VerificationDriver } from "./verification.ts";

const MARK = "x2";
const GRACE_MS = 2000;

export type Page = {
	readonly browser: string;
	readonly tabId: number;
	/** 在页面里调用一个函数：fn 要自给自足（不引用外面的变量），参数经 JSON 传进去 */
	run<A extends readonly unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<Awaited<R>>;
	goto(url: string): Promise<void>;
};

export type Browser = { id: string; label: string; attached: number[] };

/** 认人机验证：look、seen 要自给自足（整个放进页面里跑） */
// seen 拿到的是 look 回的（两个在页面里配对跑，参数写成 never：哪个站的 look 回什么由它自己定）
export type Challenger = { look: () => unknown; seen: (l: never) => boolean; url: (url: string) => boolean };

export type Account = { id: string; name: string };

export type SiteDef = {
	key: string;
	title: string;
	origin: string;
	hosts: (host: string) => boolean;
	paceMs?: number;
	/** 人机验证（例 滑块）：在页面里跑的时候一直看着，认出来就停（Challenge），不等到超时。
	 * look 在页面里收集要看的，seen 判（两个都整个放进页面里跑：不引用外面的东西）；落地的地址就看得出的，url 判 */
	challenge?: Challenger;
	login: {
		identify: () => Promise<Account | null>;
		cookie?: { url: string; signedIn: (jar: Map<string, string> | null) => boolean | null };
		each?: { flag: string };
	};
};

const sites = new Map<string, SiteDef>();
export function registerSite(d: SiteDef): void {
	sites.set(d.key, d);
}
export function siteDef(key: string): SiteDef {
	const d = sites.get(key);
	if (!d) throw new Error(`没有注册站点 ${key}`);
	return d;
}
export const allSites = (): SiteDef[] => [...sites.values()];

export function siteOf(url: string): string | null {
	const host = new URL(url).hostname;
	return allSites().find((d) => d.hosts(host))?.key ?? null;
}

export function loginPage(url: string): boolean {
	const u = new URL(url);
	return /^(login|passport|signin|accounts?)\./i.test(u.hostname) || /\/(login|signin|passport)/i.test(u.pathname);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chosen = new AsyncLocalStorage<string>();

export const using = <T>(browser: string, fn: () => Promise<T>): Promise<T> => chosen.run(browser, fn);

export async function browsers(): Promise<Browser[]> {
	const all = await new RelayClient({}).browsers().catch(() => {
		throw new NeedsHuman("连不上 CDP：浏览器开着吗？扩展连上了吗？");
	});
	return all.map((b) => ({ id: b.id, label: b.label, attached: b.attached ?? [] }));
}

const short = (b: Browser) => b.label || b.id.slice(0, 8);

export async function pick(origin: string): Promise<Browser> {
	const all = await browsers();
	if (all.length === 0) throw new NeedsHuman("没有连上的浏览器：打开 Ego，确认 CDP 扩展已连接");
	const want = chosen.getStore() ?? process.env.X2_BROWSER;
	if (want) {
		const b = all.find((x) => x.id === want || x.label === want);
		if (!b) throw new NeedsHuman(`浏览器 ${want} 没有连着：打开它，确认 booey 扩展已连接`);
		return b;
	}
	if (all.length === 1) return all[0]!;
	const site = siteOf(origin);
	if (!site) throw new Usage(`连着 ${all.length} 个浏览器，用 X2_BROWSER 选一个：${all.map(short).join("、")}`);
	const id = await browserFor(site);
	const b = all.find((x) => x.id === id);
	if (!b) throw new NeedsHuman(`浏览器 ${id} 刚断开了：确认 booey 扩展已连接再试`);
	return b;
}

type Lease = { lock: Lock | null; active: number; idle: NodeJS.Timeout | null; wait: Promise<void> | null };
const leases = new Map<string, Lease>();

async function enter(b: Browser, site: string): Promise<() => void> {
	const key = `${b.id}-${site}`;
	let l = leases.get(key);
	if (!l) {
		l = { lock: null, active: 0, idle: null, wait: null };
		leases.set(key, l);
	}
	const lease = l;
	lease.active++;
	if (lease.idle) {
		clearTimeout(lease.idle);
		lease.idle = null;
	}
	try {
		while (!lease.lock) {
			lease.wait ??= acquire(key, { onWait: (o) => console.error(`排队：浏览器 ${short(b)} 的 ${site} 正被另一个 x2 用（pid ${o.pid}：${o.cmd}），等它用完`) })
				.then((lock) => {
					lease.lock = lock;
				})
				.finally(() => {
					lease.wait = null;
				});
			await lease.wait;
		}
	} catch (e) {
		lease.active--;
		throw e;
	}
	let left = false;
	return () => {
		if (left) return;
		left = true;
		if (--lease.active > 0) return;
		lease.idle = setTimeout(() => {
			lease.idle = null;
			if (lease.active === 0 && lease.lock) {
				lease.lock.release();
				lease.lock = null;
			}
		}, GRACE_MS);
		lease.idle.unref();
	};
}

const verification = createVerificationRegistry();
const accountBrowsers = new Map<string, string>();

class Hit extends Error {
	readonly tabId: number;
	constructor(tabId: number) {
		super();
		this.tabId = tabId;
	}
}

export async function challenge(browser: string, site: string, tabId?: number): Promise<Challenge> {
	if (tabId !== undefined) verification.challenge(site, browser, tabId);
	return new Challenge(`${sites.get(site)?.title ?? site} 要过滑块验证，请在原验证页手动完成，再点击「验证完成，重新检测」`);
}

async function within<T>(b: Browser, site: string, fn: () => Promise<T>): Promise<T> {
	const exit = await enter(b, site);
	let tabId: number;
	try {
		return await fn();
	} catch (e) {
		if (!(e instanceof Hit)) throw e;
		tabId = e.tabId;
	} finally {
		exit();
	}
	throw await challenge(b.id, site, tabId);
}

export async function hold<T>(origin: string, fn: () => Promise<T>): Promise<T> {
	const b = await pick(origin);
	return within(b, siteOf(origin) ?? new URL(origin).host, () => chosen.run(b.id, fn));
}

async function pace(b: Browser, site: string): Promise<void> {
	const gap = sites.get(site)?.paceMs;
	if (gap) await spaced(`${b.id}-${site}`, gap);
}

async function settle(c: RelayClient, tabId: number, origin: string, site: string, timeoutMs = 30_000): Promise<void> {
	const until = Date.now() + timeoutMs;
	let last = "";
	for (;;) {
		const s = await c.eval<{ state: string; url: string }>(tabId, "({ state: document.readyState, url: location.href })").catch(() => null);
		if (s && sites.get(site)?.challenge?.url(s.url)) throw new Hit(tabId);
		if (s?.state === "complete" && s.url === last) break;
		last = s?.state === "complete" ? s.url : "";
		if (Date.now() > until) throw new Error(`页面 ${timeoutMs / 1000} 秒还没加载完`);
		await sleep(300);
	}
	if (new URL(last).origin !== origin && loginPage(last)) {
		await c.send(tabId, "Page.close").catch(() => {});
		const known = siteOf(origin);
		throw new NeedsHuman(`${known ? siteDef(known).title : new URL(origin).host} 没有登录（跳到了 ${new URL(last).host} 的登录页）：在浏览器里登录再试`);
	}
}

export function guarded(fn: (...args: never[]) => unknown, args: readonly unknown[], challenge: Challenger): string {
	const call = `(${fn.toString()})(${args.map((a) => JSON.stringify(a) ?? "undefined").join(",")})`;
	return `(async () => {
		const look = ${challenge.look.toString()};
		const challengeOf = ${challenge.seen.toString()};
		if (challengeOf(look())) return { x2: "challenge" };
		let timer;
		const seen = new Promise((resolve) => { timer = setInterval(() => { if (challengeOf(look())) resolve({ x2: "challenge" }); }, 500); });
		try {
			return await Promise.race([Promise.resolve().then(() => ${call}).then((value) => ({ x2: "ok", value })), seen]);
		} finally {
			clearInterval(timer);
		}
	})()`;
}

const opened = new AsyncLocalStorage<number[]>();
const finding = new Map<string, Promise<number>>();
const probeTabs = new Map<string, { owner: number[]; shared: boolean; closing: boolean }>();
const probeTabKey = (browser: string, tabId: number) => `${browser}:${tabId}`;

/** 附着失败时才查原编号是否还在；不选另一页，也不重放页面函数。 */
async function attachTab(c: RelayClient, tabId: number): Promise<void> {
	try {
		await c.attach(tabId);
	} catch (error) {
		if (!(error instanceof RelayError)) throw error;
		if (isRelayConnectionFailure(error))
			throw new RelayError(`X2 标签页 ${tabId} 的浏览器连接已断开，请确认 CDP 连接后重新检测：${error.message}`, error.code, error.retriable, error.status);
		const exists = await c
			.tabs()
			.then((tabs) => tabs.some((tab) => tab.tabId === tabId))
			.catch(() => null);
		throw new RelayError(
			exists === false ? `X2 标签页 ${tabId} 已关闭或不存在，请重新读取；本次操作尚未执行` : `X2 标签页 ${tabId} 无法接入调试连接：${error.message}`,
			exists === false ? "NOT_FOUND" : error.code,
			false,
			error.status,
		);
	}
}

async function attached<T>(c: RelayClient, tabId: number, run: () => Promise<T>): Promise<T> {
	await attachTab(c, tabId);
	try {
		return await run();
	} catch (error) {
		if (error instanceof RelayError && (error.code === "TAB_NOT_ATTACHED" || isRelayConnectionFailure(error)))
			throw new RelayError(`X2 标签页 ${tabId} 的调试连接已中断，原操作未自动重试；请先核对结果再继续：${error.message}`, error.code, false, error.status);
		throw error;
	}
}

async function tabFor(c: RelayClient, b: Browser, origin: string, site: string): Promise<number> {
	for (const t of (await c.tabs()).filter((t) => t.url.startsWith(origin))) {
		const temporary = probeTabs.get(probeTabKey(b.id, t.tabId));
		if (temporary?.closing) continue;
		if (temporary && temporary.owner !== opened.getStore()) temporary.shared = true;
		try {
			await attachTab(c, t.tabId);
		} catch (error) {
			if (error instanceof RelayError && error.code === "NOT_FOUND") continue;
			throw error;
		}
		if ((await c.eval<string>(t.tabId, "window.name")) === MARK) {
			verification.own(site, b.id, t.tabId);
			return t.tabId;
		}
	}
	await pace(b, site);
	const tab = await c.openTab(origin);
	verification.own(site, b.id, tab.tabId);
	const owner = opened.getStore();
	if (owner) {
		owner.push(tab.tabId);
		probeTabs.set(probeTabKey(b.id, tab.tabId), { owner, shared: false, closing: false });
	}
	await attachTab(c, tab.tabId);
	await settle(c, tab.tabId, origin, site);
	await c.eval(tab.tabId, `window.name = ${JSON.stringify(MARK)}`);
	return tab.tabId;
}

export async function page(origin: string): Promise<Page> {
	const b = await pick(origin);
	const site = siteOf(origin) ?? new URL(origin).host;
	const c = new RelayClient({ browser: b.id });
	const id = await within(b, site, async () => {
		const key = `${b.id} ${origin}`;
		let found = finding.get(key);
		if (!found) {
			found = tabFor(c, b, origin, site).finally(() => finding.delete(key));
			finding.set(key, found);
		}
		const tabId = await found;
		// finding 的等待者也可能来自另一异步上下文；临时页一旦被借用，创建者不再独占清理权。
		const temporary = probeTabs.get(probeTabKey(b.id, tabId));
		if (temporary?.closing) throw new RelayError(`X2 临时标签页 ${tabId} 正在释放，请重新读取`, "NOT_FOUND", false);
		if (temporary && temporary.owner !== opened.getStore()) temporary.shared = true;
		// 后台标签页当成有焦点：不然有的页面不启动（2026-09-30：聊聊在后台标签页里不登录、不发请求）
		await attached(c, tabId, () => c.send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }));
		return tabId;
	});
	const run = <A extends readonly unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<Awaited<R>> =>
		within(b, site, () =>
			attached(c, id, async (): Promise<Awaited<R>> => {
				const challenge = sites.get(site)?.challenge;
				if (!challenge) return (await c.evalFn(id, fn, ...args)) as Awaited<R>;
				const r = await c.eval<{ x2: "challenge" } | { x2: "ok"; value: Awaited<R> }>(id, guarded(fn, args, challenge), { awaitPromise: true });
				if (r.x2 === "challenge") throw new Hit(id);
				return r.value;
			}),
		);
	return {
		browser: b.id,
		tabId: id,
		run,
		goto: (url) =>
			within(b, site, () =>
				attached(c, id, async () => {
					await pace(b, site);
					await c.navigate(id, url);
					await settle(c, id, origin, site);
					await c.eval(id, `window.name = ${JSON.stringify(MARK)}`);
				}),
			),
	};
}

export async function probe<T>(browser: string, fn: () => Promise<T>): Promise<T> {
	const tabs: number[] = [];
	try {
		return await chosen.run(browser, () => opened.run(tabs, fn));
	} catch (e) {
		if (!(e instanceof Challenge)) {
			const c = new RelayClient({ browser });
			for (const tabId of tabs) {
				const temporary = probeTabs.get(probeTabKey(browser, tabId));
				if (!temporary || temporary.shared) continue;
				temporary.closing = true;
				await c.send(tabId, "Page.close").catch(() => {});
			}
		}
		throw e;
	} finally {
		for (const tabId of tabs) probeTabs.delete(probeTabKey(browser, tabId));
	}
}

/** 这个浏览器里一个网址的 cookie（名字 → 值），不开页面：借一个已经 attach 的标签页读（cookie 整个浏览器共用）。读不了回 null */
export async function cookies(b: Browser, url: string): Promise<Map<string, string> | null> {
	const c = new RelayClient({ browser: b.id });
	for (const tab of b.attached.slice(0, 2)) {
		try {
			const r = await c.send<{ cookies: { name: string; value: string }[] }>(tab, "Network.getCookies", { urls: [url] });
			return new Map(r.cookies.map((k) => [k.name, k.value]));
		} catch {}
	}
	return null;
}

export async function hasTab(b: Browser, origin: string): Promise<boolean> {
	const tabs = await new RelayClient({ browser: b.id }).tabs({ fresh: false }).catch(() => []);
	return tabs.some((t) => t.url.startsWith(origin));
}

type Login = { value: Account | null; error: Error | null };

const memo = new Map<string, Promise<Login>>();

function loginIn(site: string, b: Browser): Promise<Login> {
	const key = `${site} ${b.id}`;
	let p = memo.get(key);
	if (!p) {
		const d = siteDef(site);
		p = (async () => {
			if (d.login.cookie && d.login.cookie.signedIn(await cookies(b, d.login.cookie.url)) === false) return null;
			return probe(b.id, d.login.identify);
		})().then(
			(value) => ({ value, error: null }),
			(error: Error) => ({ value: null, error }),
		);
		memo.set(key, p);
		const pending = p;
		void pending.then((r) => {
			if (!r.value && memo.get(key) === pending) memo.delete(key);
		});
	}
	return p;
}

/** 人点击连接后重新识别实际身份，不沿用旧身份或 cookie 的登录提示。只操作站点自己的 x2 页。 */
export async function refreshLogin(site: string, browser: string): Promise<Account | null> {
	const d = siteDef(site);
	const key = `${site} ${browser}`;
	memo.delete(key);
	routes.delete(site);
	try {
		const value = await probe(browser, d.login.identify);
		if (value) memo.set(key, Promise.resolve({ value, error: null }));
		return value;
	} catch (e) {
		memo.delete(key);
		throw e;
	}
}

export function canOpenVerification(site: string, browser: string): Promise<boolean> {
	return verification.canOpen(site, browser, (url) => verificationUrl(site, url), { tabs: (id) => new RelayClient({ browser: id }).tabs() });
}

function verificationUrl(site: string, raw: string): boolean {
	const url = new URL(raw);
	const d = siteDef(site);
	return ["https:", "http:"].includes(url.protocol) && (d.hosts(url.hostname) || d.challenge?.url(url.href) === true);
}

/** 用户明确点击后只聚焦已知验证页，不导航、不另开站点页面。 */
export async function focusVerification(site: string, browser: string, driver?: VerificationDriver): Promise<void> {
	siteDef(site);
	await verification.focus(
		site,
		browser,
		(url) => verificationUrl(site, url),
		driver ?? {
			tabs: (id) => new RelayClient({ browser: id }).tabs(),
			focus: async (id, tabId) => {
				const c = new RelayClient({ browser: id });
				await attached(c, tabId, () => c.send(tabId, "Page.bringToFront"));
			},
		},
	);
}

/** 绑定只决定核对顺序，不把历史授权当成实际登录身份。 */
export function setAccountBrowserPreference(site: string, account: Account, browserId: string): void {
	siteDef(site);
	if (!account.id || !browserId) throw new Usage("账号与浏览器标识不能为空");
	for (const name of new Set([account.id, account.name].filter(Boolean))) accountBrowsers.set(JSON.stringify([site, name]), browserId);
}

export async function browserName(id: string): Promise<string> {
	const b = (await browsers()).find((x) => x.id === id);
	for (const d of allSites().filter((x) => x.login.each)) {
		const a = b ? (await loginIn(d.key, b)).value : null;
		if (a?.name) return a.name;
	}
	return b?.label || id.slice(0, 8);
}

export async function logins(site: string): Promise<{ browser: string; account: Account }[]> {
	const all = await browsers();
	const found = await Promise.all(all.map((b) => loginIn(site, b)));
	return all.flatMap((b, i) => (found[i]!.value ? [{ browser: b.id, account: found[i]!.value! }] : []));
}

export type Found = { id: string; name: string; login: boolean; error?: Error | null };

export function choose(site: string, found: Found[]): string {
	const d = siteDef(site);
	const logged = found.filter((f) => f.login);
	if (logged.length === 1 || (logged.length > 1 && !d.login.each)) return logged[0]!.id;
	if (logged.length > 1)
		throw new Usage(`连着 ${logged.length} 个登录着 ${d.title} 的浏览器，用 --${d.login.each!.flag} 选一个：${logged.map((f) => f.name).join("、")}`);
	throw (
		found.map((f) => f.error).find((e) => e instanceof Challenge) ??
		new NeedsHuman(`没有登录着 ${d.title} 的浏览器：打开登录着它的浏览器（或在 Ego 里登录 ${d.title}），确认 CDP 扩展已连接`)
	);
}

async function openFirst(all: Browser[], origin: string): Promise<Browser[]> {
	const open = await Promise.all(all.map((b) => hasTab(b, origin)));
	return [...all.filter((_, i) => open[i]), ...all.filter((_, i) => !open[i])];
}

async function route(site: string): Promise<string> {
	const d = siteDef(site);
	const all = await browsers();
	const found: Found[] = [];
	const name = (b: Browser, a: Account | null) => a?.name || a?.id || b.label || b.id.slice(0, 8);
	if (d.login.each) {
		for (const [i, r] of (await Promise.all(all.map((b) => loginIn(site, b)))).entries())
			found.push({ id: all[i]!.id, name: name(all[i]!, r.value), login: r.value !== null, error: r.error });
		return choose(site, found);
	}
	if (d.login.cookie) {
		const sure: Browser[] = [],
			unsure: Browser[] = [];
		for (const b of all) {
			const known = memo.get(`${site} ${b.id}`);
			if (known) {
				const r = await known;
				if (r.value) sure.push(b);
				else found.push({ id: b.id, name: b.label, login: false, error: r.error });
				continue;
			}
			const c = d.login.cookie.signedIn(await cookies(b, d.login.cookie.url));
			if (c === true) sure.push(b);
			else if (c === null) unsure.push(b);
		}
		if (sure.length > 1) console.error(`登录着 ${d.title} 的浏览器有 ${sure.length} 个，用 ${await browserName(sure[0]!.id)} 的；要用别的，设 X2_BROWSER`);
		if (sure.length) return sure[0]!.id;
		for (const b of unsure) {
			const r = await loginIn(site, b);
			found.push({ id: b.id, name: b.label, login: r.value !== null, error: r.error });
			if (r.value) break;
		}
		return choose(site, found);
	}
	for (const b of await openFirst(all, d.origin)) {
		const r = await loginIn(site, b);
		found.push({ id: b.id, name: b.label, login: r.value !== null, error: r.error });
		if (r.value) break;
	}
	return choose(site, found);
}

const routes = new Map<string, Promise<string>>();

export function browserFor(site: string): Promise<string> {
	let p = routes.get(site);
	if (!p) {
		p = route(site);
		routes.set(site, p);
		p.catch(() => routes.delete(site));
	}
	return p;
}

export async function challengeIn(site: string): Promise<Challenge | undefined> {
	const all = await Promise.all((await browsers()).map((b) => loginIn(site, b)));
	return all.map((r) => r.error).find((e): e is Challenge => e instanceof Challenge);
}

export async function inAccount<T>(site: string, account: string, fn: () => Promise<T>): Promise<T> {
	const d = siteDef(site);
	const errors: (Error | null)[] = [];
	const seen: Account[] = [];
	const all = await browsers();
	const preferred = accountBrowsers.get(JSON.stringify([site, account]));
	const ordered = preferred ? [...all.filter((b) => b.id === preferred), ...all.filter((b) => b.id !== preferred)] : all;
	for (const b of ordered) {
		const r = await loginIn(site, b);
		if (r.value && (r.value.id === account || r.value.name === account)) return using(b.id, fn);
		if (r.value) seen.push(r.value);
		errors.push(r.error);
	}
	const challenge = errors.find((e) => e instanceof Challenge);
	if (challenge) throw challenge;
	// 失败不缓存后，不能为了拼提示再探测一遍所有浏览器。
	const now = seen.map((a) => a.name || a.id);
	throw new NeedsHuman(
		`没有登录着 ${d.title} ${account} 的浏览器：打开对应浏览器，登录 ${d.title}，确认 CDP 扩展已连接（现在登录着的：${now.join("、") || "没有"}）`,
	);
}
