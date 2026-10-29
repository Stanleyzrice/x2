// 唯一碰 cdp-relay 的地方：在运营登录着的 Chrome 里，用 x2 自己开的标签页做事，不碰她正在用的标签页。
// 一个站点（origin）一个标签页，标签页的 window.name 是记号，下次按记号找回来。页面自己带着登录态（cookie），所以请求在页面里发。
// 站点由连接器注册（SiteDef：首页、主机名、怎么认登录、要不要隔开、怎么认人机验证），这里不认具体站点。
// 在哪个浏览器里做（一家店一个浏览器）：using() 指定的（按账号找浏览器的 inAccount 用它）；没指定的用 X2_BROWSER
// （浏览器在 cdp-relay 里的 id 或名字）；也没设的，只连着一个就用它，连着几个就按登录选（browserFor）。
// 几个 x2 进程同时跑：同一个浏览器的同一个站点一次只让一个进程用（lock.ts 的锁，用完 2 秒没再用就放），要隔开的站点两次加载之间隔开。
// 认登录时开的标签页，没认出就关掉（probe）；跳到别的网站的登录页的标签页 x2 以后找不回来，也关掉，不留下。
// 注册了人机验证的站点跳了验证（例 整页跳到验证页，或页面上弹出验证框）：认出来就停，抛 Challenge，不等到超时
// 按登录找浏览器：一家店一个浏览器（Chrome 的不同用户），别的站点登录在其中一个里。站点怎么认登录由连接器注册（SiteDef.login）。
// 每个连着的浏览器登录着什么都是现读，不存库；一个进程里每个浏览器、每个站点只认一次（开标签页、读接口都要时间）。
// 认的时候开的标签页，没登录的关掉（probe）；站点给了 cookie 的先看 cookie，明说没登录的不开页面。
// 没在 using() 里、也没设 X2_BROWSER 的读写，pick 按站点来问 browserFor：要人选的站点（each，例 Shopee 按店）连着几个时要给 --shop，
// 别的用登录着的那个
import { AsyncLocalStorage } from "node:async_hooks";
import { RelayClient } from "@wuwe1/cdp-relay";
import { Challenge, NeedsHuman, Usage } from "../errors.ts";
import { acquire, type Lock, spaced } from "./lock.ts";

const MARK = "x2";
const GRACE_MS = 2000;

export type Page = {
	readonly browser: string;
	/** 在页面里调用一个函数：fn 要自给自足（不引用外面的变量），参数经 JSON 传进去 */
	run<A extends readonly unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<Awaited<R>>;
	goto(url: string): Promise<void>;
};

export type Browser = { id: string; label: string; attached: number[] };

/** 认人机验证：look、seen 要自给自足（整个放进页面里跑） */
export type Challenger = { look: () => unknown; seen: (l: any) => boolean; url: (url: string) => boolean };

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
		throw new NeedsHuman("连不上 cdp-relay：Chrome 开着吗？扩展连上了吗？");
	});
	return all.map((b) => ({ id: b.id, label: b.label, attached: b.attached ?? [] }));
}

const short = (b: Browser) => b.label || b.id.slice(0, 8);

async function pick(origin: string): Promise<Browser> {
	const all = await browsers();
	if (all.length === 0) throw new NeedsHuman("没有连上的浏览器：打开 Chrome，确认 cdp-relay 扩展已连接");
	const want = chosen.getStore() ?? process.env.X2_BROWSER;
	if (want) {
		const b = all.find((x) => x.id === want || x.label === want);
		if (!b) throw new NeedsHuman(`浏览器 ${want} 没有连着：打开它，确认 cdp-relay 扩展已连接`);
		return b;
	}
	if (all.length === 1) return all[0]!;
	const site = siteOf(origin);
	if (!site) throw new Usage(`连着 ${all.length} 个浏览器，用 X2_BROWSER 选一个：${all.map(short).join("、")}`);
	const id = await browserFor(site);
	const b = all.find((x) => x.id === id);
	if (!b) throw new NeedsHuman(`浏览器 ${id} 刚断开了：确认 cdp-relay 扩展已连接再试`);
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

class Hit extends Error {}

export async function challenge(browser: string, site: string): Promise<Challenge> {
	const name = await browserName(browser).catch(() => browser.slice(0, 8));
	return new Challenge(`${sites.get(site)?.title ?? site} 要过滑块验证：在 ${name} 的浏览器里拉一下再重试`);
}

async function within<T>(b: Browser, site: string, fn: () => Promise<T>): Promise<T> {
	const exit = await enter(b, site);
	try {
		return await fn();
	} catch (e) {
		if (!(e instanceof Hit)) throw e;
	} finally {
		exit();
	}
	throw await challenge(b.id, site);
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
		if (s && sites.get(site)?.challenge?.url(s.url)) throw new Hit();
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

export function guarded(fn: (...args: any[]) => unknown, args: readonly unknown[], challenge: Challenger): string {
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

async function tabFor(c: RelayClient, b: Browser, origin: string, site: string): Promise<number> {
	for (const t of (await c.tabs()).filter((t) => t.url.startsWith(origin))) {
		await c.attach(t.tabId);
		if ((await c.eval<string>(t.tabId, "window.name")) === MARK) return t.tabId;
	}
	await pace(b, site);
	const tab = await c.openTab(origin);
	opened.getStore()?.push(tab.tabId);
	await c.attach(tab.tabId);
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
		// 后台标签页当成有焦点：不然有的页面不启动（2026-09-30：聊聊在后台标签页里不登录、不发请求）
		await c.send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
		return tabId;
	});
	const run = <A extends readonly unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<Awaited<R>> =>
		within(b, site, async (): Promise<Awaited<R>> => {
			const challenge = sites.get(site)?.challenge;
			if (!challenge) return (await c.evalFn(id, fn, ...args)) as Awaited<R>;
			const r = await c.eval<{ x2: "challenge" } | { x2: "ok"; value: Awaited<R> }>(id, guarded(fn, args, challenge), { awaitPromise: true });
			if (r.x2 === "challenge") throw new Hit();
			return r.value;
		});
	return {
		browser: b.id,
		run,
		goto: (url) =>
			within(b, site, async () => {
				await pace(b, site);
				await c.navigate(id, url);
				await settle(c, id, origin, site);
				await c.eval(id, `window.name = ${JSON.stringify(MARK)}`);
			}),
	};
}

export async function probe<T>(browser: string, fn: () => Promise<T>): Promise<T> {
	const tabs: number[] = [];
	try {
		return await chosen.run(browser, () => opened.run(tabs, fn));
	} catch (e) {
		if (!(e instanceof Challenge)) {
			const c = new RelayClient({ browser });
			for (const t of tabs) await c.send(t, "Page.close").catch(() => {});
		}
		throw e;
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
	}
	return p;
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
		new NeedsHuman(`没有登录着 ${d.title} 的浏览器：打开登录着它的 Chrome（或在浏览器里登录 ${d.title}），确认 cdp-relay 扩展已连接`)
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
	for (const b of await browsers()) {
		const r = await loginIn(site, b);
		if (r.value && (r.value.id === account || r.value.name === account)) return using(b.id, fn);
		errors.push(r.error);
	}
	const challenge = errors.find((e) => e instanceof Challenge);
	if (challenge) throw challenge;
	const now = (await logins(site)).map((l) => l.account.name || l.account.id);
	throw new NeedsHuman(
		`没有登录着 ${d.title} ${account} 的浏览器：打开那个 Chrome，登录 ${d.title}，确认 cdp-relay 扩展已连接（现在登录着的：${now.join("、") || "没有"}）`,
	);
}
