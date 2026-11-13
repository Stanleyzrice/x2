// 验证页只按服务端已知所有权和确切受阻标签定位，不扫描 DOM、不接管用户页、不导航。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVerificationRegistry, type VerificationDriver } from "./verification.ts";

const site = "1688-test";
const browser = "current-browser";
const matchesUrl = (raw: string) => {
	const url = new URL(raw);
	return url.hostname.endsWith(".1688.com") || (url.hostname === "sec.alibaba.com" && url.pathname.includes("/punish"));
};

function fixture() {
	const focused: [string, number][] = [];
	let tabs = [
		{ tabId: 10, url: "https://trade.1688.com/order/_____tmd_____/punish?private-token=hidden" },
		{ tabId: 11, url: "https://www.1688.com/" },
	];
	const driver: VerificationDriver = {
		tabs: async () => tabs,
		focus: async (...args) => {
			focused.push(args);
		},
	};
	return {
		driver,
		focused,
		setTabs: (next: typeof tabs) => {
			tabs = next;
		},
	};
}

test("仅确切 owned 受阻标签可聚焦，后来打开首页不会替换 trade 验证上下文", async () => {
	const registry = createVerificationRegistry();
	const f = fixture();
	registry.own(site, browser, 10);
	registry.challenge(site, browser, 10);
	registry.own(site, browser, 11);
	assert.equal(await registry.canOpen(site, browser, matchesUrl, f.driver), true);
	await registry.focus(site, browser, matchesUrl, f.driver);
	assert.deepEqual(f.focused, [[browser, 10]]);
});

test("未知用户页、其他浏览器、其他站点及没有实际 challenge 的 owned 页均不可聚焦", async () => {
	const registry = createVerificationRegistry();
	const f = fixture();
	registry.challenge(site, browser, 10);
	assert.equal(await registry.canOpen(site, browser, matchesUrl, f.driver), false);
	registry.own(site, browser, 10);
	assert.equal(await registry.canOpen(site, browser, matchesUrl, f.driver), false);
	registry.challenge(site, browser, 10);
	for (const [s, b] of [
		[site, "other-browser"],
		["other-site", browser],
	]) {
		assert.equal(await registry.canOpen(s!, b!, matchesUrl, f.driver), false);
		await assert.rejects(registry.focus(s!, b!, matchesUrl, f.driver), /无法准确定位/);
	}
	assert.deepEqual(f.focused, []);
});

test("原验证页关闭或导航到其他站点后不选择另一个 1688 页面", async () => {
	for (const existing of [[], [{ tabId: 10, url: "https://unrelated.example/" }]]) {
		const registry = createVerificationRegistry();
		const f = fixture();
		registry.own(site, browser, 10);
		registry.challenge(site, browser, 10);
		f.setTabs([...existing, { tabId: 11, url: "https://www.1688.com/" }]);
		assert.equal(await registry.canOpen(site, browser, matchesUrl, f.driver), false);
		await assert.rejects(registry.focus(site, browser, matchesUrl, f.driver), /无法准确定位/);
		assert.deepEqual(f.focused, []);
	}
});

test("过期上下文不可聚焦，重新遇到同一 owned 页的 challenge 后才恢复", async () => {
	let now = 0;
	const registry = createVerificationRegistry({ now: () => now, maxAgeMs: 1000 });
	const f = fixture();
	registry.own(site, browser, 10);
	registry.challenge(site, browser, 10);
	now = 1000;
	assert.equal(await registry.canOpen(site, browser, matchesUrl, f.driver), false);
	await assert.rejects(registry.focus(site, browser, matchesUrl, f.driver), /过期/);
	registry.challenge(site, browser, 10);
	await registry.focus(site, browser, matchesUrl, f.driver);
	assert.deepEqual(f.focused, [[browser, 10]]);
});

test("已知 owned 页跳到注册的验证码域仍可聚焦，未知域同形路径被拒绝", async () => {
	for (const [url, allowed] of [
		["https://sec.alibaba.com/_____tmd_____/punish", true],
		["https://unknown.example/_____tmd_____/punish", false],
	] as const) {
		const registry = createVerificationRegistry();
		const f = fixture();
		registry.own(site, browser, 10);
		registry.challenge(site, browser, 10);
		f.setTabs([{ tabId: 10, url }]);
		assert.equal(await registry.canOpen(site, browser, matchesUrl, f.driver), allowed);
		if (allowed) await registry.focus(site, browser, matchesUrl, f.driver);
		else await assert.rejects(registry.focus(site, browser, matchesUrl, f.driver), /无法准确定位/);
		assert.equal(f.focused.length, Number(allowed));
	}
});
