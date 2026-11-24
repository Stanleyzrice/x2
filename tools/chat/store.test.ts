import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "../../platform/db/index.ts";
import { makeContext } from "./context.ts";
import { threadState } from "./store.ts";

test("会话状态同时读取独立资料，未决发送优先且不会用旧建议覆盖当前上下文", async () => {
	const context = makeContext({ shop: "one", shopId: "10", userId: "11", conversationId: "12", buyerId: "13", buyerName: "買家" }, [], null, "fixture");
	const barrier = Promise.withResolvers<void>();
	const started: string[] = [];
	const sql = (async (strings: TemplateStringsArray) => {
		const query = strings.join("?");
		started.push(query);
		await barrier.promise;
		if (query.includes("from chat_drafts")) return [{ text: "人工稿", revision: 4 }];
		if (query.includes("from chat_suggestions")) return [{ id: "s", text: "旧建议", context_hash: "old", model: "fixture", latest_buyer_id: "1" }];
		if (query.includes("from chat_intents")) return [{ request_id: "new-intent" }];
		if (query.includes("and target =")) return [{ key: "chat-reply:pending-intent", status: "结果未知", error: "仍待核对" }];
		if (query.startsWith("select 1")) return [{ one: 1 }];
		return [{ status: "已核对", error: null }];
	}) as unknown as Sql;
	const reading = threadState(sql, context);
	try {
		assert.equal(started.length, 5, "独立读取须在等待首条响应前发出");
	} finally {
		barrier.resolve();
	}
	const result = await reading;
	assert.deepEqual(result.draft, { text: "人工稿", revision: 4 });
	assert.equal(result.suggestion?.stale, true);
	assert.deepEqual(result.reply, { requestId: "pending-intent", status: "结果未知", error: "仍待核对" });
	assert.equal(result.trialRequired, false);
});

test("旧建议的工具标记不再返回给页面，人工草稿照常读取", async () => {
	const context = makeContext({ shop: "one", shopId: "10", userId: "11", conversationId: "12", buyerId: "13", buyerName: "買家" }, [], null, "fixture");
	const draft = { text: "您好，請問您需要哪個尺寸？", revision: 4 };
	const sql = (async (strings: TemplateStringsArray) => {
		const query = strings.join("?");
		if (query.includes("from chat_drafts")) return [draft];
		if (query.includes("from chat_suggestions"))
			return [{ id: "s", text: "<｜｜DSML｜｜ calls>", context_hash: context.contextHash, model: "fixture", latest_buyer_id: "1" }];
		return [];
	}) as unknown as Sql;
	const result = await threadState(sql, context);
	assert.equal(result.suggestion, null);
	assert.deepEqual(result.draft, draft);
});
