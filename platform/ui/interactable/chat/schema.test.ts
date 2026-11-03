// Chat 组件只校验装配提供的明确窗口，不在可复用 schema 定义固定产品天数。
import assert from "node:assert/strict";
import { test } from "node:test";
import { props } from "./schema.ts";

test("Chat组件要求明确的正整数historyDays，允许工作区指定不同窗口", () => {
	const base = { shop: "fixture", policyPath: ".agents/skills/chat/SKILL.md" };
	assert.equal(props.safeParse(base).success, false);
	assert.equal(props.safeParse({ ...base, historyDays: 7 }).success, true);
	assert.equal(props.safeParse({ ...base, historyDays: 30 }).success, true);
	for (const historyDays of [0, -1, 1.5]) assert.equal(props.safeParse({ ...base, historyDays }).success, false);
});
