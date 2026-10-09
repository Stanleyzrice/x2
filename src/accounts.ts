// 按店找浏览器：一家店一个浏览器（Chrome 的不同用户）。每个连着的浏览器读一次 shopee shop，按店铺 id 认；
// 1688 也一样：每个浏览器读一次登录着的 1688 账号，按账号（userId）认。读到的店写进 shops（账号名、店名、浏览器）。
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

/** 认出来的店写进 shops（账号名、店名、账号 id、浏览器），1688 账号写进 accounts_1688（会员名） */
export async function recordShops(sql: Sql): Promise<void> {
	for (const s of await scan()) {
		if (s.alibaba) await sql`
			insert into accounts_1688 (user_id, login_id, seen_at) values (${s.alibaba}, ${s.loginId}, now())
			on conflict (user_id) do update set login_id = excluded.login_id, seen_at = excluded.seen_at`;
		if (!s.shop) continue;
		await sql`
			insert into shops (shop_id, account, name, user_id, browser) values (${s.shop.shopId}, ${s.shop.username}, ${s.shop.name}, ${s.shop.userId}, ${s.browser})
			on conflict (shop_id) do update set account = excluded.account, name = excluded.name, user_id = excluded.user_id, browser = excluded.browser`;
	}
}

/** 在登录着这家店（店铺 id）的浏览器里做 fn */
export async function inShop<T>(shopId: string, fn: () => Promise<T>): Promise<T> {
	const s = (await scan()).find((x) => x.shop?.shopId === shopId);
	if (!s) throw new NeedsHuman(`没有登录着店铺 ${shopId} 的浏览器：打开这家店的 Chrome，登录 Shopee 卖家中心，确认 cdp-relay 扩展已连接`);
	return using(s.browser, fn);
}

/** 登录着 1688 的账号（userId），每个账号一个浏览器 */
export async function alibabaAccounts(): Promise<string[]> {
	return [...new Set((await scan()).map((s) => s.alibaba).filter((a): a is string => a !== null))];
}

/** 在登录着这个 1688 账号的浏览器里做 fn */
export async function in1688<T>(account: string, fn: () => Promise<T>): Promise<T> {
	const s = (await scan()).find((x) => x.alibaba === account);
	if (!s) throw new NeedsHuman(`没有登录着 1688 账号 ${account} 的浏览器：打开那个 Chrome，登录 1688，确认 cdp-relay 扩展已连接`);
	return using(s.browser, fn);
}
