// 客服模型回包和请求边界的隔离检查。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chatModelConfig, completionOf, endpoint, suggest } from "./api.ts";

test("客服复用 X2 设置中的 DeepSeek 密钥和默认模型，也接受模型切换", (t) => {
	const previousKey = process.env.DEEPSEEK_API_KEY;
	const previousModel = process.env.X2_HERMES_MODEL;
	t.after(() => {
		if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = previousKey;
		if (previousModel === undefined) delete process.env.X2_HERMES_MODEL;
		else process.env.X2_HERMES_MODEL = previousModel;
	});
	process.env.DEEPSEEK_API_KEY = "fixture-deepseek";
	process.env.X2_HERMES_MODEL = "deepseek-v4-pro";
	assert.deepEqual(chatModelConfig(), { baseUrl: "https://api.deepseek.com", apiKey: "fixture-deepseek", model: "deepseek-v4-pro" });
	assert.equal(chatModelConfig("deepseek-flash").model, "deepseek-flash");
});

test("模型地址保留服务商 API 路径并拒绝远程 HTTP 和 URL 凭证", () => {
	assert.equal(endpoint("https://provider.example.test/v1/").pathname, "/v1/chat/completions");
	assert.equal(endpoint("https://provider.example.test/openai/v1/chat/completions").pathname, "/openai/v1/chat/completions");
	assert.equal(endpoint("http://127.0.0.1:8787").protocol, "http:");
	assert.throws(() => endpoint("http://remote.example.test"));
	assert.throws(() => endpoint("https://user:secret@example.test"));
});
const config = { baseUrl: "https://provider.example.test/v1", apiKey: "fixture-key", model: "provider-model" };

test("以兼容格式请求服务商并返回回复、模型名和用量", async () => {
	const fixture = await readFile(new URL("./fixtures/completion.json", import.meta.url), "utf8");
	const request: typeof fetch = async (url, options) => {
		assert.equal(String(url), "https://provider.example.test/v1/chat/completions");
		assert.equal(options?.method, "POST");
		assert.equal(options?.redirect, "error");
		const headers = new Headers(options?.headers);
		assert.equal(headers.get("authorization"), "Bearer fixture-key");
		assert.deepEqual(JSON.parse(String(options?.body)), {
			model: "provider-model",
			stream: false,
			messages: [
				{ role: "system", content: "rule" },
				{ role: "user", content: "context" },
			],
		});
		return new Response(fixture);
	};
	assert.deepEqual(await suggest("rule", "context", config, request), { text: "您好，請問您想了解哪個尺寸呢？", model: "deepseek-flash", tokens: 42 });
});

test("缺字段的回包明确失败", () => {
	assert.throws(() => completionOf({ choices: [] }), /回包变了/);
});

test("客服模型正文混入 DSML 工具标记时拒绝整条建议", async () => {
	for (const content of ['<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="bash">', "您好\n</｜DSML｜tool_calls>", "&lt;||DSML|| invoke&gt;"]) {
		const request: typeof fetch = async () => Response.json({ model: "deepseek-flash", choices: [{ message: { content } }] });
		await assert.rejects(suggest("rule", "context", config, request), /模型回傳了工具指令/);
	}
});

test("HTTP 错误不泄露响应体或密钥，也不重试", async () => {
	let calls = 0;
	const request: typeof fetch = async () => {
		calls++;
		return new Response("private provider error", { status: 503 });
	};
	await assert.rejects(suggest("rule", "context", config, request), /^Error: 客服模型服务返回 HTTP 503$/);
	assert.equal(calls, 1);
});
