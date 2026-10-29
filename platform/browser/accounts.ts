// 按登录找浏览器：一家店一个浏览器（Chrome 的不同用户），别的站点登录在其中一个里。站点怎么认登录由连接器注册（browser.ts 的 SiteDef.login）。
// 每个连着的浏览器登录着什么都是现读，不存库；一个进程里每个浏览器、每个站点只认一次（开标签页、读接口都要时间）。
// 认的时候开的标签页，没登录的关掉（browser.ts 的 probe）；站点给了 cookie 的先看 cookie，明说没登录的不开页面。
// 没在 using() 里、也没设 X2_BROWSER 的读写，browser.ts 按站点来问 browserFor：要人选的站点（each，例 Shopee 按店）连着几个时要给 --shop，
// 别的用登录着的那个
import { Challenge, NeedsHuman, Usage } from "../errors.ts";
import { type Account, allSites, type Browser, browsers, cookies, hasTab, probe, siteDef, using } from "./browser.ts";

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
