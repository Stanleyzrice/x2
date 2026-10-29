// 唯一碰 cdp-relay 的地方：在运营登录着的 Chrome 里，用 x2 自己开的标签页做事，不碰她正在用的标签页。
// 一个站点（origin）一个标签页，标签页的 window.name 是记号，下次按记号找回来。页面自己带着登录态（cookie），所以请求在页面里发。
// 在哪个浏览器里做（一家店一个浏览器）：using() 指定的（按店、按 1688 账号找浏览器的代码用它，见 accounts.ts）；没指定的用 X2_BROWSER
// （浏览器在 cdp-relay 里的 id 或名字）；也没设的，只连着一个就用它，连着几个就按登录选（accounts.ts 的 browserFor：Shopee 按店，
// 1688、知虾、chanboss 用登录着的那个）。
// 几个 x2 进程同时跑：同一个浏览器的同一个站点一次只让一个进程用（lock.ts 的锁，用完 2 秒没再用就放），1688 的页面两次加载之间隔 3 秒。
// 认登录时开的标签页，没认出就关掉（probe）；跳到别的网站的登录页的标签页 x2 以后找不回来，也关掉，不留下。
// 1688 跳了滑块验证（整页跳到验证页，或页面上弹出验证框）：认出来就停，抛 Challenge，不等到超时
import { AsyncLocalStorage } from "node:async_hooks";
import { RelayClient } from "@wuwe1/cdp-relay";
import { Challenge, NeedsHuman, Usage } from "../core/errors.ts";
import { acquire, type Lock, spaced } from "../core/lock.ts";

const MARK = "x2";
/** 一个站点用完多久没再用就放锁（让别的进程用） */
const GRACE_MS = 2000;

export type Page = {
	/** 这个标签页在哪个浏览器里（cdp-relay 里的 id） */
	readonly browser: string;
	/** 在页面里调用一个函数：fn 要自给自足（不引用外面的变量），参数经 JSON 传进去 */
	run<A extends readonly unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<Awaited<R>>;
	/** 导航到一个地址，等到页面加载完 */
	goto(url: string): Promise<void>;
};

/** 连着的浏览器：id、名字（cdp-relay 扩展里起的，可能是空的）、已经 attach 的标签页 */
export type Browser = { id: string; label: string; attached: number[] };

/** x2 的站点：没指定浏览器时按登录着它选浏览器；几个进程按「浏览器 × 站点」排队 */
export type Site = "shopee" | "1688" | "chanboss" | "zhixia";
export const SITE_NAMES: Record<Site, string> = { shopee: "Shopee 卖家中心", "1688": "1688", chanboss: "chanboss", zhixia: "知虾" };
/** 各站点的首页（认登录、看浏览器里有没有开着它） */
export const SITE_ORIGINS: Record<Site, string> = {
	shopee: "https://seller.shopee.tw",
	"1688": "https://www.1688.com",
	chanboss: "https://c.chanboss.com",
	zhixia: "https://shopee.mobduos.com",
};
/** 页面两次加载之间至少隔多久（几个进程一起算）：1688 读得太密跳滑块验证 */
const PACE_MS: Partial<Record<string, number>> = { "1688": 3000 };

/** 网址是哪个站点（纯函数）；不认识的回 null */
export function siteOf(url: string): Site | null {
	const host = new URL(url).hostname;
	if (host === "seller.shopee.tw") return "shopee";
	if (host === "1688.com" || host.endsWith(".1688.com")) return "1688";
	if (host === "c.chanboss.com") return "chanboss";
	if (host === "shopee.mobduos.com") return "zhixia";
	return null;
}

/** 页面上看得到的（在页面里收集，给 challengeOf 判） */
export type Look = { url: string; frames: string[]; slider: boolean; text: string };

/** 阿里系风控（1688）的滑块验证（纯函数，也整个放进页面里跑：不引用外面的东西）。认这几样：
 * 页面、或页面上看得见的 iframe 落在验证页（/_____tmd_____/punish，2026-10-10 三个 agent 同时搜 1688 时落到的：整页跳到
 * s.1688.com//selloffer/offer_search.htm/_____tmd_____/punish?x5secdata=…，或页面上弹一层，iframe 是 h5api.m.1688.com/…/_____tmd_____/punish?…）；
 * 页面上有看得见的滑块（#nc_1_wrapper、.nc_wrapper、.baxia-dialog）；整页字很少、写着拖动滑块、通过验证以确保正常访问（登录页上的滑块不算）。
 * 没登录时跳转经过的 /_____tmd_____/page/login_jump 不算 */
export function challengeOf(p: Look): boolean {
	const punish = (u: string) => /\/_____tmd_____\/punish/.test(u);
	if (punish(p.url) || p.frames.some(punish) || p.slider) return true;
	return p.text.length > 0 && p.text.length <= 2000 && /拖动.{0,8}滑块|滑块验证|通过验证以确保正常访问/.test(p.text) && !/登录|登陆|密码/.test(p.text);
}

/** 在页面里收集 challengeOf 要看的（整个放进页面里跑）：地址、看得见的 iframe 的地址、看得见的滑块、整页的字（页面小才取） */
export function look(): Look {
	const shown = (el: Element) => {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	};
	const body = document.body;
	return {
		url: location.href,
		frames: Array.from(document.querySelectorAll("iframe"))
			.filter(shown)
			.map((f) => f.src),
		slider: Array.from(document.querySelectorAll("#nc_1_wrapper, .nc_wrapper, .baxia-dialog")).some(shown),
		text: body && (body.textContent ?? "").length < 20000 ? body.innerText.slice(0, 5000) : "",
	};
}

/** 站点没登录时跳去的登录页（纯函数）：主机名是 login.、passport.、signin.、account(s). 开头的，或路径里有 login、signin、passport */
export function loginPage(url: string): boolean {
	const u = new URL(url);
	return /^(login|passport|signin|accounts?)\./i.test(u.hostname) || /\/(login|signin|passport)/i.test(u.pathname);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chosen = new AsyncLocalStorage<string>();

/** 在这个浏览器（cdp-relay 里的 id）里做 fn：fn 里的 page() 都开在它里面 */
export const using = <T>(browser: string, fn: () => Promise<T>): Promise<T> => chosen.run(browser, fn);

/** 连着的浏览器 */
export async function browsers(): Promise<Browser[]> {
	const all = await new RelayClient({}).browsers().catch(() => {
		throw new NeedsHuman("连不上 cdp-relay：Chrome 开着吗？扩展连上了吗？");
	});
	return all.map((b) => ({ id: b.id, label: b.label, attached: b.attached ?? [] }));
}

/** 给人看的浏览器（扩展里没起名字的用 id 的前 8 位） */
const short = (b: Browser) => b.label || b.id.slice(0, 8);

/** 这个 origin 在哪个浏览器里做：using() 指定的 → X2_BROWSER → 只连着一个就是它 → 按登录选 */
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
	// 按登录选：accounts.ts 认每个浏览器里登录着什么（它也用这个文件：互相引，所以到用时才 import）
	const { browserFor } = await import("./accounts.ts");
	const id = await browserFor(site);
	const b = all.find((x) => x.id === id);
	if (!b) throw new NeedsHuman(`浏览器 ${id} 刚断开了：确认 cdp-relay 扩展已连接再试`);
	return b;
}

// ── 排队：同一个浏览器的同一个站点，一次一个进程 ──
// 一个进程里同时用的（几件事一起做）共用这个进程拿到的锁；都用完了 2 秒没人再用就放

type Lease = { lock: Lock | null; active: number; idle: NodeJS.Timeout | null; wait: Promise<void> | null };
const leases = new Map<string, Lease>();

/** 开始用这个浏览器的这个站点：这个进程还没拿着锁就去拿（别的进程在用就等）；回「用完了」 */
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

/** 页面里认出了滑块验证（只在这个文件里用：放开锁以后再换成说清楚是哪个浏览器的 Challenge） */
class Hit extends Error {}

/** 1688 跳了滑块验证：说清楚在哪个浏览器里拉（按登录着的店叫它，例 cheeroutdoor） */
export async function challenge(browser: string): Promise<Challenge> {
	const { browserName } = await import("./accounts.ts");
	const name = await browserName(browser).catch(() => browser.slice(0, 8));
	return new Challenge(`1688 要过滑块验证：在 ${name} 的浏览器里拉一下再重试`);
}

/** 拿着这个浏览器这个站点的锁做 fn；认出滑块验证的，放开锁以后再说是哪个浏览器（叫它的名字要读 Shopee） */
async function within<T>(b: Browser, site: string, fn: () => Promise<T>): Promise<T> {
	const exit = await enter(b, site);
	try {
		return await fn();
	} catch (e) {
		if (!(e instanceof Hit)) throw e;
	} finally {
		exit();
	}
	throw await challenge(b.id);
}

/** 在这个站点一口气做完 fn（按 origin 选浏览器）：做的时候一直拿着锁，别的 x2 进程等着（例 知虾的限流要在锁里算）；fn 里的 page() 都在这个浏览器里 */
export async function hold<T>(origin: string, fn: () => Promise<T>): Promise<T> {
	const b = await pick(origin);
	return within(b, siteOf(origin) ?? new URL(origin).host, () => chosen.run(b.id, fn));
}

/** 页面加载前：这个站点要隔开的，离上一次加载（几个进程一起算）不够就等 */
async function pace(b: Browser, site: string): Promise<void> {
	const gap = PACE_MS[site];
	if (gap) await spaced(`${b.id}-${site}`, gap);
}

/** 等页面加载完（加载完、地址也不再变）。1688 落到验证页就停（Hit）；
 * 跳到了别的网站的登录页（没登录）：这个标签页 x2 以后按网址找不回来，关掉，要人登录 */
async function settle(c: RelayClient, tabId: number, origin: string, site: string, timeoutMs = 30_000): Promise<void> {
	const until = Date.now() + timeoutMs;
	let last = "";
	for (;;) {
		const s = await c.eval<{ state: string; url: string }>(tabId, "({ state: document.readyState, url: location.href })").catch(() => null);
		if (s && site === "1688" && challengeOf({ url: s.url, frames: [], slider: false, text: "" })) throw new Hit();
		if (s?.state === "complete" && s.url === last) break;
		last = s?.state === "complete" ? s.url : "";
		if (Date.now() > until) throw new Error(`页面 ${timeoutMs / 1000} 秒还没加载完`);
		await sleep(300);
	}
	if (new URL(last).origin !== origin && loginPage(last)) {
		await c.send(tabId, "Page.close").catch(() => {});
		const known = siteOf(origin);
		throw new NeedsHuman(`${known ? SITE_NAMES[known] : new URL(origin).host} 没有登录（跳到了 ${new URL(last).host} 的登录页）：在浏览器里登录再试`);
	}
}

/** 1688 的页面里跑 fn 的表达式：先看有没有滑块验证（有就不跑），跑的时候每 0.5 秒再看（验证框弹出来就不等 fn 了）。
 * 回 { x2: "challenge" } 或 { x2: "ok", value } */
export function guarded(fn: (...args: any[]) => unknown, args: readonly unknown[]): string {
	const call = `(${fn.toString()})(${args.map((a) => JSON.stringify(a) ?? "undefined").join(",")})`;
	return `(async () => {
		const look = ${look.toString()};
		const challengeOf = ${challengeOf.toString()};
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

/** 认登录时开的标签页（probe 里）：没认出就关掉 */
const opened = new AsyncLocalStorage<number[]>();
/** 同一个进程里同时找同一个标签页的，等同一次（别开两个） */
const finding = new Map<string, Promise<number>>();

/** 这个 origin 的 x2 标签页：有就用，没有就在后台开一个（不抢前台） */
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

/** 这个 origin 的 x2 标签页 */
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
			if (site !== "1688") return (await c.evalFn(id, fn, ...args)) as Awaited<R>;
			const r = await c.eval<{ x2: "challenge" } | { x2: "ok"; value: Awaited<R> }>(id, guarded(fn, args), { awaitPromise: true });
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

/** 认登录：在这个浏览器里做 fn；fn 里开的标签页，fn 没成（没登录、出错）就关掉，不留下。
 * 跳了滑块验证的不关：人要在那个标签页里拉（它还在这个站点上，下次 x2 找得回来，不会越开越多） */
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
		} catch {
			/* 这个标签页不行了（关了、换了页），换一个 */
		}
	}
	return null;
}

/** 这个浏览器里开着这个 origin 的标签页没有（谁开的都算） */
export async function hasTab(b: Browser, origin: string): Promise<boolean> {
	const tabs = await new RelayClient({ browser: b.id }).tabs({ fresh: false }).catch(() => []);
	return tabs.some((t) => t.url.startsWith(origin));
}
