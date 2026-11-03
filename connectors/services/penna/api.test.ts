// Penna gateway 回包和请求边界的隔离检查，不调用真实模型。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { completionOf, endpoint, suggest } from "./api.ts";

test("网关地址不接受远程HTTP或URL凭证；按已核实路径请求", () => {
	assert.equal(endpoint("https://gateway.example.test").pathname, "/deepseek/chat/completions");
	assert.equal(endpoint("http://127.0.0.1:8787").protocol, "http:");
	assert.throws(() => endpoint("http://remote.example.test"));
	assert.throws(() => endpoint("https://user:secret@example.test"));
});
test("解析真实形状fixture，缺字段明确失败", async () => {
	const r = completionOf(JSON.parse(await readFile(new URL("./fixtures/completion.json", import.meta.url), "utf8")));
	assert.equal(r.model, "deepseek-flash");
	assert.equal(r.tokens, 42);
	assert.throws(() => completionOf({ choices: [] }), /回包变了/);
});
test("只请求Penna，HTTP错误不泄露响应体或token、不重试", async () => {
	let calls = 0;
	const request: typeof fetch = async (_url, options) => {
		calls++;
		const headers = new Headers(options?.headers);
		assert.equal(headers.get("authorization"), "Bearer fixture-token");
		assert.equal(headers.get("x-penna-what"), "x2-chat");
		assert.equal(JSON.parse(String(options?.body)).model, "deepseek-flash");
		return new Response("private provider error", { status: 503 });
	};
	await assert.rejects(
		suggest("rule", "context", { url: "https://gateway.example.test", token: "fixture-token", model: "deepseek-flash" }, request),
		/^Error: Penna gateway 回 HTTP 503$/,
	);
	assert.equal(calls, 1);
});
