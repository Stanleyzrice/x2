// Shopee Chat 的限定会话读取，校验账号与翻页连续性；不标已读、不发送。
import { randomUUID } from "node:crypto";
import { type ChatTarget, conversations, messages, type Conversation as Raw, sendMessage, unreplied } from "../../connectors/sites/shopee/chat.ts";
import { shop as identity } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import type { Sent } from "../../platform/tool.ts";
import { type Context, makeContext, type Target } from "./context.ts";
import { compareMessages, conversationsOf, type Message, messagesOf } from "./talk.ts";
import { recentTargets } from "./targets.ts";
import { type HistoryWindow, inWindow } from "./window.ts";

const displayTargets = recentTargets();
function target(shop: string, account: { shopId: string; userId: string }, c: Raw): Target {
	if (c.shop_id != null && String(c.shop_id) !== account.shopId) throw new Error("Shopee Chat 返回其他店铺的会话");
	if (!c.to_id || c.official_chat?.official_conv_type || (c.opposite_user_role != null && c.opposite_user_role !== 1)) throw new Error("不是可确认的买家会话");
	return {
		shop,
		shopId: account.shopId,
		userId: account.userId,
		conversationId: String(c.id),
		buyerId: String(c.to_id),
		buyerName: c.to_name ?? String(c.to_id),
	};
}
function nextConversation(rows: Raw[], cursor = ""): string | null {
	if (rows.length < 50) return null;
	const next = String(rows.at(-1)?.next_timestamp_nano ?? "");
	if (!next || next === cursor) throw new Error("Shopee 会话翻页没有前进");
	return next;
}
async function find(id: string): Promise<Raw> {
	let cursor = "";
	const seen = new Set<string>();
	for (;;) {
		const rows = await conversations(cursor),
			hit = rows.find((r) => String(r.id) === id);
		if (hit) return hit;
		const next = nextConversation(rows, cursor);
		if (!next) throw new Error("当前店铺没有这个会话");
		if (seen.has(next)) throw new Error("Shopee 会话分页循环");
		seen.add(next);
		cursor = next;
	}
}
export function visibleConversations(rows: Raw[], waiting: Raw[], window: HistoryWindow) {
	return conversationsOf(
		rows,
		waiting.filter((r) => rows.some((x) => String(x.id) === String(r.id))),
	).filter((c) => inWindow(c.lastAt, window));
}
export async function listConversations(shop: string, cursor: string | undefined, window: HistoryWindow) {
	return inAccount("shopee", shop, async () => {
		const a = await identity(),
			rows = await conversations(cursor),
			waiting = cursor ? [] : (await unreplied()).rows;
		for (const r of rows) if (r.shop_id != null && String(r.shop_id) !== a.shopId) throw new Error("会话列表店铺身份不一致");
		const after = await identity();
		if (after.shopId !== a.shopId || after.userId !== a.userId) throw new Error("读取期间切换了账号");
		for (const row of rows) {
			if (!row.to_id || row.official_chat?.official_conv_type || (row.opposite_user_role != null && row.opposite_user_role !== 1)) continue;
			displayTargets.remember(target(shop, a, row));
		}
		return {
			shop,
			shopId: a.shopId,
			rows: visibleConversations(rows, waiting, window),
			next: nextConversation(rows, cursor),
			window,
			capturedAt: new Date().toISOString(),
			scope: `仅返回滚动${window.days}天窗口内的会话；next沿用外站分页，不据单页推断更早页面没有窗口内数据`,
		};
	});
}
export async function readMessageRange(
	fetchPage: (offset?: string) => Promise<Message[]>,
	previous?: Pick<Context, "messages" | "nextCursor">,
	cursor?: string,
	window?: HistoryWindow,
) {
	if (cursor && (!previous || previous.nextCursor !== cursor)) throw new Error("历史分页引用不连续，请重新加载会话");
	const eligiblePrevious = window ? previous?.messages.filter((m) => inWindow(m.at, window)) : previous?.messages;
	let oldest = eligiblePrevious?.[0]?.id,
		reachedEnd = Boolean(oldest && previous?.nextCursor === null),
		crossedWindow = false;
	if (cursor && oldest) {
		const rawOlder = await fetchPage(cursor),
			older = window ? rawOlder.filter((m) => inWindow(m.at, window)) : rawOlder;
		if (older.length && older[0]!.id === oldest) throw new Error("消息分页没有前进");
		oldest = older[0]?.id ?? oldest;
		const olderCrossed = Boolean(window && rawOlder.some((m) => Date.parse(m.at) < Date.parse(window.from)));
		reachedEnd = rawOlder.length < 30 || olderCrossed;
	}
	const all = new Map<string, Message>(),
		seen = new Set<string>();
	let offset: string | undefined,
		found = !oldest,
		lastFull = false;
	for (let n = 0; n < 50; n++) {
		const rawPage = await fetchPage(offset),
			page = window ? rawPage.filter((m) => inWindow(m.at, window)) : rawPage;
		lastFull = rawPage.length === 30;
		crossedWindow ||= Boolean(window && rawPage.some((m) => Date.parse(m.at) < Date.parse(window.from)));
		for (const m of page) {
			const old = all.get(m.id);
			if (old && JSON.stringify(old) !== JSON.stringify(m)) throw new Error("读取期间消息内容变化，请重新读取");
			all.set(m.id, m);
		}
		if (oldest && page.some((m) => m.id === oldest)) {
			found = true;
			break;
		}
		if ((!oldest && (page.length > 0 || crossedWindow)) || !lastFull || crossedWindow) break;
		const next = rawPage[0]!.id;
		if (seen.has(next)) throw new Error("消息分页没有前进");
		seen.add(next);
		offset = next;
	}
	if (!found && oldest) throw new Error("历史上下文未完整读回，不能用于建议或发送");
	const sorted = [...all.values()].sort(compareMessages),
		boundary = oldest ? sorted.findIndex((m) => m.id === oldest) : 0;
	const list = sorted.slice(boundary);
	const more = boundary > 0 || (lastFull && !reachedEnd && !crossedWindow);
	return { messages: list, next: more ? (list[0]?.id ?? null) : null };
}

export type ChatDriver = {
	read: (shop: string, conversationId: string, previous?: Context, cursor?: string, window?: HistoryWindow) => Promise<Context>;
	readEvidence?: (context: Context) => Promise<Context>;
	send: (target: ChatTarget, text: string) => Promise<Sent>;
};
async function readChat(
	shop: string,
	conversationId: string,
	previous: Context | undefined,
	cursor: string | undefined,
	window: HistoryWindow | null,
	display = false,
): Promise<Context> {
	return inAccount("shopee", shop, async () => {
		const a = await identity(),
			cached = display ? displayTargets.peek(shop, a, conversationId) : undefined,
			t = cached ?? target(shop, a, await find(conversationId));
		if (previous && (previous.shop !== shop || previous.shopId !== a.shopId || previous.conversationId !== conversationId || previous.buyerId !== t.buyerId))
			throw new Error("历史上下文不属于当前店铺或会话");
		const range = await readMessageRange(
			(offset) => messages(conversationId, a.shopId, offset).then((rows) => messagesOf(rows, a.shopId)),
			previous,
			cursor,
			window ?? undefined,
		);
		const after = await identity();
		if (after.shopId !== a.shopId || after.userId !== a.userId) throw new Error("读取期间切换了账号");
		if (!cached) displayTargets.remember(t);
		return makeContext(t, range.messages, range.next, randomUUID(), new Date(), window ?? undefined);
	});
}
export const readDisplay = (shop: string, conversationId: string, previous: Context | undefined, cursor: string | undefined, window: HistoryWindow) =>
	readChat(shop, conversationId, previous, cursor, window, true);
export const chatDriver: ChatDriver = {
	read: (shop, conversationId, previous, cursor, window) => {
		if (!window) throw new Error("读取 Chat 必须显式指定窗口");
		return readChat(shop, conversationId, previous, cursor, window);
	},
	readEvidence: (context) =>
		readChat(context.shop, context.conversationId, { ...context, messages: context.messages.slice(-1), nextCursor: null }, undefined, null),
	send: (t, text) => inAccount("shopee", t.shopId, () => sendMessage(t, text)),
};
