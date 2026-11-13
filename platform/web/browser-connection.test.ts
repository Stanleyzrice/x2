// 当前页面连接入口只接受结构化参数和同源请求，返回值不携带额外浏览器或认证资料。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectionInput, ConnectionResult } from "../browser/connection.ts";
import { connectBrowserRequest, requestOriginUrl } from "./browser-connection.ts";

const marker = "5db35c6e-9c99-44c1-aeb5-475864283077";
const url = `http://127.0.0.1:5170/?x2BrowserConnect=${marker}#reimbursement`;
const input = { url, marker, site: "1688", expectedAccount: "buyer" };
const connected: ConnectionResult = {
	status: "connected",
	browser: { id: "browser-1", label: "当前 Chrome" },
	account: { id: "account-1", name: "buyer" },
	message: "已连接",
};

test("连接请求先校验JSON结构：缺字段、类型错误或客户端代码不交给浏览器层", async () => {
	let calls = 0;
	const connect = async () => {
		calls++;
		return connected;
	};
	for (const raw of [null, [], { ...input, marker: 1 }, { ...input, site: undefined }, { ...input, expectedAccount: 1 }, { ...input, script: "alert(1)" }])
		await assert.rejects(connectBrowserRequest(raw, { port: 5170 }, connect), /连接参数/);
	assert.equal(calls, 0);
});

test("连接请求的Origin按实际URL同源比较，不把localhost与127.0.0.1当成同源别名", async () => {
	let calls = 0;
	const connect = async () => {
		calls++;
		return connected;
	};
	for (const origin of ["http://localhost:5170", "http://127.0.0.1:5171", "https://127.0.0.1:5170"])
		await assert.rejects(connectBrowserRequest(input, { port: 5170, origin }, connect), /当前 X2 页面/);
	assert.equal(calls, 0);
});

test("Origin必须是HTTP来源本身：拒绝null、坏地址、凭证、路径、查询和片段", () => {
	for (const origin of ["null", "invalid", "http://u:p@127.0.0.1:5170", "http://127.0.0.1:5170/path", "http://127.0.0.1:5170/?x=1", "http://127.0.0.1:5170/#x"])
		assert.throws(() => requestOriginUrl(origin), /来源地址/);
	assert.equal(requestOriginUrl("http://[::1]:5170").origin, "http://[::1]:5170");
});

test("同源或未提供Origin时保留输入和实际监听端口，语义校验交浏览器层", async () => {
	const seen: unknown[] = [];
	const connect = async (p: ConnectionInput, options: { port: number }) => {
		seen.push({ input: p, options });
		return connected;
	};
	for (const origin of [undefined, "http://127.0.0.1:5170"]) assert.deepEqual(await connectBrowserRequest(input, { port: 5170, origin }, connect), connected);
	assert.deepEqual(seen, [
		{ input, options: { port: 5170 } },
		{ input, options: { port: 5170 } },
	]);
});

test("HTTP响应只投影连接状态与指定身份字段，不透传Cookie、调试器或其他浏览器字段", async () => {
	const result = {
		...connected,
		status: "error" as const,
		browser: { ...connected.browser!, cookie: "private", attached: [1] },
		account: { ...connected.account!, token: "private" },
		loginUrl: "https://www.1688.com",
		cookies: "private",
		debugger: { secret: "private" },
	};
	assert.deepEqual(await connectBrowserRequest(input, { port: 5170 }, async () => result), {
		...connected,
		status: "error",
		loginUrl: "https://www.1688.com",
	});
});

test("只有检查成功且带实际身份与浏览器才保存授权；打开验证不保存", async () => {
	const saved: unknown[] = [];
	const options = {
		port: 5170,
		authorize: async (...args: unknown[]) => {
			saved.push(args);
		},
	};
	await connectBrowserRequest(input, options, async () => connected);
	assert.deepEqual(saved, [[input.site, connected.account, connected.browser]]);
	for (const status of ["wrong_account", "challenge", "error", "login_required", "not_connected", "ambiguous"] as const)
		await connectBrowserRequest(input, options, async () => ({ ...connected, status }));
	for (const result of [
		{ ...connected, account: undefined },
		{ ...connected, browser: undefined },
		{ ...connected, account: { id: " ", name: "" } },
	])
		await connectBrowserRequest(input, options, async () => result);
	await connectBrowserRequest({ ...input, action: "open-verification" }, options, async () => connected);
	assert.equal(saved.length, 1);
});

test("保存授权失败不得返回连接成功；验证能力字段保留且只接收约定action", async () => {
	await assert.rejects(
		connectBrowserRequest(
			input,
			{
				port: 5170,
				authorize: async () => {
					throw new Error("store failed");
				},
			},
			async () => connected,
		),
		/store failed/,
	);
	const result = { ...connected, status: "challenge" as const, canOpenVerification: true };
	assert.deepEqual(await connectBrowserRequest({ ...input, action: "check" }, { port: 5170 }, async () => result), result);
	await assert.rejects(
		connectBrowserRequest({ ...input, action: "eval" }, { port: 5170 }, async () => connected),
		/连接参数/,
	);
});
