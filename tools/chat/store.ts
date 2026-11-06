// Chat 运行事实与版本的薄持久层；上下文按身份和内容指纹去重，人工稿只接受明确版本。
import type { Json, Sql } from "../../platform/db/index.ts";
import type { Context } from "./context.ts";
import { replyTried } from "./trial.ts";

export async function saveContext(sql: Sql, context: Context): Promise<Context> {
	const [r] = await sql<
		{ data: Context }[]
	>`insert into chat_contexts (id, shop, shop_id, conversation_id, context_hash, data) values (${context.id}, ${context.shop}, ${context.shopId}, ${context.conversationId}, ${context.contextHash}, ${sql.json(context as unknown as Json)}) on conflict (shop, shop_id, conversation_id, context_hash) do update set data = jsonb_set(excluded.data, '{id}', to_jsonb(chat_contexts.id)) returning data`;
	return r!.data;
}
export async function contextById(sql: Sql, shop: string, conversationId: string, id: string): Promise<Context> {
	const [r] = await sql<{ data: Context }[]>`select data from chat_contexts where id = ${id} and shop = ${shop} and conversation_id = ${conversationId}`;
	if (!r) throw new Error("没有这个店铺、会话的上下文引用，请重新读取");
	return r.data;
}
export async function threadState(sql: Sql, context: Context) {
	// 各项互不依赖，避免共享远端库的延迟按查询次数累加；最新 intent 的写入状态最后读取。
	const [[draft], [suggestion], [intent], [pending], tried] = await Promise.all([
		sql<
			{ text: string; revision: number }[]
		>`select text, revision from chat_drafts where shop = ${context.shop} and shop_id = ${context.shopId} and conversation_id = ${context.conversationId}`,
		sql<
			{ id: string; text: string; context_hash: string; model: string; latest_buyer_id: string | null }[]
		>`select id, text, context_hash, model, latest_buyer_id from chat_suggestions where shop = ${context.shop} and shop_id = ${context.shopId} and conversation_id = ${context.conversationId} order by created_at desc limit 1`,
		sql<
			{ request_id: string }[]
		>`select request_id from chat_intents where shop = ${context.shop} and shop_id = ${context.shopId} and conversation_id = ${context.conversationId} order by created_at desc limit 1`,
		sql<
			{ key: string; status: string; error: string | null }[]
		>`select key, status, error from writes where op = '聊聊回复' and target = ${`chat:${context.shopId}:${context.conversationId}`} and status in ('待执行', '已提交', '结果未知', '不一致') order by id desc limit 1`,
		replyTried(sql),
	]);
	const [write] = intent
		? await sql<
				{ status: string; error: string | null }[]
			>`select status, error from writes where op = '聊聊回复' and key = ${`chat-reply:${intent.request_id}`} order by id desc limit 1`
		: [];
	return {
		draft: draft ?? { text: "", revision: 0 },
		suggestion: suggestion
			? {
					id: suggestion.id,
					text: suggestion.text,
					contextHash: suggestion.context_hash,
					model: suggestion.model,
					latestBuyerId: suggestion.latest_buyer_id,
					stale: suggestion.context_hash !== context.contextHash,
				}
			: null,
		reply: pending
			? { requestId: pending.key.replace(/^chat-reply:/, "").split("#")[0]!, status: pending.status, error: pending.error }
			: intent
				? { requestId: intent.request_id, status: write?.status ?? "未提交", error: write?.error ?? null }
				: null,
		trialRequired: !tried,
	};
}
export async function saveDraft(sql: Sql, c: Context, text: string, revision: number) {
	const rows = await sql<
		{ text: string; revision: number }[]
	>`insert into chat_drafts (shop, shop_id, conversation_id, text, revision) select ${c.shop}, ${c.shopId}, ${c.conversationId}, ${text}, 1 where ${revision} = 0 on conflict (shop, shop_id, conversation_id) do update set text = excluded.text, revision = chat_drafts.revision + 1, updated_at = now() where chat_drafts.revision = ${revision} returning text, revision`;
	if (rows[0]) return rows[0];
	if (revision > 0) {
		const changed = await sql<
			{ text: string; revision: number }[]
		>`update chat_drafts set text = ${text}, revision = revision + 1, updated_at = now() where shop = ${c.shop} and shop_id = ${c.shopId} and conversation_id = ${c.conversationId} and revision = ${revision} returning text, revision`;
		if (changed[0]) return changed[0];
	}
	throw new Error("草稿版本已更新，未覆盖另一处的编辑；请保留本地内容并重新读取");
}
