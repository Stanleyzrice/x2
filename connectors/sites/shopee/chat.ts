// 聊聊（卖家中心的买家聊天）。查过的事实（2026-09-30）：
// - 接口要聊聊自己的 token：打开聊聊页、页面自己登录一次，存在 localStorage 的 chat-session（{ token, p_token }），几个小时就失效（回 401）；
//   卖家中心的登录不受影响。请求头 Authorization: Bearer <token>、x-shop-region: TW，查询参数 csrf_token=<p_token>
// - 响应没有 code 外壳（会话、消息是数组），按 HTTP 状态判
// - 发消息由页面的 SharedWorker/WebSocket 处理；sendMessage 只触发一次已定位输入框的 Enter，成功须读回核对。
//   旧研究里的 agent/send_message 是跟 Shopee 官方客服聊的，不是跟买家
// - 不调 conversation/enter、conversation/open：会把消息标成已读

import { z } from "zod";
import { page } from "../../../platform/browser/browser.ts";
import { NeedsHuman } from "../../../platform/errors.ts";
import { reply } from "../../../platform/reply.ts";
import { claimSiteSubmission } from "../../../platform/site-write.ts";
import type { Sent } from "../../../platform/tool.ts";
import { ORIGIN, shop } from "./seller.ts";

const id = z.union([z.string(), z.number().int().safe()]);
/** 一个会话：只写认谁发的、一句话、时间要用的格（tools/chat/talk.ts），值不改 */
export const conversation = z.looseObject({
	id,
	to_id: id.nullish(),
	shop_id: id.nullish(),
	to_shop_id: id.nullish(),
	latest_message_id: id.nullish(),
	opposite_user_role: z.number().nullish(),
	official_chat: z.looseObject({ official_conv_type: z.number().nullish() }).nullish(),
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
export async function messages(conversationId: string, shopId?: string, offset?: string): Promise<Message[]> {
	const sid = shopId ?? (await shop()).shopId;
	return webchat(`/conversations/${conversationId}/messages`, z.array(message), {
		query: { direction: "older", limit: 30, biz_id: 0, shop_id: sid, on_message_received: true, ...(offset ? { offset } : {}) },
	});
}

export type ChatTarget = { shopId: string; userId: string; conversationId: string; buyerId: string; buyerName: string; expectedLatestMessageId?: string };

/** 页面只定位并触发一次 Enter；是否发成功由调用方读回消息核对。 */
export async function sendViaChatPage(input: { target: ChatTarget; text: string; timeoutMs?: number }): Promise<Sent> {
	type State = {
		conversationReducer?: { currentConversationId?: string };
		entityReducer?: { conversations?: Record<string, { to_id?: string | number; shop_id?: string | number; latest_message_id?: string | number }> };
	};
	type Store = { getState: () => State };
	type Fiber = { return?: Fiber; memoizedProps?: { store?: Store; value?: { store?: Store } } };
	const store = (): Store | null => {
		for (const node of document.querySelectorAll("*")) {
			const key = Object.keys(node).find((k) => k.startsWith("__reactFiber$"));
			if (!key) continue;
			for (let f = (node as unknown as Record<string, Fiber>)[key]; f; f = f.return) {
				const candidate = f.memoizedProps?.store ?? f.memoizedProps?.value?.store;
				if (candidate?.getState?.().conversationReducer) return candidate;
			}
		}
		return null;
	};
	const { target, text } = input;
	if (![target.shopId, target.buyerId].every((v) => /^\d+$/.test(v) && Number.isSafeInteger(Number(v))))
		return { kind: "refused", why: "Shopee 页面目标 ID 不能安全转换，未发送" };
	window.postMessage(
		{ type: "MiniChatRedirect", userId: Number(target.buyerId), shopId: Number(target.shopId), conversationId: target.conversationId, isFromSearch: true },
		location.origin,
	);
	const until = Date.now() + (input.timeoutMs ?? 15_000);
	let textarea: HTMLTextAreaElement | undefined;
	const matches = () => {
		const state = store()?.getState(),
			active = state?.conversationReducer?.currentConversationId,
			c = state?.entityReducer?.conversations?.[target.conversationId];
		return String(active) === target.conversationId && String(c?.to_id) === target.buyerId && String(c?.shop_id) === target.shopId;
	};
	while (Date.now() < until) {
		if (matches()) {
			const fields = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[placeholder="輸入文字"]')].filter(
				(e) => e.getClientRects().length && !e.disabled,
			);
			if (fields.length === 1) {
				textarea = fields[0];
				break;
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	if (!textarea || textarea.value.trim()) return { kind: "refused", why: "所选会话输入框不可用或已有草稿，未发送" };
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
	if (!setter) return { kind: "refused", why: "Shopee 输入框接口改变，未发送" };
	setter.call(textarea, text);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
	await new Promise((resolve) => setTimeout(resolve, 150));
	const key = Object.keys(textarea).find((k) => k.startsWith("__reactProps$"));
	const props = key ? (textarea as unknown as Record<string, { value?: string; onKeyDown?: unknown }>)[key] : undefined;
	if (!matches() || props?.value !== text || typeof props?.onKeyDown !== "function") return { kind: "refused", why: "发送前目标或正文改变，未发送" };
	const latest = store()?.getState().entityReducer?.conversations?.[target.conversationId]?.latest_message_id;
	if (!target.expectedLatestMessageId || String(latest) !== target.expectedLatestMessageId)
		return { kind: "refused", why: "发送前有新消息或无法确认最新消息，未发送；请重新读取并确认" };
	textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
	return { kind: "unknown", why: "已触发单次发送，须读回消息核对" };
}

export async function sendMessage(target: ChatTarget, text: string): Promise<Sent> {
	claimSiteSubmission();
	const current = await shop();
	if (current.shopId !== target.shopId || current.userId !== target.userId) return { kind: "refused", why: "发送前店铺账号改变" };
	const p = await page(ORIGIN);
	if (!(await p.run(() => location.pathname.startsWith("/new-webchat/")))) await p.goto(CHAT_PAGE);
	return p.run(sendViaChatPage, { target, text });
}
