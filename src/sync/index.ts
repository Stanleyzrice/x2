// 同步：把站点读进库，一域一个。syncs 表里一样东西一行（域 + 店铺或 1688 账号），按「目标多新」决定读不读；
// 每次读完记下结果：成功、失败（和原因，要人处理的标出来）。检查只在这一域这一轮读全了时，才关它的收件箱
import { alibabaAccounts, recordShops } from "../accounts.ts";
import { type Sql, host } from "../db/index.ts";
import { NeedsHuman } from "../errors.ts";
import { syncCart, syncPurchases } from "./1688.ts";
import { syncOrders } from "./orders.ts";
import { syncSkus } from "./skus.ts";

export type Domain = {
	describe: string;
	/** 目标多新（分钟）：写进 syncs 的默认值，人可以在 NocoDB 里改 */
	maxMinutes: number;
	/** 要读的几份：店铺 id、1688 账号；只有一份是 [""] */
	scopes: (sql: Sql) => Promise<string[]>;
	run: (sql: Sql, scope: string) => Promise<number>;
};

/** 1688 账号：采购账号、登录着的浏览器里的，和加购写入里记过的 */
async function accounts(sql: Sql): Promise<string[]> {
	const written = await sql`select distinct params->>'account' as a from writes where op = '加购' and params->>'account' is not null`;
	return [...new Set([...await buyAccount(sql), ...await alibabaAccounts(), ...written.map((r) => r.a as string)])];
}

const buyAccount = async (sql: Sql) => (await sql`select buy_account from order_settings where id = 1 and buy_account is not null`).map((r) => r.buy_account as string);

export const DOMAINS: Record<string, Domain> = {
	orders: { describe: "订单（chanboss，两家店）", maxMinutes: 20, scopes: async () => [""], run: (sql) => syncOrders(sql) },
	skus: {
		describe: "规格（Shopee 在售商品，一家店一份）", maxMinutes: 1440,
		scopes: async (sql) => (await sql`select shop_id from shops where enabled order by shop_id`).map((r) => r.shop_id as string),
		run: (sql, shopId) => syncSkus(sql, shopId),
	},
	cart: { describe: "1688 购物车（一个账号一份）", maxMinutes: 20, scopes: accounts, run: syncCart },
	purchases: { describe: "1688 采购单和物流（一个账号一份）", maxMinutes: 30, scopes: accounts, run: (sql, a) => syncPurchases(sql, a) },
};

/** 没登录：不是采购账号的 1688 账号现在没有浏览器登录着，这次不读，不算失败（采购账号没登录才是失败、要人处理）。它的数据还是上次读到的，靠它关的收件箱不关 */
export type Result = { name: string; scope: string; result: "成功" | "失败" | "没读" | "没登录"; rows?: number; error?: string; blocked?: boolean };

/** 同步过期的（force：不管过没过期都读）。only：只同步这几个域；shop：只同步这家店（店铺 id 或账号名） */
export async function sync(sql: Sql, opts: { only?: string[]; force?: boolean; shop?: string } = {}): Promise<Result[]> {
	await recordShops(sql).catch((e) => console.error(`按店找浏览器：${(e as Error).message}`));
	const out: Result[] = [];
	for (const [name, d] of Object.entries(DOMAINS)) {
		if (opts.only && !opts.only.includes(name)) continue;
		let scopes = await d.scopes(sql);
		if (opts.shop && name === "skus") {
			const [s] = await sql`select shop_id from shops where shop_id = ${opts.shop} or account = ${opts.shop}`;
			scopes = scopes.filter((x) => x === s?.shop_id);
		}
		const online = name === "cart" || name === "purchases" ? new Set(await alibabaAccounts()) : null;
		const buying = new Set(await buyAccount(sql));
		for (const scope of scopes) {
			if (online && !online.has(scope) && !buying.has(scope)) {
				await sql`insert into syncs (name, scope, max_minutes) values (${name}, ${scope}, ${d.maxMinutes}) on conflict do nothing`;
				await sql`update syncs set result = '没登录', error = '没有浏览器登录着这个 1688 账号（不是采购账号：不读）', blocked = false where name = ${name} and scope = ${scope}`;
				out.push({ name, scope, result: "没登录" });
				continue;
			}
			await sql`insert into syncs (name, scope, max_minutes) values (${name}, ${scope}, ${d.maxMinutes}) on conflict do nothing`;
			const [row] = await sql`select (last_ok_at is null or last_ok_at < now() - make_interval(mins => max_minutes) or result is distinct from '成功') as stale from syncs where name = ${name} and scope = ${scope}`;
			if (!opts.force && !row!.stale) { out.push({ name, scope, result: "没读" }); continue; }
			console.error(`同步 ${name}${scope ? ` ${scope}` : ""}`);
			try {
				const rows = await d.run(sql, scope);
				await sql`update syncs set last_at = now(), last_ok_at = now(), result = '成功', error = null, blocked = false, rows = ${rows}, host = ${host} where name = ${name} and scope = ${scope}`;
				out.push({ name, scope, result: "成功", rows });
			} catch (e) {
				const blocked = e instanceof NeedsHuman;
				const error = (e as Error).message;
				await sql`update syncs set last_at = now(), result = '失败', error = ${error}, blocked = ${blocked}, host = ${host} where name = ${name} and scope = ${scope}`;
				out.push({ name, scope, result: "失败", error, blocked });
			}
		}
	}
	return out;
}
