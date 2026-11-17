// 模拟中继验证标签所有权与断连恢复；不连接真实浏览器，不重放页面业务操作。
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { setImmediate } from "node:timers/promises";
import vm from "node:vm";
import { PageJsError, RelayError } from "@wuwe1/booey";
import { NeedsHuman } from "../errors.ts";
import { challenge, focusVerification, page, probe, registerSite, using } from "./browser.ts";

const origin = "https://browser-test.example";
const browser = "browser-lifecycle-test";
registerSite({ key: "browser-lifecycle-test", title: "测试站点", origin, hosts: (h) => h === "browser-test.example", login: { identify: async () => null } });

type Tab = { tabId: number; url: string; name: string; attached: boolean };
type RequestBody = { tabId?: number; url?: string; method?: string; params?: { expression?: string; url?: string } };

function relay(t: TestContext) {
	const tabs = new Map<number, Tab>();
	const closed: number[] = [];
	const focused: number[] = [];
	const calls = { opens: 0, attaches: 0, tabs: 0, business: 0 };
	let nextId = 100;
	let failAttach: string | null = null;
	let vanishOnAttach = false;
	let opening: (() => Promise<void>) | null = null;
	let attaching: (() => Promise<void>) | null = null;
	t.mock.method(globalThis, "fetch", async (input: unknown, options?: RequestInit) => {
		const path = new URL(String(input)).pathname;
		const body = JSON.parse(String(options?.body ?? "{}")) as RequestBody;
		const fail = (code: string, error: string) => Response.json({ error, code }, { status: 409 });
		if (path === "/browsers")
			return Response.json({
				browsers: [{ id: browser, label: "测试 Ego", attached: [...tabs.values()].filter((tab) => tab.attached).map((tab) => tab.tabId) }],
			});
		if (path === "/tabs") {
			calls.tabs++;
			return Response.json({ tabs: [...tabs.values()].map((tab) => ({ tabId: tab.tabId, url: tab.url, title: "测试页" })) });
		}
		if (path === "/open-tab") {
			calls.opens++;
			await opening?.();
			const tab: Tab = { tabId: nextId++, url: body.url!, name: "", attached: false };
			tabs.set(tab.tabId, tab);
			return Response.json({ ok: true, result: { tab } });
		}
		if (path === "/attach") {
			calls.attaches++;
			await attaching?.();
			if (failAttach) return fail(failAttach, "模拟连接失败");
			if (vanishOnAttach) {
				tabs.delete(body.tabId!);
				vanishOnAttach = false;
			}
			const tab = tabs.get(body.tabId!);
			if (!tab) return fail("NOT_FOUND", "tab missing");
			tab.attached = true;
			return Response.json({ ok: true, result: {} });
		}
		assert.equal(path, "/send");
		const tab = tabs.get(body.tabId!);
		if (!tab?.attached) return fail("TAB_NOT_ATTACHED", `tab ${body.tabId} not attached`);
		if (body.method === "Page.close") {
			tabs.delete(tab.tabId);
			closed.push(tab.tabId);
		} else if (body.method === "Page.bringToFront") focused.push(tab.tabId);
		else if (body.method === "Page.navigate") tab.url = body.params!.url!;
		else if (body.method === "Runtime.evaluate") {
			const expression = body.params!.expression!;
			if (expression.includes("业务")) calls.business++;
			const window = { name: tab.name };
			try {
				const value: unknown = await vm.runInNewContext(expression, { window, location: { href: tab.url }, document: { readyState: "complete" } });
				tab.name = window.name;
				return Response.json({ ok: true, result: { result: { value } } });
			} catch (error) {
				return Response.json({ ok: true, result: { exceptionDetails: { text: String(error) } } });
			}
		}
		return Response.json({ ok: true, result: {} });
	});
	return {
		tabs,
		closed,
		focused,
		calls,
		opening: (fn: () => Promise<void>) => {
			opening = fn;
		},
		attaching: (fn: () => Promise<void>) => {
			attaching = fn;
		},
		failAttach: (code: string | null) => {
			failAttach = code;
		},
		vanishOnAttach: () => {
			vanishOnAttach = true;
		},
	};
}

test("浏览器标签生命周期", async (t) => {
	const home = await mkdtemp(join(tmpdir(), "x2-browser-test-"));
	const previous = process.env.X2_HOME;
	process.env.X2_HOME = home;
	t.after(async () => {
		if (previous === undefined) delete process.env.X2_HOME;
		else process.env.X2_HOME = previous;
		await rm(home, { recursive: true, force: true });
	});

	await t.test("独占识别失败只关闭自己新建的临时页", async (t) => {
		const f = relay(t);
		await assert.rejects(
			probe(browser, async () => {
				await page(origin);
				throw new NeedsHuman("未识别到账号");
			}),
			/未识别到账号/,
		);
		assert.deepEqual(f.closed, [100]);
	});

	for (const inFlight of [false, true])
		await t.test(`识别失败保留另一上下文已复用的页（共用查页：${inFlight}）`, async (t) => {
			const f = relay(t);
			const opened = Promise.withResolvers<void>();
			const allowOpen = Promise.withResolvers<void>();
			const ready = Promise.withResolvers<void>();
			const fail = Promise.withResolvers<void>();
			if (inFlight)
				f.opening(async () => {
					opened.resolve();
					await allowOpen.promise;
				});
			const first = probe(browser, async () => {
				await page(origin);
				ready.resolve();
				await fail.promise;
				throw new NeedsHuman("本次识别失败");
			});
			if (inFlight) await opened.promise;
			else await ready.promise;
			const other = using(browser, () => page(origin));
			if (inFlight) {
				await setImmediate();
				allowOpen.resolve();
			}
			const shared = await other;
			fail.resolve();
			await assert.rejects(first, /本次识别失败/);
			assert.deepEqual(f.closed, []);
			assert.equal(await shared.run(() => "业务结果"), "业务结果");
			assert.equal(f.calls.opens, 1);
		});

	await t.test("另一上下文仍在附着共享页时，失败创建者不能提前关闭它", async (t) => {
		const f = relay(t);
		const ready = Promise.withResolvers<void>();
		const fail = Promise.withResolvers<void>();
		const attaching = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const first = probe(browser, async () => {
			await page(origin);
			ready.resolve();
			await fail.promise;
			throw new NeedsHuman("本次识别失败");
		});
		await ready.promise;
		f.attaching(async () => {
			attaching.resolve();
			await resume.promise;
		});
		const other = using(browser, () => page(origin));
		await attaching.promise;
		fail.resolve();
		await assert.rejects(first, /本次识别失败/);
		assert.deepEqual(f.closed, []);
		resume.resolve();
		assert.equal(await (await other).run(() => "业务结果"), "业务结果");
		assert.equal(f.calls.opens, 1);
	});

	await t.test("同一页断开后执行和导航前恢复连接，不额外扫描标签", async (t) => {
		const f = relay(t);
		const p = await using(browser, () => page(origin));
		f.tabs.get(p.tabId)!.attached = false;
		const scans = f.calls.tabs;
		assert.equal(await p.run(() => "业务结果"), "业务结果");
		assert.equal(f.calls.tabs, scans);
		f.tabs.get(p.tabId)!.attached = false;
		await p.goto(`${origin}/next`);
		assert.equal(f.tabs.get(p.tabId)!.url, `${origin}/next`);
		assert.equal(f.calls.opens, 1);
	});

	await t.test("已开始的业务函数抛错只执行一次", async (t) => {
		const f = relay(t);
		const p = await using(browser, () => page(origin));
		await assert.rejects(
			p.run(() => {
				throw new Error("业务失败");
			}),
			PageJsError,
		);
		assert.equal(f.calls.business, 1);
		assert.equal(f.calls.opens, 1);
	});

	await t.test("原标签关闭或中继断开时明确报错，不重开或执行业务", async (t) => {
		const f = relay(t);
		const p = await using(browser, () => page(origin));
		f.tabs.delete(p.tabId);
		await assert.rejects(
			p.run(() => "业务结果"),
			(error: Error) => error instanceof RelayError && /已关闭|不存在/.test(error.message),
		);
		f.failAttach("UNREACHABLE");
		await assert.rejects(
			p.run(() => "业务结果"),
			(error: Error) => error instanceof RelayError && /连接|断开/.test(error.message),
		);
		assert.equal(f.calls.business, 0);
		assert.equal(f.calls.opens, 1);
	});

	await t.test("候选页在列表读取与附着之间关闭时跳过失效页", async (t) => {
		const f = relay(t);
		f.tabs.set(99, { tabId: 99, url: origin, name: "x2", attached: false });
		f.vanishOnAttach();
		const p = await using(browser, () => page(origin));
		assert.equal(p.tabId, 100);
		assert.equal(await p.run(() => "业务结果"), "业务结果");
	});

	await t.test("原验证页断开后先恢复连接再聚焦，不选择其他页", async (t) => {
		const f = relay(t);
		const p = await using(browser, () => page(origin));
		await challenge(browser, "browser-lifecycle-test", p.tabId);
		f.tabs.get(p.tabId)!.attached = false;
		await focusVerification("browser-lifecycle-test", browser);
		assert.deepEqual(f.focused, [p.tabId]);
		assert.equal(f.calls.opens, 1);
	});
});
