// Chat：会话事实、人工草稿与版本化建议；发送只经写工具和至多一次写入引擎。
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { suggest } from "../../connectors/services/penna/api.ts";
import { db } from "../../platform/db/index.ts";
import { get, str, type Toolkit, write } from "../../platform/tool.ts";
import { exclusive } from "../../platform/writes.ts";
import { assertSuggestionContext, sendInput } from "./context.ts";
import { pendingReplies } from "./pending.ts";
import { listConversations, readDisplay } from "./read.ts";
import { contextById, saveContext, saveDraft, threadState } from "./store.ts";
import { draftPrompt } from "./talk.ts";
import { historyDays, rollingWindow } from "./window.ts";
import { CHAT_WRITES, planSend, preview, type ReplyParams, replaySend, replyWrite } from "./writes.ts";

const shop = str("店铺账号名或店铺id");
const conversation = z.object({ shop, conversationId: str("选中的买家会话id") });
const projectPolicy = ".agents/skills/chat/SKILL.md";
const suggestionInput = conversation.extend({
	historyDays,
	contextId: z.string().uuid().describe("messages 返回的会话上下文编号"),
	policyPath: z.literal(projectPolicy).default(projectPolicy).describe("本项目的客服规则"),
});
const contextInput = conversation
	.extend({ historyDays, contextId: z.string().uuid().optional(), cursor: z.string().min(1).optional() })
	.refine((p) => !p.cursor || p.contextId !== undefined, { path: ["contextId"], message: "读取下一页须带上上一页的 context.id" });
async function readContext(p: z.infer<typeof contextInput>) {
	const sql = await db();
	const previous = p.contextId ? await contextById(sql, p.shop, p.conversationId, p.contextId) : undefined;
	const context = await saveContext(sql, await readDisplay(p.shop, p.conversationId, previous, p.cursor, rollingWindow(p.historyDays)));
	return { context, ...(await threadState(sql, context)) };
}
export const chat: Toolkit = {
	name: "chat",
	title: "买家聊聊：读取、回复建议、人工草稿和确认发送",
	kind: "tool",
	schema: new URL("./schema.sql", import.meta.url),
	tools: {
		pending: get("读取本店持久待核对发送的元数据；不返回旧消息正文、不发送", z.object({ shop }), async (p) => pendingReplies(await db(), p.shop)),
		conversations: get("读取指定店铺的一页买家会话，返回rows、next与采集范围", z.object({ shop, cursor: z.string().optional(), historyDays }), (p) =>
			listConversations(p.shop, p.cursor, rollingWindow(p.historyDays)),
		),
		messages: get("现读所选会话的上下文，返回范围、指纹、建议、人工稿和发送状态；cursor仅连续向前加载", contextInput, readContext),
		draft: get("经Penna gateway DeepSeek生成绑定上下文的建议；不覆盖人工草稿、不发送", suggestionInput, async (p) => {
			const { context } = await readContext(p),
				sql = await db();
			assertSuggestionContext(context);
			const instructions = (await readFile(new URL(`../../${p.policyPath}`, import.meta.url), "utf8")).trim();
			if (!instructions) throw new Error("客服规则是空的");
			const result = await suggest(instructions, draftPrompt(p.shop, context.messages));
			const text = z.string().trim().min(1).max(2000).parse(result.text),
				id = randomUUID();
			await sql`insert into chat_suggestions (id, shop, shop_id, conversation_id, context_id, context_hash, latest_buyer_id, text, model) values (${id}, ${p.shop}, ${context.shopId}, ${p.conversationId}, ${context.id}, ${context.contextHash}, ${context.latestBuyerId}, ${text}, ${result.model})`;
			return {
				id,
				text,
				model: result.model,
				contextId: context.id,
				contextHash: context.contextHash,
				shop: p.shop,
				shopId: context.shopId,
				conversationId: p.conversationId,
				latestBuyerId: context.latestBuyerId,
				range: context.range,
				window: context.window,
			};
		}),
		"save-draft": get(
			"按明确revision保存人工草稿；冲突不覆盖已有编辑",
			conversation.extend({ contextId: z.string().uuid(), text: z.string().max(2000), revision: z.coerce.number().int().nonnegative() }),
			async (p) => {
				const sql = await db(),
					context = await contextById(sql, p.shop, p.conversationId, p.contextId);
				return saveDraft(sql, context, p.text, p.revision);
			},
		),
		preview: get("读取精确收件方与待发正文，生成确认显示；不发送", sendInput, async (p) => preview(await db(), p)),
		send: { ...write("仅发送用户确认的精确正文和上下文；requestId绑定内容，结果未知不重发", sendInput, planSend), replay: replaySend },
		reconcile: get("只读回核对所选会话已有发送请求；不提交、不重发", conversation.extend({ requestId: z.string().uuid() }), async (p) => {
			const sql = await db();
			return exclusive(sql, async (lock) => {
				const [intent] =
					await sql`select shop_id from chat_intents where request_id = ${p.requestId} and shop = ${p.shop} and conversation_id = ${p.conversationId}`;
				if (!intent) throw new Error("没有这个店铺会话的发送请求");
				const [w] = await sql<
					{ id: string; params: ReplyParams; readback: { before?: { ids: string[] } } | null; status: string; error: string | null }[]
				>`select id::text, params, readback, status, error from writes where op = '聊聊回复' and key = ${`chat-reply:${p.requestId}`} order by id desc limit 1`;
				if (!w) return { requestId: p.requestId, status: "未提交", error: null };
				if (!["已提交", "结果未知", "不一致"].includes(w.status)) return { requestId: p.requestId, status: w.status, error: w.error };
				const check = await replyWrite().check(w.params, w.readback?.before, false);
				if (check.done === true) {
					const updated =
						await sql`update writes set status = '已核对', error = null, finished_at = now() where id = ${w.id} and status in ('已提交', '结果未知', '不一致') and exists (select 1 from pg_locks where pid = ${lock} and locktype = 'advisory' and granted) returning id`;
					if (!updated.length) throw new Error("核对锁或写入状态已改变，未更新状态；请重新核对");
				}
				return {
					requestId: p.requestId,
					status: check.done === true ? "已核对" : "结果未知",
					error: check.done === true ? null : "未找到可确认的新消息；没有重新发送",
				};
			});
		}),
	},
	writes: CHAT_WRITES,
};
