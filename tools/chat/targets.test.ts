// Chat 展示目标的账号隔离、过期和容量测试；不调用浏览器或发送消息。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Target } from "./context.ts";
import { recentTargets } from "./targets.ts";

const target: Target = { shop: "one", shopId: "10", userId: "11", conversationId: "12", buyerId: "13", buyerName: "買家" };

test("展示目标同时隔离账号名、店铺身份、用户身份和会话，过期不会因读取延长", () => {
	let now = 0;
	const cache = recentTargets(30, 2, () => now);
	cache.remember(target);
	assert.equal(cache.peek("one", target, "12"), target);
	assert.equal(cache.peek("other", target, "12"), undefined);
	assert.equal(cache.peek("one", { ...target, shopId: "20" }, "12"), undefined);
	assert.equal(cache.peek("one", { ...target, userId: "21" }, "12"), undefined);
	assert.equal(cache.peek("one", target, "other"), undefined);
	now = 29;
	assert.equal(cache.peek("one", target, "12"), target);
	now = 30;
	assert.equal(cache.peek("one", target, "12"), undefined);
});

test("刚核对过的目标替换旧目标，容量限制移除最早记录", () => {
	const cache = recentTargets(30, 2, () => 0);
	cache.remember(target);
	const changed = { ...target, buyerId: "14" };
	cache.remember(changed);
	assert.equal(cache.peek("one", target, "12"), changed);
	cache.remember({ ...target, conversationId: "15" });
	cache.remember({ ...target, conversationId: "16" });
	assert.equal(cache.peek("one", target, "12"), undefined);
});
