import assert from "node:assert/strict";
import { test } from "node:test";
import { askDeepSeek, DeepSeekOutputError, inspectWithDeepSeek } from "./api.ts";

test("DeepSeek 视觉走官方接口并传真实图片数据", async () => {
	const request: typeof fetch = async (url, input) => {
		assert.equal(url, "https://api.deepseek.com/chat/completions");
		assert.equal(new Headers(input?.headers).get("authorization"), "Bearer fixture");
		assert.equal(input?.redirect, "error");
		const body = JSON.parse(String(input?.body));
		assert.equal(body.model, "deepseek-flash");
		assert.equal(body.messages[0].content[1].image_url.url, "data:image/png;base64,AAEC");
		return Response.json({ choices: [{ message: { content: '{"state":"traditional","issues":[],"evidence":"圖上寫的是尺寸"}' } }] });
	};
	const result = await inspectWithDeepSeek("fixture", { mime: "image/png", bytes: new Uint8Array([0, 1, 2]) }, "看图", request);
	assert.deepEqual(result, { state: "traditional", issues: [], evidence: "圖上寫的是尺寸" });
});

test("结构化分析传所选 DeepSeek，含原图时由 Flash 处理", async (t) => {
	const original = process.env.DEEPSEEK_API_KEY;
	process.env.DEEPSEEK_API_KEY = "fixture";
	t.after(() => {
		if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = original;
	});
	const request: typeof fetch = async (_url, init) => {
		const body = JSON.parse(String(init?.body));
		const content = body.messages[0].content;
		assert.equal(body.model, Array.isArray(content) ? "deepseek-flash" : "deepseek-v4-pro");
		assert.equal(body.response_format.type, "json_object");
		assert.match(typeof content === "string" ? content : content[0].text, /"required":\["ok"\]/);
		return Response.json({ choices: [{ message: { content: '{"ok":true}' } }] });
	};
	const input = {
		model: "deepseek-v4-pro" as const,
		prompt: "分析给出的证据",
		schema: { type: "object", required: ["ok"] },
		signal: new AbortController().signal,
		timeoutMs: 1000,
	};
	assert.deepEqual(await askDeepSeek(input, request), { ok: true });
	assert.deepEqual(await askDeepSeek({ ...input, images: [{ mime: "image/png", bytes: new Uint8Array([0, 1, 2]) }] }, request), { ok: true });
});

test("DeepSeek 空白、截断和非 JSON 输出可以区分于 HTTP 或内容拒绝", async () => {
	const image = { mime: "image/png", bytes: new Uint8Array([0, 1, 2]) };
	for (const [reason, content] of [
		["stop", "  "],
		["length", '{"ok":'],
		["stop", "看好了"],
	] as const) {
		await assert.rejects(
			inspectWithDeepSeek("fixture", image, "看图", async () => Response.json({ choices: [{ finish_reason: reason, message: { content } }] })),
			DeepSeekOutputError,
		);
	}
	await assert.rejects(
		inspectWithDeepSeek("fixture", image, "看图", async () => Response.json({ choices: [{ finish_reason: "content_filter", message: { content: null } }] })),
		(error) => error instanceof Error && !(error instanceof DeepSeekOutputError) && /拒绝返回/.test(error.message),
	);
});
