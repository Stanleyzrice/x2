// 授权只保留历史身份和浏览器配置，恢复时不把记录当成当前登录事实。
import assert from "node:assert/strict";
import { test } from "node:test";
import { registerSite } from "../browser/browser.ts";
import type { Sql } from "../db/index.ts";
import { listBrowserAuthorizations, restoreBrowserAuthorizations, saveBrowserAuthorization } from "./browser-authorizations.ts";

const site = "authorization-test";
registerSite({
	key: site,
	title: "测试站点",
	origin: "https://example.com",
	hosts: (host) => host === "example.com",
	login: {
		identify: async () => {
			throw new Error("历史授权不能触发身份识别");
		},
	},
});
const account = { id: "buyer-id", name: "买家" };
const browser = { id: "browser-id", label: "当前 Chrome" };
const row = {
	site,
	account_id: account.id,
	account_name: account.name,
	browser_id: browser.id,
	browser_label: browser.label,
	authorized_at: new Date("2026-11-13T00:00:00.000Z"),
	verified_at: new Date("2026-11-13T01:00:00.000Z"),
};

function database(rows: unknown[] = [], failure?: Error) {
	const calls: { text: string; values: unknown[] }[] = [];
	const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
		calls.push({ text: parts.join("?"), values });
		if (failure) throw failure;
		return rows;
	}) as unknown as Sql;
	return { sql, calls };
}

test("授权历史仅返回指定注册站点的身份、浏览器和时间，不返回额外认证资料", async () => {
	const d = database([{ ...row, token: "private" }]);
	assert.deepEqual(await listBrowserAuthorizations(d.sql, site), [
		{
			site,
			accountId: account.id,
			accountName: account.name,
			browserId: browser.id,
			browserLabel: browser.label,
			authorizedAt: row.authorized_at.toISOString(),
			verifiedAt: row.verified_at.toISOString(),
		},
	]);
	assert.deepEqual(d.calls[0]!.values, [site]);
	for (const invalid of [null, "", "unregistered-site"]) await assert.rejects(listBrowserAuthorizations(d.sql, invalid), /注册站点/);
	assert.equal(d.calls.length, 1);
});

test("授权持久化成功后才设浏览器偏好；SQL失败不留下内存授权", async () => {
	const d = database();
	const preferred: unknown[] = [];
	await saveBrowserAuthorization(d.sql, site, account, browser, (...args) => {
		preferred.push(args);
	});
	assert.equal(d.calls.length, 1);
	assert.deepEqual(d.calls[0]!.values, [site, account.id, account.name, browser.id, browser.label]);
	assert.deepEqual(preferred, [[site, account, browser.id]]);
	await assert.rejects(
		saveBrowserAuthorization(database([], new Error("store failed")).sql, site, account, browser, () => {
			throw new Error("不可登记失败授权");
		}),
		/store failed/,
	);
	assert.equal(preferred.length, 1);
});

test("空身份或空浏览器不能保存授权；恢复跳过已移除站点且不探测登录", async () => {
	const d = database([row, { ...row, site: "removed-site" }]);
	for (const [a, b] of [
		[{ ...account, id: " " }, browser],
		[account, { ...browser, id: "" }],
	] as const)
		await assert.rejects(
			saveBrowserAuthorization(d.sql, site, a, b, () => {
				throw new Error("不可设偏好");
			}),
			/身份|浏览器/,
		);
	assert.equal(d.calls.length, 0);
	const preferred: unknown[] = [];
	await restoreBrowserAuthorizations(d.sql, (...args) => {
		preferred.push(args);
	});
	assert.deepEqual(preferred, [[site, account, browser.id]]);
	assert.equal(d.calls.length, 1);
});
