// 按登录找浏览器：一家店一个浏览器（Chrome 的不同用户），1688、知虾、chanboss 登录在其中一个里。
// 每个连着的浏览器登录着什么都是现读，不存库；一个进程里每个浏览器、每个站点只认一次（开标签页、读接口都要时间）。
// Shopee 按店铺 id 认，1688 按账号（userId）认。认的时候开的标签页，没登录的关掉（browser.ts 的 probe）；
// 1688 先看 cookie（__cn_logon__），明说没登录的不开页面。
// 没在 using() 里、也没设 X2_BROWSER 的读写，browser.ts 按站点来问 browserFor：Shopee 按店（连着几家店时要给 --shop），
// 1688、知虾、chanboss 用登录着的那个

import { account as alibabaAccount } from "../../connectors/sites/1688/api.ts";
import { identity as chanbossIdentity } from "../../connectors/sites/chanboss/api.ts";
import { shop as shopeeShop } from "../../connectors/sites/shopee/seller.ts";
import { categories as zhixiaCategories } from "../../connectors/sites/zhixia/api.ts";
import type { Sql } from "../db/index.ts";
import { Challenge, NeedsHuman, Usage } from "../errors.ts";
import { type Browser, browsers, cookies, hasTab, probe, SITE_NAMES, SITE_ORIGINS, type Site, using } from "./browser.ts";

type Shop = Awaited<ReturnType<typeof shopeeShop>>;
type Alibaba = { userId: string; loginId: string };
type Seen = { browser: string; label: string; shop: Shop | null; alibaba: string | null; loginId: string | null };

/** 认一次的结果：登录着的（没登录是 null）；没认出来的原因 */
type Login<T> = { value: T | null; error: Error | null };

const memo = new Map<string, Promise<Login<unknown>>>();
function once<T>(key: string, fn: () => Promise<T | null>): Promise<Login<T>> {
	let p = memo.get(key) as Promise<Login<T>> | undefined;
	if (!p) {
		p = fn().then(
			(value) => ({ value, error: null }),
			(error: Error) => ({ value: null, error }),
		);
		memo.set(key, p);
	}
	return p;
}

/** 1688 的 cookie __cn_logon__ 说登录着没有（纯函数）：true、false；没有这个 cookie（读不了、没去过 1688）是 null */
export function alibabaCookie(jar: Map<string, string> | null): boolean | null {
	const v = jar?.get("__cn_logon__");
	return v === "true" ? true : v === "false" ? false : null;
}

const shopIn = (b: Browser) => once<Shop>(`shopee ${b.id}`, () => probe(b.id, () => shopeeShop()));
const alibabaIn = (b: Browser) =>
	once<Alibaba>(`1688 ${b.id}`, async () =>
		alibabaCookie(await cookies(b, `${SITE_ORIGINS["1688"]}/`)) === false ? null : probe(b.id, () => alibabaAccount()),
	);
const signedIn: Record<"chanboss" | "zhixia", (b: Browser) => Promise<Login<true>>> = {
	chanboss: (b) =>
		once<true>(`chanboss ${b.id}`, async () => {
			await probe(b.id, () => chanbossIdentity());
			return true;
		}),
	zhixia: (b) =>
		once<true>(`zhixia ${b.id}`, async () => {
			await probe(b.id, () => zhixiaCategories());
			return true;
		}),
};

/** 给人看的浏览器名字：登录着的店的账号名（例 cheeroutdoor）；没登录 Shopee 的用扩展里起的名字，或 id 的前 8 位 */
export async function browserName(id: string): Promise<string> {
	const b = (await browsers()).find((x) => x.id === id);
	const s = b ? (await shopIn(b)).value : null;
	return s?.username || b?.label || id.slice(0, 8);
}

let seen: Promise<Seen[]> | null = null;

/** 每个连着的浏览器里登录着哪家店、哪个 1688 账号（没登录的是 null） */
export function scan(): Promise<Seen[]> {
	seen ??= browsers().then((all) =>
		Promise.all(
			all.map(async (b): Promise<Seen> => {
				const shop = (await shopIn(b)).value;
				const a = (await alibabaIn(b)).value;
				return { browser: b.id, label: b.label, shop, alibaba: a?.userId ?? null, loginId: a?.loginId ?? null };
			}),
		),
	);
	return seen;
}

/** 一个浏览器认出来的样子（给 choose 选）：给人看的名字、登录着没有、没认出来的原因 */
export type Found = { id: string; name: string; login: boolean; error?: Error | null };

/** 按登录选浏览器（纯函数）：只有一个登录着的就用它；几个都登录着：Shopee 要人用 --shop 选一家，别的站点用第一个；
 * 一个都没有：有跳了滑块验证的说它，不然要人登录 */
export function choose(site: Site, found: Found[]): string {
	const logged = found.filter((f) => f.login);
	if (logged.length === 1 || (logged.length > 1 && site !== "shopee")) return logged[0]!.id;
	if (logged.length > 1) throw new Usage(`连着 ${logged.length} 家店的浏览器，用 --shop 选一家：${logged.map((f) => f.name).join("、")}`);
	throw (
		found.map((f) => f.error).find((e) => e instanceof Challenge) ??
		new NeedsHuman(`没有登录着 ${SITE_NAMES[site]} 的浏览器：打开登录着它的 Chrome（或在浏览器里登录 ${SITE_NAMES[site]}），确认 cdp-relay 扩展已连接`)
	);
}

/** 浏览器排个序：开着这个 origin 的标签页的在前（多半就是登录着的那个，认它不用开新标签页） */
async function openFirst(all: Browser[], origin: string): Promise<Browser[]> {
	const open = await Promise.all(all.map((b) => hasTab(b, origin)));
	return [...all.filter((_, i) => open[i]), ...all.filter((_, i) => !open[i])];
}

async function route(site: Site): Promise<string> {
	const all = await browsers();
	const found: Found[] = [];
	if (site === "shopee") {
		for (const [i, r] of (await Promise.all(all.map(shopIn))).entries()) {
			found.push({
				id: all[i]!.id,
				name: r.value?.username || r.value?.shopId || all[i]!.label || all[i]!.id.slice(0, 8),
				login: r.value !== null,
				error: r.error,
			});
		}
		return choose(site, found);
	}
	if (site === "1688") {
		// 这个进程认过的照认过的；没认过的先看 cookie：说登录着的直接用（不开页面），说没登录的跳过，看不出的再开页面认
		const sure: Browser[] = [],
			unsure: Browser[] = [];
		for (const b of all) {
			const known = memo.get(`1688 ${b.id}`) as Promise<Login<Alibaba>> | undefined;
			if (known) {
				const r = await known;
				if (r.value) sure.push(b);
				else found.push({ id: b.id, name: b.label, login: false, error: r.error });
				continue;
			}
			const c = alibabaCookie(await cookies(b, `${SITE_ORIGINS["1688"]}/`));
			if (c === true) sure.push(b);
			else if (c === null) unsure.push(b);
		}
		if (sure.length > 1) console.error(`登录着 1688 的浏览器有 ${sure.length} 个，用 ${await browserName(sure[0]!.id)} 的；要用别的，设 X2_BROWSER`);
		if (sure.length) return sure[0]!.id;
		for (const b of unsure) {
			const r = await alibabaIn(b);
			found.push({ id: b.id, name: b.label, login: r.value !== null, error: r.error });
			if (r.value) break;
		}
		return choose(site, found);
	}
	// 知虾、chanboss：认到一个登录着的就用
	for (const b of await openFirst(all, SITE_ORIGINS[site])) {
		const r = await signedIn[site](b);
		found.push({ id: b.id, name: b.label, login: r.value !== null, error: r.error });
		if (r.value) break;
	}
	return choose(site, found);
}

const routes = new Map<Site, Promise<string>>();

/** 没指定浏览器时这个站点用哪个浏览器（一个进程认一次，见 choose） */
export function browserFor(site: Site): Promise<string> {
	let p = routes.get(site);
	if (!p) {
		p = route(site);
		routes.set(site, p);
		p.catch(() => routes.delete(site));
	}
	return p;
}

/** 在连着的浏览器里按顺序认，找第一个合 match 的；找不到：有跳了滑块验证的抛它，不然要人处理（missing） */
async function find<T>(check: (b: Browser) => Promise<Login<T>>, match: (v: T) => boolean, missing: string): Promise<Browser> {
	const errors: (Error | null)[] = [];
	for (const b of await browsers()) {
		const r = await check(b);
		if (r.value !== null && match(r.value)) return b;
		errors.push(r.error);
	}
	throw errors.find((e) => e instanceof Challenge) ?? new NeedsHuman(missing);
}

/** 在登录着这家店（店铺 id）的浏览器里做 fn */
export async function inShop<T>(shopId: string, fn: () => Promise<T>): Promise<T> {
	const b = await find(
		shopIn,
		(s) => s.shopId === shopId,
		`没有登录着店铺 ${shopId} 的浏览器：打开这家店的 Chrome，登录 Shopee 卖家中心，确认 cdp-relay 扩展已连接`,
	);
	return using(b.id, fn);
}

/** 在登录着这家店的浏览器里做 fn：name 是账号名（例 ni1206），也可以给店铺 id（x2 shopee <操作> --shop） */
export async function inShopNamed<T>(name: string, fn: () => Promise<T>): Promise<T> {
	const b = await find(
		shopIn,
		(s) => s.username === name || s.shopId === name,
		`没有登录着 ${name} 的浏览器：打开这家店的 Chrome，登录 Shopee 卖家中心，确认 cdp-relay 扩展已连接`,
	).catch(async (e) => {
		if (!(e instanceof NeedsHuman) || e instanceof Challenge) throw e;
		const shops = (await Promise.all((await browsers()).map(shopIn))).flatMap((r) => (r.value ? [r.value.username || r.value.shopId] : []));
		throw new NeedsHuman(`${e.message}（现在登录着的店：${shops.join("、") || "没有"}）`);
	});
	return using(b.id, fn);
}

/** 登录着的 1688 账号：userId、会员名 */
export async function alibabaAccounts(): Promise<{ userId: string; loginId: string }[]> {
	const out = new Map<string, string>();
	for (const r of await Promise.all((await browsers()).map(alibabaIn))) if (r.value) out.set(r.value.userId, r.value.loginId || r.value.userId);
	return [...out].map(([userId, loginId]) => ({ userId, loginId }));
}

/** 认 1688 账号时出的错里，有跳了滑块验证的就是它（没认出账号的原因，比「没有登录」准） */
async function alibabaChallenge(): Promise<Challenge | undefined> {
	const all = await Promise.all((await browsers()).map(alibabaIn));
	return all.map((r) => r.error).find((e): e is Challenge => e instanceof Challenge);
}

/** 采购账号（订单设置里写的会员名）现在登录着的 userId；没设是 null，设了没登录要人处理 */
export async function buyAccount(sql: Sql): Promise<{ userId: string; loginId: string } | null> {
	const [s] = await sql`select buy_account from order_settings where id = 1`;
	const name = s?.buy_account as string | null;
	if (!name) return null;
	const a = (await alibabaAccounts()).find((x) => x.loginId === name || x.userId === name);
	if (!a) throw (await alibabaChallenge()) ?? new NeedsHuman(`采购账号「${name}」没有登录：在浏览器里登录这个 1688 账号，确认 cdp-relay 扩展已连接`);
	return a;
}

/** 在登录着这个 1688 账号（userId）的浏览器里做 fn */
export async function in1688<T>(account: string, fn: () => Promise<T>): Promise<T> {
	const b = await find(
		alibabaIn,
		(a) => a.userId === account,
		`没有登录着 1688 账号 ${account} 的浏览器：打开那个 Chrome，登录 1688，确认 cdp-relay 扩展已连接`,
	);
	return using(b.id, fn);
}

/** Shopee 店铺 id → 账号名（ni1206、cheeroutdoor）：登录着的店读得到；读不到的用 chanboss 上的店名 */
export async function shopNames(): Promise<Map<string, string>> {
	return new Map((await scan()).filter((s) => s.shop).map((s) => [s.shop!.shopId, s.shop!.username]));
}
