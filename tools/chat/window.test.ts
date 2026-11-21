// 显式滚动窗口的显示/AI范围与发送核对隔离；只用内存分页，不调用站点或模型。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "../../platform/db/index.ts";
import { assertFresh, assertSuggestionContext, makeContext, type Target } from "./context.ts";
import { chat } from "./index.ts";
import { type ChatDriver, readMessageRange, visibleConversations } from "./read.ts";
import type { Message } from "./talk.ts";
import { type HistoryWindow, historyDays, rollingWindow } from "./window.ts";
import { preview, type ReplyParams, replyWrite } from "./writes.ts";

const now = new Date("2026-11-10T08:00:00.000Z"),
	window = rollingWindow(7, now);
const target: Target = { shop: "ni1206", shopId: "1", userId: "2", conversationId: "3", buyerId: "4", buyerName: "fixture" };
const msg = (id: string, at: string, text = id): Message => ({ id, sender: "buyer", text, at });
const fetcher = (records: Message[]) => async (offset?: string) => {
	const end = offset ? records.findIndex((m) => m.id === offset) : records.length;
	return records.slice(Math.max(0, end - 30), end);
};

test("窗口由调用方显式指定有效天数，Tool不默认或固定7天", () => {
	assert.equal(Date.parse(window.to) - Date.parse(window.from), 7 * 24 * 60 * 60_000);
	assert.equal(historyDays.safeParse(undefined).success, false);
	assert.equal(historyDays.parse("7"), 7);
	assert.equal(historyDays.parse(30), 30);
	assert.equal(rollingWindow(30, now).days, 30);
	for (const value of [null, true, false, "", 0, -1, 1.5, Number.POSITIVE_INFINITY]) assert.equal(historyDays.safeParse(value).success, false);
	assert.equal(chat.tools.messages!.params.safeParse({ shop: "ni1206", conversationId: "3", historyDays: 30 }).success, true);
	assert.equal(chat.tools.messages!.params.safeParse({ shop: "ni1206", conversationId: "3" }).success, false);
});

test("续页绑定现有上下文，生成建议只用项目客服规则", () => {
	const target = { shop: "ni1206", conversationId: "3", historyDays: 7 };
	const contextId = "11111111-1111-4111-8111-111111111111";
	assert.equal(chat.tools.messages!.params.safeParse({ ...target, cursor: "next" }).success, false);
	assert.equal(chat.tools.messages!.params.safeParse({ ...target, cursor: "next", contextId }).success, true);
	assert.equal(chat.tools.draft!.params.safeParse(target).success, false);
	assert.equal(chat.tools.draft!.params.parse({ ...target, contextId }).policyPath, ".agents/skills/chat/SKILL.md");
	assert.equal(chat.tools.draft!.params.safeParse({ ...target, contextId, policyPath: "local.md" }).success, false);
});
test("会话在Backend移除旧消息预览，未知时间不冒充窗口内", () => {
	const raw = (id: string, at: string | null, text: string) => ({
		id,
		to_id: "4",
		to_name: id,
		latest_message_type: "text",
		latest_message_content: { text },
		last_message_time_nano: at ? `${Date.parse(at)}000000` : null,
	});
	const rows = visibleConversations(
		[raw("old", "2026-11-03T07:59:59.999Z", "不可返回的旧正文"), raw("edge", window.from, "边界消息"), raw("unknown", null, "未知时间")],
		[],
		window,
	);
	assert.deepEqual(
		rows.map((r) => r.id),
		["edge"],
	);
	assert.doesNotMatch(JSON.stringify(rows), /不可返回的旧正文|未知时间/);
});
test("过期previous最早消息不再强制找回；所有消息过期后刷新为空，不报历史缺页", async () => {
	const old = msg("1", "2026-11-03T07:59:59.999Z"),
		edge = msg("2", window.from),
		recent = msg("3", "2026-11-09T08:00:00.000Z");
	const previous = { messages: [old, edge, recent], nextCursor: "1" };
	const current = await readMessageRange(fetcher([old, edge, recent]), previous, undefined, window);
	assert.deepEqual(
		current.messages.map((m) => m.id),
		["2", "3"],
	);
	assert.equal(current.next, null);
	const expired = await readMessageRange(fetcher([old]), { messages: [old], nextCursor: null }, undefined, window);
	assert.deepEqual(expired.messages, []);
	assert.equal(expired.next, null);
	const c = makeContext(target, expired.messages, null, "expired", now, window);
	assert.throws(() => assertSuggestionContext(c), /未调用付费模型/);
});
test("向前加载遇七天边界时保留所有窗口内消息并停止，不受预读边界影响", async () => {
	const records = Array.from({ length: 45 }, (_, i) => msg(String(i + 1), new Date(now.getTime() - (45 - i) * 4 * 3600_000).toISOString()));
	const first = await readMessageRange(fetcher(records), undefined, undefined, window);
	assert.equal(first.messages.length, 30);
	assert.ok(first.next);
	const older = await readMessageRange(fetcher(records), { messages: first.messages, nextCursor: first.next }, first.next!, window);
	assert.equal(older.messages.length, 42);
	assert.equal(older.next, null);
});
test("窗口时钟变化不无故使hash过期，但消息实际过期必须重新确认", async () => {
	const edge = msg("1", window.from),
		recent = msg("2", "2026-11-09T08:00:00.000Z");
	const initial = makeContext(target, [edge, recent], null, "a", now, window);
	const later = rollingWindow(7, new Date(now.getTime() + 1000));
	const stableA = makeContext(target, [recent], null, "b", now, window),
		stableB = makeContext(target, [recent], null, "c", new Date(now.getTime() + 1000), later);
	assert.equal(stableA.contextHash, stableB.contextHash);
	const refreshed = await readMessageRange(fetcher([edge, recent]), initial, undefined, later);
	const current = makeContext(target, refreshed.messages, refreshed.next, "d", new Date(now.getTime() + 1000), later);
	assert.throws(() => assertFresh(initial, current), /上下文已更新/);
});
test("过期未知发送使用已有intent的独立证据读取，不受普通UI七天窗口截断", async () => {
	const before = msg("1", "2026-11-01T08:00:00.000Z"),
		sent: Message = { ...msg("2", "2026-11-01T08:01:00.000Z", "旧回复"), sender: "us" };
	const original = makeContext(target, [before], null, "11111111-1111-4111-8111-111111111111", new Date(before.at), rollingWindow(7, new Date(before.at)));
	let evidenceReads = 0,
		sends = 0;
	const driver: ChatDriver = {
		read: async () => {
			throw new Error("核对不能走普通UI窗口");
		},
		readEvidence: async () => {
			evidenceReads++;
			return makeContext(target, [before, sent], null, "evidence");
		},
		send: async () => {
			sends++;
			return { kind: "done" };
		},
	};
	const result = await replyWrite(driver).check(
		{
			shop: target.shop,
			conversationId: target.conversationId,
			contextId: original.id,
			contextHash: original.contextHash,
			requestId: "22222222-2222-4222-8222-222222222222",
			text: "旧回复",
			context: original,
		},
		{ ids: [before.id] },
		false,
	);
	assert.equal(result.done, true);
	assert.equal(evidenceReads, 1);
	assert.equal(sends, 0);
});

const scopedWindow = (days: number, at: Date): HistoryWindow => ({
	days,
	from: new Date(at.getTime() - days * 86_400_000).toISOString(),
	to: at.toISOString(),
});
function sendingFixture(days: number | null, age = 8) {
	const at = new Date();
	const context = makeContext(
		target,
		[msg("1", new Date(at.getTime() - age * 86_400_000).toISOString())],
		null,
		"11111111-1111-4111-8111-111111111111",
		at,
		days === null ? undefined : scopedWindow(days, at),
	);
	const params: ReplyParams = {
		shop: target.shop,
		conversationId: target.conversationId,
		contextId: context.id,
		contextHash: context.contextHash,
		requestId: "22222222-2222-4222-8222-222222222222",
		text: "人工确认的正文",
		context,
	};
	const sql = (async (strings: TemplateStringsArray) =>
		strings.join("").startsWith("select data from chat_contexts") ? [{ data: context }] : [{ request_id: params.requestId }]) as unknown as Sql;
	return { at, context, params, sql };
}
test("相同消息但窗口天数变化会使旧确认过期，单纯滚动时间不改变同策略指纹", () => {
	const messages = [msg("1", now.toISOString())];
	const seven = makeContext(target, messages, null, "a", now, scopedWindow(7, now));
	const thirty = makeContext(target, messages, null, "b", now, scopedWindow(30, now));
	assert.notEqual(seven.contextHash, thirty.contextHash);
	assert.throws(() => assertFresh(seven, thirty), /上下文已更新/);
});
test("preview、prepare和submit均使用冻结上下文的30天范围，不退回默认窗口", async () => {
	const f = sendingFixture(30);
	let reads = 0,
		sends = 0;
	const driver: ChatDriver = {
		read: async (_shop, _id, previous, _cursor, current) => {
			reads++;
			assert.equal(current?.days, 30);
			assert.ok(Math.abs(Date.parse(current!.to) - Date.now()) < 1000);
			return makeContext(target, previous!.messages, null, "live", new Date(), current);
		},
		send: async () => {
			sends++;
			return { kind: "unknown", why: "fixture" };
		},
	};
	await preview(f.sql, f.params, driver);
	const op = replyWrite(driver);
	await op.prepare(f.sql, f.params);
	await op.submit(f.sql, f.params);
	assert.equal(reads, 3);
	assert.equal(sends, 1);
});
test("legacy无window或消息已过期时不能preview、prepare或submit，不默默放宽范围", async () => {
	for (const f of [sendingFixture(null, 1), sendingFixture(1, 2)]) {
		let sends = 0;
		const driver: ChatDriver = {
			read: async () => f.context,
			send: async () => {
				sends++;
				return { kind: "done" };
			},
		};
		const op = replyWrite(driver);
		await assert.rejects(preview(f.sql, f.params, driver), /窗口|范围|过期/);
		await assert.rejects(op.prepare(f.sql, f.params), /窗口|范围|过期/);
		await assert.rejects(op.submit(f.sql, f.params), /窗口|范围|过期/);
		assert.equal(sends, 0);
	}
});
test("独立证据reader不可用时核对保持未知，不退回普通显示窗口读取", async () => {
	const f = sendingFixture(30);
	let reads = 0;
	const driver: ChatDriver = {
		read: async () => {
			reads++;
			throw new Error("不能使用普通读取核对");
		},
		send: async () => ({ kind: "done" }),
	};
	const checked = await replyWrite(driver).check(f.params, { ids: ["1"] }, false);
	assert.equal(checked.done, null);
	assert.equal(reads, 0);
});
