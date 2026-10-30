// Gemini 的回包解析：样本照 generateContent 的文档写的；几段字连起来，没有候选是空字符串，样子变了报哪一格
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { textOf } from "./api.ts";

test("generateContent：第一个候选的几段字连起来；没有候选是空字符串；样子变了报哪一格", () => {
	assert.equal(textOf(JSON.parse(readFileSync(new URL("./fixtures/generate-content.json", import.meta.url), "utf8"))), '{"ok":true}');
	assert.equal(textOf({ promptFeedback: { blockReason: "SAFETY" } }), "");
	assert.throws(
		() => textOf({ candidates: [{ content: { parts: [{ text: 1 }] } }] }),
		/Gemini generateContent 的回包变了：candidates\[0\]\.content\.parts\[0\]\.text 应该是 string/,
	);
});
