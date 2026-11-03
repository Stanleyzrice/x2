// Chat 的首次发送口径：只有已读回核对的回复记录才能免去后续逐次试跑标记。
import type { Sql } from "../../platform/db/index.ts";

export async function replyTried(sql: Sql): Promise<boolean> {
	return (await sql`select 1 from writes where op = '聊聊回复' and status = '已核对' limit 1`).length > 0;
}
