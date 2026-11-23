import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectWithDeepSeek } from "./api.ts";

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
