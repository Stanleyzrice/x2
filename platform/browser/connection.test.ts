// 当前浏览器连接：用元数据 driver 验证 nonce 边界、身份匹配及 fresh 登录识别，不连真实浏览器。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Challenge, NeedsHuman, Usage } from "../errors.ts";
import { refreshLogin, registerSite } from "./browser.ts";
import { type ConnectionDriver, type ConnectionInput, connectCurrentBrowser } from "./connection.ts";

const site = "connection-test";
registerSite({ key: site, title: "测试站点", origin: "https://site.example", hosts: (h) => h === "site.example", login: { identify: async () => null } });
const marker = "110e8400-e29b-41d4-a716-446655440000";
const url = `http://127.0.0.1:5170/?x2BrowserConnect=${marker}#298`;
const input: ConnectionInput = { url, marker, site, expectedAccount: "account-1" };
const account = { id: "account-1", name: "buyer-fixture" };
const browser = { id: "current-browser", label: "当前 Ego" };

function fixture(overrides: Partial<ConnectionDriver> = {}) {
	const identified: [string, string][] = [];
	const driver: ConnectionDriver = {
		browsers: async () => [browser],
		tabs: async () => [{ url }],
		identify: async (...args) => {
			identified.push(args);
			return account;
		},
		canOpenVerification: () => false,
		openVerification: async () => {
			throw new Error("没有可准确定位的验证页");
		},
		...overrides,
	};
	return { driver, identified };
}

test("URL nonce 精确匹配当前浏览器，只识别该浏览器的实际账号", async () => {
	const f = fixture({
		browsers: async () => [{ id: "other-browser", label: "另一浏览器" }, browser],
		tabs: async (id) => [{ url: id === browser.id ? url : url.replace("#298", "#299") }],
	});
	const result = await connectCurrentBrowser(input, { port: 5170, driver: f.driver });
	assert.deepEqual(result.browser, browser);
	assert.deepEqual(result.account, account);
	assert.equal(result.status, "connected");
	assert.deepEqual(f.identified, [[site, browser.id]]);
});

test("没有 marker 精确匹配或多个页面匹配时不识别任何站点账号", async () => {
	for (const [tabs, status] of [
		[[{ url: url.replace(marker, "another-marker") }], "not_connected"],
		[[{ url }, { url }], "ambiguous"],
	] as const) {
		const f = fixture({ tabs: async () => [...tabs] });
		assert.equal((await connectCurrentBrowser(input, { port: 5170, driver: f.driver })).status, status);
		assert.equal(f.identified.length, 0);
	}
	const f = fixture({ browsers: async () => [browser, { id: "duplicate", label: "重复浏览器" }] });
	assert.equal((await connectCurrentBrowser(input, { port: 5170, driver: f.driver })).status, "ambiguous");
	assert.equal(f.identified.length, 0);
});

test("验证 loopback 根地址、服务端口、注册站点和单一 UUID 标记后才访问浏览器", async () => {
	const bad: ConnectionInput[] = [
		{ ...input, site: "unregistered" },
		{ ...input, marker: "" },
		{ ...input, marker: "not-a-uuid" },
		{ ...input, url: "not a url" },
		{ ...input, url: url.replace("127.0.0.1", "example.com") },
		{ ...input, url: url.replace("http:", "https:") },
		{ ...input, url: url.replace(":5170/", ":5171/") },
		{ ...input, url: url.replace(":5170/", ":5170/other") },
		{ ...input, url: url.replace("127.0.0.1", "user@127.0.0.1") },
		{ ...input, url: url.replace(`=${marker}`, "=different") },
		{ ...input, url: url.replace("#298", `&x2BrowserConnect=${marker}#298`) },
		{ ...input, expectedAccount: " " },
	];
	let calls = 0;
	const f = fixture({
		browsers: async () => {
			calls++;
			return [browser];
		},
	});
	for (const value of bad) await assert.rejects(connectCurrentBrowser(value, { port: 5170, driver: f.driver }), Usage);
	assert.equal(calls, 0);
});

test("localhost 与 IPv6 loopback 同样可确认当前页，保留原 hash 与其他查询参数", async () => {
	for (const host of ["localhost", "[::1]"]) {
		const target = url.replace("127.0.0.1", host).replace("?x2", "?view=all&x2");
		const f = fixture({ tabs: async () => [{ url: target }] });
		assert.equal((await connectCurrentBrowser({ ...input, url: target }, { port: 5170, driver: f.driver })).status, "connected");
	}
});

test("账号不符明确拒绝，不以浏览器已连接代替身份校验；会员名也可精确匹配", async () => {
	const f = fixture();
	const wrong = await connectCurrentBrowser({ ...input, expectedAccount: "other-account" }, { port: 5170, driver: f.driver });
	assert.equal(wrong.status, "wrong_account");
	assert.deepEqual(wrong.account, account);
	assert.equal(wrong.loginUrl, "https://site.example");
	assert.equal((await connectCurrentBrowser({ ...input, expectedAccount: account.name }, { port: 5170, driver: f.driver })).status, "connected");
});

test("登录、滑块和未知身份探测错误如实区分，不统一伪装为未登录", async () => {
	for (const [error, status] of [
		[new NeedsHuman("站点要求登录"), "login_required"],
		[new Challenge("站点要求拉滑块"), "challenge"],
		[new Error("identity 回包结构变化"), "error"],
	] as const) {
		const f = fixture({
			identify: async () => {
				throw error;
			},
		});
		const result = await connectCurrentBrowser(input, { port: 5170, driver: f.driver });
		assert.equal(result.status, status);
		assert.equal(result.message, error.message);
		assert.deepEqual(result.browser, browser);
		assert.equal(result.account, undefined);
	}
	for (const empty of [null, { id: "", name: "" }]) {
		const f = fixture({ identify: async () => empty });
		assert.equal((await connectCurrentBrowser(input, { port: 5170, driver: f.driver })).status, "login_required");
	}
});

test("滑块仅在已有确切 owned 验证上下文时开放入口，首页成功检查不代替验证页", async () => {
	const f = fixture({
		identify: async () => {
			throw new Challenge("trade 页需要验证");
		},
		canOpenVerification: async () => true,
	});
	const result = await connectCurrentBrowser(input, { port: 5170, driver: f.driver });
	assert.equal(result.status, "challenge");
	assert.equal(result.canOpenVerification, true);
	assert.equal(result.loginUrl, undefined);
	let opened: [string, string] | undefined;
	f.driver.openVerification = async (...args) => {
		opened = args;
	};
	const focused = await connectCurrentBrowser({ ...input, action: "open-verification" }, { port: 5170, driver: f.driver });
	assert.deepEqual(opened, [site, browser.id]);
	assert.equal(focused.status, "challenge");
	assert.equal(focused.canOpenVerification, true);
	assert.equal(focused.loginUrl, undefined);
	assert.equal(f.identified.length, 0);
});

test("打开验证仍须当前页 nonce 唯一匹配，失去确切验证页时明确失败且不读取身份", async () => {
	const f = fixture();
	const result = await connectCurrentBrowser({ ...input, action: "open-verification" }, { port: 5170, driver: f.driver });
	assert.equal(result.status, "error");
	assert.equal(result.canOpenVerification, false);
	assert.deepEqual(result.browser, browser);
	assert.match(result.message, /没有可准确定位/);
	assert.equal(f.identified.length, 0);
});

test("daemon 或任一浏览器 tabs 元数据读取失败时不随便选择其他浏览器", async () => {
	for (const overrides of [
		{
			browsers: async () => {
				throw new Error("booey 连接已关闭");
			},
		},
		{
			tabs: async () => {
				throw new Error("tabs 不可读");
			},
		},
	]) {
		const f = fixture(overrides);
		const result = await connectCurrentBrowser(input, { port: 5170, driver: f.driver });
		assert.equal(result.status, "not_connected");
		assert.match(result.message, /booey 连接已关闭|tabs 不可读/);
		assert.equal(f.identified.length, 0);
	}
});

test("显式连接 fresh 识别不沿用旧账号或负 cookie 提示，失败后可再次识别", async () => {
	let actual: typeof account | null = account;
	let failure: Error | null = null;
	let calls = 0;
	const freshSite = "connection-fresh-test";
	registerSite({
		key: freshSite,
		title: "Fresh 测试站点",
		origin: "https://fresh.example",
		hosts: (h) => h === "fresh.example",
		login: {
			cookie: { url: "https://fresh.example", signedIn: () => false },
			identify: async () => {
				calls++;
				if (failure) throw failure;
				return actual;
			},
		},
	});
	assert.deepEqual(await refreshLogin(freshSite, browser.id), account);
	actual = null;
	assert.equal(await refreshLogin(freshSite, browser.id), null);
	failure = new Error("identity 暂时失败");
	await assert.rejects(refreshLogin(freshSite, browser.id), /identity 暂时失败/);
	failure = null;
	actual = { id: "new-account", name: "新账号" };
	assert.deepEqual(await refreshLogin(freshSite, browser.id), actual);
	assert.equal(calls, 4);
});
