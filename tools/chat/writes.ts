// Chat 发送冻结精确正文与上下文；仅经至多一次写入引擎提交，未知结果只读回核对。
import { z } from "zod";
import type { Json, Sql } from "../../platform/db/index.ts";
import type { Planned } from "../../platform/tool.ts";
import { type Outcome, type Ran, WriteId, type WriteOp, writeOp } from "../../platform/writes.ts";
import { assertFresh, assertInput, type Context, type SendInput, sameIntent, sendInput } from "./context.ts";
import { type ChatDriver, chatDriver } from "./read.ts";
import { contextById } from "./store.ts";
import { replyTried } from "./trial.ts";
import { currentContextWindow } from "./window.ts";

export const replyParams = sendInput.extend({ context: z.custom<Context>((v) => typeof v === "object" && v !== null && "contextHash" in v) });
export type ReplyParams = z.infer<typeof replyParams>;
export function replyWrite(driver: ChatDriver = chatDriver): WriteOp<ReplyParams, { ids: string[] }> {
	return {
		describe: "发送确认的 Shopee 买家回复",
		params: replyParams,
		target: (p) => `chat:${p.context.shopId}:${p.conversationId}`,
		key: (p) => `chat-reply:${p.requestId}`,
		display: (p) => `${p.shop} / ${p.context.buyerName} (${p.context.buyerId})：${p.text}`,
		untried: "首次发送须确认具体店铺、买家和正文，并以 --try 试一条后在 Shopee 核对",
		tried: (sql) => replyTried(sql),
		where: (_sql, _p, fn) => fn(),
		async prepare(sql, p) {
			assertInput(p, p.context);
			const live = await driver.read(p.shop, p.conversationId, p.context, undefined, currentContextWindow(p.context));
			assertFresh(p.context, live);
			const claimed =
				await sql`update chat_intents set submission_started = true where request_id = ${p.requestId} and not submission_started returning request_id`;
			if (!claimed.length) return { skip: "这个 requestId 已进入发送或核对流程，不重复发送" };
			return { params: p, before: { ids: live.messages.map((m) => m.id) } };
		},
		async submit(_sql, p) {
			const live = await driver.read(p.shop, p.conversationId, p.context, undefined, currentContextWindow(p.context));
			assertFresh(p.context, live);
			return driver.send({ ...p.context, expectedLatestMessageId: live.messages.at(-1)?.id }, p.text);
		},
		async check(p, before) {
			if (!before) return { done: null, readback: { reason: "缺少提交前快照，只允许人工核对" } };
			if (!driver.readEvidence) return { done: null, readback: { reason: "独立发送证据读取不可用，保持结果未知" } };
			const live = await driver.readEvidence(p.context);
			if (live.shopId !== p.context.shopId || live.buyerId !== p.context.buyerId || live.userId !== p.context.userId) throw new Error("核对时账号或买家改变");
			const sent = live.messages.find((m) => m.sender === "us" && m.text === p.text && !before.ids.includes(m.id));
			return {
				done: sent ? true : null,
				readback: sent ? { messageId: sent.id, conversationId: p.conversationId } : { reason: "本次读取未找到确切新消息，保持结果未知" },
			};
		},
	};
}
export async function preview(sql: Sql, p: SendInput, driver: ChatDriver = chatDriver) {
	const context = await contextById(sql, p.shop, p.conversationId, p.contextId);
	assertInput(p, context);
	assertFresh(context, await driver.read(p.shop, p.conversationId, context, undefined, currentContextWindow(context)));
	return {
		params: p,
		display: `${context.shop}（shopId ${context.shopId}） → ${context.buyerName}（buyerId ${context.buyerId}；会话 ${context.conversationId}）\n\n${p.text}\n\n上下文 ${context.contextHash}`,
	};
}
export async function planSend(sql: Sql, p: SendInput): Promise<Planned[][]> {
	const context = await contextById(sql, p.shop, p.conversationId, p.contextId);
	assertInput(p, context);
	const result = await sql.begin(async (tx) => {
		await tx`insert into chat_intents (request_id, shop, shop_id, conversation_id, input, context_id) values (${p.requestId}, ${p.shop}, ${context.shopId}, ${p.conversationId}, ${tx.json(p as Json)}, ${p.contextId}) on conflict do nothing`;
		const [old] = await tx<{ input: SendInput; claimed: boolean }[]>`select input, claimed from chat_intents where request_id = ${p.requestId} for update`;
		if (!old || !sameIntent(old.input, p)) throw new Error("同一 requestId 已绑定不同正文、店铺或上下文");
		if (old.claimed) return false;
		await tx`update chat_intents set claimed = true where request_id = ${p.requestId}`;
		return true;
	});
	return result ? [[{ op: "聊聊回复", params: { ...p, context } }]] : [];
}
export const CHAT_WRITES = { 聊聊回复: writeOp(replyWrite()) };

export async function replaySend(sql: Sql, p: SendInput): Promise<Outcome> {
	const [intent] = await sql<
		{ input: SendInput }[]
	>`select input from chat_intents where request_id = ${p.requestId} and shop = ${p.shop} and conversation_id = ${p.conversationId}`;
	if (!intent || !sameIntent(intent.input, p)) throw new Error("发送请求引用不存在或内容不一致");
	const rows = await sql<
		{ id: string; batch: string; op: string; display: string; status: string; why: string | null }[]
	>`select id::text, batch::text, op, display, status, error as why from writes where op = '聊聊回复' and key = ${`chat-reply:${p.requestId}`} order by id`;
	if (!rows.length) return { ran: [], unknown: true, blocked: "此requestId已被占用但尚无可核对写入记录，未再次发送" };
	const ran: Ran[] = rows.map((row) => ({ ...row, id: WriteId.parse(row.id), ...(row.why ? { why: row.why } : { why: undefined }) }));
	return { ran, unknown: rows.some((r) => ["待执行", "已提交", "结果未知", "不一致"].includes(r.status)), blocked: null };
}
