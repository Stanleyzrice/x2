// 聊聊（卖家中心的买家聊天）。查过的事实（2026-09-30）：
// - 接口要聊聊自己的 token：打开聊聊页、页面自己登录一次，存在 localStorage 的 chat-session（{ token, p_token }），几个小时就失效（回 401）；
//   卖家中心的登录不受影响。请求头 Authorization: Bearer <token>、x-shop-region: TW，查询参数 csrf_token=<p_token>
// - 响应没有 code 外壳（会话、消息是数组），按 HTTP 状态判
// - 发消息走 WebSocket（页面的 SharedWorker webchat/worker.js，socket.io），不是 HTTP；没有写成函数，见同目录的 NOTES.md。
//   旧研究里的 agent/send_message 是跟 Shopee 官方客服聊的，不是跟买家
// - 不调 conversation/enter、conversation/open：会把消息标成已读

import { z } from "zod";
import { page } from "../../../platform/browser/browser.ts";
import { NeedsHuman } from "../../../platform/errors.ts";
import { reply } from "../../../platform/reply.ts";
import { ORIGIN, shop } from "./seller.ts";

const id = z.union([z.string(), z.number()]);
/** 一个会话：只写认谁发的、一句话、时间要用的格（tools/chat/talk.ts），值不改 */
export const conversation = z.looseObject({
	id,
	to_id: id.nullish(),
	to_name: z.string().nullish(),
	latest_message_type: z.string().nullish(),
	latest_message_content: z.unknown().optional(),
	latest_message_from_id: id.nullish(),
	latest_message_source: z.string().nullish(),
	last_message_state: z.string().nullish(),
	last_message_time_nano: id.nullish(),
	unread_count: id.nullish(),
	next_timestamp_nano: id.nullish(),
});
export type Conversation = z.output<typeof conversation>;
/** 一条消息（消息的 shop_id 是 0：谁发的按 from_shop_id 认） */
export const message = z.looseObject({
	id,
	from_shop_id: id.nullish(),
	status: z.string().nullish(),
	source: z.string().nullish(),
	type: z.string(),
	content: z.unknown().optional(),
	created_timestamp: id,
});
export type Message = z.output<typeof message>;

const CHAT_PAGE = `${ORIGIN}/new-webchat/conversations`;
const API = "/webchat/api/v1.2";

/** 打开聊聊页，等页面登录完（它会发一个 GET unread-count），刷新 localStorage 里的 token */
async function refresh(): Promise<void> {
	const p = await page(ORIGIN);
	await p.goto(CHAT_PAGE);
	for (let i = 0; i < 40; i++) {
		const ok = await p.run(() => performance.getEntriesByType("resource").some((e) => e.name.includes("/webchat/api/v1.2/conversation/unread-count")));
		if (ok) return;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new NeedsHuman("聊聊页 20 秒还没登录完：在浏览器里打开聊聊看看");
}

async function webchat<S extends z.ZodType>(
	path: string,
	schema: S,
	req: { method?: "GET" | "POST"; query?: Record<string, string | number | boolean>; body?: unknown } = {},
): Promise<z.output<S>> {
	for (const again of [false, true]) {
		if (again) await refresh();
		const p = await page(ORIGIN);
		const r = await p.run(
			async (path: string, method: string, query: Record<string, string>, body: string | null) => {
				const s = JSON.parse(localStorage.getItem("chat-session") ?? "null") as { token?: string; p_token?: string } | null;
				if (!s?.token) return { status: 401, json: null };
				const url = new URL(path, location.origin);
				url.searchParams.set("csrf_token", String(s.p_token));
				for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
				const res = await fetch(url.href, {
					method,
					credentials: "include",
					headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json", "x-shop-region": "TW" },
					body: body ?? undefined,
				});
				return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
			},
			`${API}${path}`,
			req.method ?? (req.body === undefined ? "GET" : "POST"),
			Object.fromEntries(Object.entries(req.query ?? {}).map(([k, v]) => [k, String(v)])),
			req.body === undefined ? null : JSON.stringify(req.body),
		);
		if (r.status === 401 && !again) continue;
		if (r.status >= 400)
			throw new Error(`聊聊 ${path} 回 HTTP ${r.status}：${z.looseObject({ message: z.unknown().optional() }).safeParse(r.json).data?.message ?? ""}`);
		return reply(schema, r.json, `聊聊 ${path}`);
	}
	throw new NeedsHuman("聊聊的 token 刷新以后还是 401：在浏览器里打开聊聊看看");
}

/** 会话列表的一页（50 个），按最后一条消息从新到旧。翻页：cursor 用这一页最后一个的 next_timestamp_nano */
export async function conversations(cursor = ""): Promise<Conversation[]> {
	return webchat("/conversations", z.array(conversation), {
		body: { next_timestamp_nano: cursor, direction: "older", biz_id: 0, on_message_received: true, _s: 12 },
	});
}

/** 「未回覆」列表的一页（和运营在聊聊里看到的一样，自动回复发出后也还在）。翻页用回的 page_result.next_cursor.next_message_time_nano */
export async function unreplied(cursor = ""): Promise<{ next: string | null; rows: Conversation[] }> {
	const shape = z.looseObject({
		page_result: z.looseObject({ has_more: z.boolean().nullish(), next_cursor: z.looseObject({ next_message_time_nano: id.nullish() }).nullish() }).nullish(),
		conversations: z.array(conversation).nullish(),
	});
	const b = await webchat("/conversation/list", shape, {
		body: { direction: "older", biz_id: 0, on_message_received: true, _s: 12, type: "unreplied", sort: 1, next_timestamp_nano: cursor },
	});
	return { next: b.page_result?.has_more ? String(b.page_result.next_cursor?.next_message_time_nano ?? "") : null, rows: b.conversations ?? [] };
}

/** 一个会话最近的 30 条消息（含最新的一条）。消息的 shop_id 是 0：谁发的按 from_shop_id 认 */
export async function messages(conversationId: string, shopId?: string): Promise<Message[]> {
	const sid = shopId ?? (await shop()).shopId;
	return webchat(`/conversations/${conversationId}/messages`, z.array(message), {
		query: { direction: "older", limit: 30, biz_id: 0, shop_id: sid, on_message_received: true },
	});
}
