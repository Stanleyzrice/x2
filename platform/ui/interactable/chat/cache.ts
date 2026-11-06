// 只在当前浏览器会话中回显读取过的 Chat 快照；每次打开仍现读，不据快照保存草稿或发送。
import { readCache } from "../../read-cache.ts";

export type Conversation = { id: string; buyer: string; lastText: string; lastAt: string | null; unread: number; unreplied: boolean };
export type Window = { days: number; from: string; to: string };
export type Inbox = { shop: string; rows: Conversation[]; next: string | null; capturedAt: string; scope: string; window: Window };
export type Msg = { id: string; sender: "buyer" | "us" | "auto" | "platform" | "other_auto"; text: string; at: string };
export type Suggestion = { id: string; text: string; contextHash: string; model: string };
export type ThreadData = {
	context: {
		id: string;
		shopId: string;
		buyerName: string;
		buyerId: string;
		messages: Msg[];
		window?: Window;
		capturedAt: string;
		contextHash: string;
		latestBuyerId: string | null;
		nextCursor: string | null;
		range: { from: string | null; to: string | null; count: number; complete: boolean };
	};
	draft: { text: string; revision: number };
	suggestion: Suggestion | null;
	reply: { requestId: string; status: string; error: string | null } | null;
	trialRequired: boolean;
};

export const inboxSnapshots = readCache<Inbox>(0, 10);
export const threadSnapshots = readCache<ThreadData>(0, 60);
export const snapshotKey = (item: string, shop: string, days: number, conversationId?: string) => JSON.stringify([item, shop, days, conversationId ?? null]);
