// x2 shot 从页面事件里挑出来的报错：console.error、没接住的异常、HTTP >= 400、连不上的请求算；别的 console、成功的请求、取消的请求不算
import assert from "node:assert/strict";
import { test } from "node:test";
import { problemsOf } from "./shot.ts";

const ev = (method: string, params: unknown, seq = 0) => ({ seq, method, params, ts: 0 });

test("报错和失败的请求照先后列出来，连不上的请求带上它的地址", () => {
	assert.deepEqual(
		problemsOf([
			ev("Runtime.consoleAPICalled", { type: "log", args: [{ type: "string", value: "hi" }] }),
			ev("Runtime.consoleAPICalled", {
				type: "error",
				args: [
					{ type: "string", value: "boom" },
					{ type: "number", value: 2 },
					{ type: "object", description: "Object" },
				],
			}),
			ev("Network.requestWillBeSent", { requestId: "1", request: { url: "http://127.0.0.1:5199/api/rows" } }),
			ev("Network.responseReceived", { requestId: "1", response: { url: "http://127.0.0.1:5199/api/rows", status: 200 } }),
			ev("Network.requestWillBeSent", { requestId: "2", request: { url: "http://127.0.0.1:5199/api/page?id=9" } }),
			ev("Network.responseReceived", { requestId: "2", response: { url: "http://127.0.0.1:5199/api/page?id=9", status: 400, statusText: "Bad Request" } }),
			ev("Network.requestWillBeSent", { requestId: "3", request: { url: "http://127.0.0.1:1/x" } }),
			ev("Network.loadingFailed", { requestId: "3", errorText: "net::ERR_CONNECTION_REFUSED" }),
			ev("Network.requestWillBeSent", { requestId: "4", request: { url: "http://127.0.0.1:5199/a.js" } }),
			ev("Network.loadingFailed", { requestId: "4", errorText: "net::ERR_ABORTED", canceled: true }),
			ev("Runtime.exceptionThrown", { exceptionDetails: { text: "Uncaught", url: "http://127.0.0.1:5199/", exception: { description: "Error: x" } } }),
			ev("Page.loadEventFired", {}),
		]),
		[
			{ kind: "console", text: "boom 2 Object" },
			{ kind: "http", text: "400 Bad Request", url: "http://127.0.0.1:5199/api/page?id=9" },
			{ kind: "failed", text: "net::ERR_CONNECTION_REFUSED", url: "http://127.0.0.1:1/x" },
			{ kind: "exception", text: "Error: x", url: "http://127.0.0.1:5199/" },
		],
	);
});

test("没有报错回空的", () => {
	assert.deepEqual(problemsOf([ev("Page.loadEventFired", {})]), []);
});
