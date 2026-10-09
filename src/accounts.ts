// 按店找浏览器：一家店一个浏览器（Chrome 的不同用户）。每个连着的浏览器读一次 shopee shop，按店铺 id 认；
// 1688 也一样：每个浏览器读一次登录着的 1688 账号，按账号（userId）认。都是现读，不存库。
// 一个进程里只认一次（开标签页、读接口都要时间）
import { account as alibabaAccount } from "./site/1688.ts";
import { shop as shopeeShop } from "./site/shopee/seller.ts";
import { browsers, using } from "./browser.ts";
import type { Sql } from "./db/index.ts";
import { NeedsHuman } from "./errors.ts";

type Seen = { browser: string; label: string; shop: Awaited<ReturnType<typeof shopeeShop>> | null; alibaba: string | null; loginId: string | null };

let seen: Promise<Seen[]> | null = null;

/** 每个连着的浏览器里登录着哪家店、哪个 1688 账号（没登录的是 null） */
export function scan(): Promise<Seen[]> {
	seen ??= (async () => {
		const out: Seen[] = [];
		for (const b of await browsers()) {
			const shop = await using(b.id, () => shopeeShop()).catch(() => null);
			const a = await using(b.id, () => alibabaAccount()).catch(() => null);
			out.push({ browser: b.id, label: b.label, shop, alibaba: a?.userId ?? null, loginId: a?.loginId ?? null });
		}
		return out;
	})();
	return seen;
}

/** 在登录着这家店（店铺 id）的浏览器里做 fn */
export async function inShop<T>(shopId: string, fn: () => Promise<T>): Promise<T> {
	const s = (await scan()).find((x) => x.shop?.shopId === shopId);
	if (!s) throw new NeedsHuman(`没有登录着店铺 ${shopId} 的浏览器：打开这家店的 Chrome，登录 Shopee 卖家中心，确认 cdp-relay 扩展已连接`);
	return using(s.browser, fn);
}

/** 登录着的 1688 账号：userId、会员名 */
export async function alibabaAccounts(): Promise<{ userId: string; loginId: string }[]> {
	const out = new Map<string, string>();
	for (const s of await scan()) if (s.alibaba) out.set(s.alibaba, s.loginId ?? s.alibaba);
	return [...out].map(([userId, loginId]) => ({ userId, loginId }));
}

/** 采购账号（订单设置里写的会员名）现在登录着的 userId；没设是 null，设了没登录要人处理 */
export async function buyAccount(sql: Sql): Promise<{ userId: string; loginId: string } | null> {
	const [s] = await sql`select buy_account from order_settings where id = 1`;
	const name = s?.buy_account as string | null;
	if (!name) return null;
	const a = (await alibabaAccounts()).find((x) => x.loginId === name || x.userId === name);
	if (!a) throw new NeedsHuman(`采购账号「${name}」没有登录：在浏览器里登录这个 1688 账号，确认 cdp-relay 扩展已连接`);
	return a;
}

/** 在登录着这个 1688 账号（userId）的浏览器里做 fn */
export async function in1688<T>(account: string, fn: () => Promise<T>): Promise<T> {
	const s = (await scan()).find((x) => x.alibaba === account);
	if (!s) throw new NeedsHuman(`没有登录着 1688 账号 ${account} 的浏览器：打开那个 Chrome，登录 1688，确认 cdp-relay 扩展已连接`);
	return using(s.browser, fn);
}

/** Shopee 店铺 id → 账号名（ni1206、cheeroutdoor）：登录着的店读得到；读不到的用 chanboss 上的店名 */
export async function shopNames(): Promise<Map<string, string>> {
	return new Map((await scan()).filter((s) => s.shop).map((s) => [s.shop!.shopId, s.shop!.username]));
}
