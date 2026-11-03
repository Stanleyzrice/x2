// 待核对发送只读取所属店铺的持久状态元数据，不读取消息正文、不发起发送。
import type { Sql } from "../../platform/db/index.ts";

export async function pendingReplies(sql: Sql, shop: string) {
	const rows = await sql<
		{
			conversation_id: string;
			buyer_name: string | null;
			request_id: string;
			status: string;
			error: string | null;
		}[]
	>`select i.conversation_id, c.data->>'buyerName' as buyer_name, i.request_id, w.status, w.error
		from chat_intents i join writes w on w.key = 'chat-reply:' || i.request_id
		left join chat_contexts c on c.id = i.context_id and c.shop = i.shop and c.shop_id = i.shop_id and c.conversation_id = i.conversation_id
		where i.shop = ${shop} and w.op = '聊聊回复'
		and w.target = 'chat:' || i.shop_id || ':' || i.conversation_id
		and w.status in ('待执行', '已提交', '结果未知', '不一致') order by w.id desc`;
	return {
		shop,
		rows: rows.map((r) => ({ conversationId: r.conversation_id, buyerName: r.buyer_name, requestId: r.request_id, status: r.status, error: r.error })),
		capturedAt: new Date().toISOString(),
	};
}
