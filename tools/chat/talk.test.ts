// 聊聊：谁发的、一句话、先后；未回覆的排前面
import assert from "node:assert/strict";
import { test } from "node:test";
import { conversationsOf, draftPrompt, messagesOf } from "./talk.ts";

const conv = (id: number, over: Record<string, unknown>) => ({
	id,
	to_id: 9,
	to_name: `买家${id}`,
	latest_message_type: "text",
	latest_message_content: { text: "在吗" },
	latest_message_from_id: 9,
	last_message_time_nano: "1761700000000000000",
	unread_count: 1,
	...over,
});

test("会话：未回覆的排前面，再按最后一条从新到旧；谁发的照状态、来源、对方 id 认", () => {
	const l = conversationsOf(
		[
			conv(1, { last_message_time_nano: "1761800000000000000", latest_message_from_id: 5 }),
			conv(2, { last_message_state: "auto_reply", latest_message_from_id: 5 }),
			conv(3, { latest_message_source: "server", latest_message_type: "return_refund_card" }),
		],
		[conv(2, { last_message_state: "auto_reply", latest_message_from_id: 5 })],
	);
	assert.deepEqual(
		l.map((c) => [c.id, c.unreplied, c.lastFrom, c.lastText]),
		[
			["2", true, "auto", "在吗"],
			["1", false, "us", "在吗"],
			["3", false, "platform", "[退货退款]"],
		],
	);
	assert.equal(l[1]!.lastAt, new Date(1761800000000).toISOString());
});

test("消息：from_shop_id 是这家店是我们发的，从旧到新；不是字的写成 [图片] 这样；草稿的提示带上记录", () => {
	const m = messagesOf(
		[
			{ id: 2, type: "image", content: {}, from_shop_id: 0, created_timestamp: 20 },
			{ id: 1, type: "text", content: { text: "有现货吗" }, from_shop_id: 0, created_timestamp: 10 },
			{ id: 3, type: "text", content: { text: "有的" }, from_shop_id: 77, created_timestamp: 30 },
			{ id: 4, type: "text", content: { text: "下班了" }, from_shop_id: 77, status: "offwork_autoreply", created_timestamp: 40 },
		],
		"77",
	);
	assert.deepEqual(
		m.map((x) => [x.id, x.sender, x.text]),
		[
			["1", "buyer", "有现货吗"],
			["2", "buyer", "[图片]"],
			["3", "us", "有的"],
			["4", "auto", "下班了"],
		],
	);
	assert.match(draftPrompt("ni1206", m), /「ni1206」[\s\S]*买家：有现货吗\n买家：\[图片\]\n我们：有的\n我们的自动回复：下班了$/);
});
