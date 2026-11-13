// 浏览器授权只存历史连接配置，不存认证资料；恢复偏好不探测登录，实际操作仍由浏览器层核对身份。
import { type Account, allSites, setAccountBrowserPreference } from "../browser/browser.ts";
import type { ConnectionBrowser } from "../browser/connection.ts";
import type { Sql } from "../db/index.ts";
import { Usage } from "../errors.ts";

export type BrowserAuthorization = {
	site: string;
	accountId: string;
	accountName: string;
	browserId: string;
	browserLabel: string;
	authorizedAt: string;
	verifiedAt: string;
};
type Saved = {
	site: string;
	account_id: string;
	account_name: string;
	browser_id: string;
	browser_label: string;
	authorized_at: Date;
	verified_at: Date;
};
type Prefer = (site: string, account: Account, browserId: string) => void;

function registeredSite(site: unknown): string {
	if (typeof site !== "string" || !allSites().some((s) => s.key === site)) throw new Usage("浏览器授权要指定已注册站点");
	return site;
}

function summary(row: Saved): BrowserAuthorization {
	return {
		site: row.site,
		accountId: row.account_id,
		accountName: row.account_name,
		browserId: row.browser_id,
		browserLabel: row.browser_label,
		authorizedAt: row.authorized_at.toISOString(),
		verifiedAt: row.verified_at.toISOString(),
	};
}

export async function listBrowserAuthorizations(sql: Sql, site: unknown): Promise<BrowserAuthorization[]> {
	const key = registeredSite(site);
	const rows = await sql<Saved[]>`
		select site, account_id, account_name, browser_id, browser_label, authorized_at, verified_at
		from browser_authorizations where site = ${key} order by verified_at desc, account_id
	`;
	return rows.map(summary);
}

/** 同一浏览器再次核对只更新 verified_at；换浏览器才重新记该项授权的起点。 */
export async function saveBrowserAuthorization(
	sql: Sql,
	site: string,
	account: Account,
	browser: ConnectionBrowser,
	prefer: Prefer = setAccountBrowserPreference,
): Promise<void> {
	const key = registeredSite(site);
	if (!account.id.trim() || !browser.id.trim()) throw new Usage("保存授权需要实际身份与浏览器");
	await sql`
		insert into browser_authorizations (site, account_id, account_name, browser_id, browser_label)
		values (${key}, ${account.id}, ${account.name}, ${browser.id}, ${browser.label})
		on conflict (site, account_id) do update set
			account_name = excluded.account_name,
			browser_id = excluded.browser_id,
			browser_label = excluded.browser_label,
			authorized_at = case when browser_authorizations.browser_id = excluded.browser_id
				then browser_authorizations.authorized_at else excluded.authorized_at end,
			verified_at = excluded.verified_at
	`;
	prefer(key, account, browser.id);
}

/** 只恢复配置；已经移除的站点不再登记偏好，也不调用身份识别。 */
export async function restoreBrowserAuthorizations(sql: Sql, prefer: Prefer = setAccountBrowserPreference): Promise<void> {
	const rows = await sql<Saved[]>`
		select site, account_id, account_name, browser_id, browser_label, authorized_at, verified_at
		from browser_authorizations order by site, account_id
	`;
	const sites = new Set(allSites().map((s) => s.key));
	for (const row of rows)
		if (sites.has(row.site) && row.account_id.trim() && row.browser_id.trim()) prefer(row.site, { id: row.account_id, name: row.account_name }, row.browser_id);
}
