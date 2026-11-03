// Chat 的上下文、人工草稿并发和发送意图测试；只用内存fixture，不连站点、模型或真实DB。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "../../platform/db/index.ts";
import { assertFresh, assertInput, type Context, makeContext, type SendInput, sameIntent, type Target } from "./context.ts";
import { type ChatDriver, readMessageRange } from "./read.ts";
import { saveDraft } from "./store.ts";
import type { Message } from "./talk.ts";
import { rollingWindow } from "./window.ts";
import { planSend, type ReplyParams, replaySend, replyWrite } from "./writes.ts";

const target: Target = { shop: "ni1206", shopId: "77", userId: "78", conversationId: "99", buyerId: "88", buyerName: "買家甲" };
const fixtureTime = new Date();
const messages: Message[] = [{ id: "1", sender: "buyer", text: "請問尺寸？", at: new Date(fixtureTime.getTime() - 3600_000).toISOString() }];
const context = makeContext(target, messages, null, "11111111-1111-4111-8111-111111111111", fixtureTime, rollingWindow(7, fixtureTime));
const input: SendInput = {
	shop: target.shop,
	conversationId: target.conversationId,
	contextId: context.id,
	requestId: "22222222-2222-4222-8222-222222222222",
	contextHash: context.contextHash,
	text: "請問您想了解哪個尺寸？",
};
function memorySql(c: Context, writes: { id: string; batch: string; op: string; display: string; status: string; why: string | null }[] = []) {
	const intents = new Map<string, { input: SendInput; claimed: boolean; started: boolean }>();
	let draft: { text: string; revision: number } | null = null,
		serial: Promise<unknown> = Promise.resolve();
	const run = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
		const query = strings.join("?").replace(/\s+/g, " ").trim();
		if (query.startsWith("select data from chat_contexts"))
			return values[0] === c.id && values[1] === c.shop && values[2] === c.conversationId ? [{ data: c }] : [];
		if (query.startsWith("select input from chat_intents")) {
			const old = intents.get(String(values[0]));
			return old ? [{ input: old.input }] : [];
		}
		if (query.startsWith("select id::text, batch::text")) return writes;
		if (query.startsWith("insert into chat_intents")) {
			if (!intents.has(String(values[0]))) intents.set(String(values[0]), { input: values[4] as SendInput, claimed: false, started: false });
			return [];
		}
		if (query.startsWith("select input, claimed")) {
			const old = intents.get(String(values[0]));
			return old ? [old] : [];
		}
		if (query.startsWith("update chat_intents set claimed")) {
			intents.get(String(values[0]))!.claimed = true;
			return [];
		}
		if (query.startsWith("update chat_intents set submission_started")) {
			const old = intents.get(String(values[0]));
			if (!old || old.started) return [];
			old.started = true;
			return [{ request_id: values[0] }];
		}
		if (query.startsWith("insert into chat_drafts")) {
			if (values[4] !== 0 || draft) return [];
			draft = { text: String(values[3]), revision: 1 };
			return [draft];
		}
		if (query.startsWith("update chat_drafts")) {
			if (!draft || draft.revision !== values[4]) return [];
			draft = { text: String(values[0]), revision: draft.revision + 1 };
			return [draft];
		}
		throw new Error(`未声明的fixture查询：${query}`);
	};
	const sql = Object.assign(run, {
		json: (value: unknown) => value,
		begin: (fn: (tx: Sql) => Promise<unknown>) => {
			const next = serial.then(() => fn(sql as unknown as Sql));
			serial = next.catch(() => {});
			return next;
		},
	});
	return { sql: sql as unknown as Sql, draft: () => draft };
}

test("上下文绑定真实账号和收件方；新买家消息或正文编辑使旧确认失效", () => {
	assert.doesNotThrow(() => assertInput(input, context));
	assert.throws(() => assertInput({ ...input, shop: "cheeroutdoor" }, context));
	assert.throws(() => assertFresh(context, makeContext({ ...target, buyerId: "other" }, messages, null, context.id)));
	assert.throws(() => assertFresh(context, makeContext(target, [...messages, { ...messages[0]!, id: "2", text: "改問價格" }], null, context.id)));
	assert.equal(sameIntent(input, { ...input, text: "其他正文" }), false);
});
test("人工草稿用版本防止并发覆盖，另一个编辑保留而非被模型或轮询覆盖", async () => {
	const { sql, draft } = memorySql(context);
	assert.deepEqual(await saveDraft(sql, context, "人工稿", 0), { text: "人工稿", revision: 1 });
	const results = await Promise.allSettled([saveDraft(sql, context, "编辑A", 1), saveDraft(sql, context, "编辑B", 1)]);
	assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(draft()?.revision, 2);
	await assert.rejects(saveDraft(sql, context, "旧轮询回来的草稿", 1), /版本已更新/);
});
test("重复和并发requestId仅一批计划；同id更换正文被拒绝", async () => {
	const { sql } = memorySql(context);
	const results = await Promise.all([planSend(sql, input), planSend(sql, input)]);
	assert.deepEqual(results.map((r) => r.length).sort(), [0, 1]);
	await assert.rejects(planSend(sql, { ...input, text: "不同正文" }), /绑定不同/);
});
test("prepare拒绝过期上下文；单次提交后未知只核对，不自动发送第二次", async () => {
	const { sql } = memorySql(context);
	await planSend(sql, input);
	let live = context,
		sends = 0;
	const driver: ChatDriver = {
		read: async () => live,
		readEvidence: async () => live,
		send: async () => {
			sends++;
			return { kind: "unknown", why: "fixture timeout" };
		},
	};
	const op = replyWrite(driver),
		p: ReplyParams = { ...input, context };
	live = makeContext(target, [...messages, { ...messages[0]!, id: "2", text: "新問題" }], null, context.id, fixtureTime, context.window);
	await assert.rejects(op.prepare(sql, p), /上下文已更新/);
	assert.equal(sends, 0);
	live = context;
	const prepared = await op.prepare(sql, p);
	assert.ok(!("skip" in prepared));
	assert.equal((await op.submit(sql, p)).kind, "unknown");
	assert.equal((await op.check(p, prepared.before, false)).done, null);
	assert.equal((await op.check(p, prepared.before, false)).done, null);
	assert.equal(sends, 1);
	assert.ok("skip" in (await op.prepare(sql, p)));
	live = makeContext(target, [...messages, { id: "3", sender: "us", text: input.text, at: "2026-11-01T00:01:00.000Z" }], null, context.id);
	assert.equal((await op.check(p, prepared.before, false)).done, true);
	assert.equal(sends, 1);
});

test("首次发送只认已核对记录，结果未知不跳过try；核对完成后无需每次try", async () => {
	let verified = false;
	const sql = (async () => (verified ? [{ ok: 1 }] : [])) as unknown as Sql;
	const op = replyWrite({ read: async () => context, send: async () => ({ kind: "done" }) });
	assert.equal(await op.tried!(sql, { ...input, context }), false);
	verified = true;
	assert.equal(await op.tried!(sql, { ...input, context }), true);
});

test("新消息导致分页边界移动时，向前加载仍从已展示最早消息继续，不跳过中间历史", async () => {
	let records: Message[] = Array.from({ length: 100 }, (_, i) => ({
		id: String(i + 1),
		sender: "buyer",
		text: String(i + 1),
		at: new Date(i * 1000).toISOString(),
	}));
	const fetchPage = async (offset?: string) => {
		const end = offset ? records.findIndex((m) => m.id === offset) : records.length;
		return records.slice(Math.max(0, end - 30), end);
	};
	const first = await readMessageRange(fetchPage);
	assert.equal(first.next, "71");
	const second = await readMessageRange(fetchPage, { messages: first.messages, nextCursor: first.next }, first.next!);
	assert.equal(second.messages.length, 60);
	assert.equal(second.next, "41");
	records = [...records, { id: "101", sender: "buyer", text: "new", at: new Date(100000).toISOString() }];
	const refreshed = await readMessageRange(fetchPage, { messages: second.messages, nextCursor: second.next });
	assert.equal(refreshed.messages.length, 61);
	assert.equal(refreshed.next, "41");
	const older = await readMessageRange(fetchPage, { messages: refreshed.messages, nextCursor: refreshed.next }, refreshed.next!);
	assert.equal(older.messages[0]!.id, "11");
	assert.equal(older.messages.length, 91);
	await assert.rejects(readMessageRange(fetchPage, { messages: older.messages, nextCursor: older.next }, "wrong"), /不连续/);
});

test("重复请求回放原写入状态，没有写入记录的已占用请求保持未知，不伪装成功", async () => {
	const missing = memorySql(context);
	await planSend(missing.sql, input);
	assert.equal((await replaySend(missing.sql, input)).unknown, true);
	const recorded = memorySql(context, [{ id: "7", batch: "8", op: "聊聊回复", display: "fixture", status: "结果未知", why: "fixture timeout" }]);
	await planSend(recorded.sql, input);
	const replay = await replaySend(recorded.sql, input);
	assert.equal(replay.unknown, true);
	assert.equal(replay.ran[0]!.status, "结果未知");
});
