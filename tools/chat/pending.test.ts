// 过期会话仍可发现待核对状态；固定店铺查询只返回必要元数据。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "../../platform/db/index.ts";
import { pendingReplies } from "./pending.ts";

test("pending按意图店铺及发送目标隔离，不选择正文或旧上下文", async () => {
	const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const query = strings.join("?");
		assert.deepEqual(values, ["ni1206"]);
		assert.match(query, /where i\.shop = \?/);
		assert.match(query, /w\.target = 'chat:' \|\| i\.shop_id \|\| ':' \|\| i\.conversation_id/);
		assert.doesNotMatch(query, /w\.params|w\.display|i\.input|select c\.data|created_at\s*[<>]|interval/i);
		assert.match(query, /w\.status in \('待执行', '已提交', '结果未知', '不一致'\)/);
		return [{ conversation_id: "aged-thread", buyer_name: "fixture", request_id: "request", status: "结果未知", error: null }];
	}) as unknown as Sql;
	const result = await pendingReplies(sql, "ni1206");
	assert.deepEqual(result.rows, [{ conversationId: "aged-thread", buyerName: "fixture", requestId: "request", status: "结果未知", error: null }]);
	assert.equal(result.shop, "ni1206");
	assert.equal("messages" in result.rows[0]!, false);
});
test("核对后不再有未决写入时，元数据列表为空，不恢复旧消息", async () => {
	const sql = (async () => []) as unknown as Sql;
	const result = await pendingReplies(sql, "cheeroutdoor");
	assert.deepEqual(result.rows, []);
	assert.equal(result.shop, "cheeroutdoor");
});
