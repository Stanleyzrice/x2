// Chat 上下文的身份、内容指纹和发送确认约束；不选择客服政策。
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ChatTarget } from "../../connectors/sites/shopee/chat.ts";
import type { Message } from "./talk.ts";
import { type HistoryWindow, inWindow } from "./window.ts";

export type Target = ChatTarget & { shop: string };
export type Context = Target & {
	id: string;
	messages: Message[];
	contextHash: string;
	latestBuyerId: string | null;
	capturedAt: string;
	window?: HistoryWindow;
	nextCursor: string | null;
	range: { from: string | null; to: string | null; count: number; complete: boolean };
};
export const sendInput = z.object({
	shop: z.string().min(1),
	conversationId: z.string().min(1),
	contextId: z.string().uuid(),
	requestId: z.string().uuid(),
	text: z.string().trim().min(1).max(2000),
	contextHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SendInput = z.infer<typeof sendInput>;
export function contextHash(target: Target, messages: Message[], window?: HistoryWindow): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				target: {
					shop: target.shop,
					shopId: target.shopId,
					userId: target.userId,
					conversationId: target.conversationId,
					buyerId: target.buyerId,
					buyerName: target.buyerName,
				},
				messages: messages.map((m) => [m.id, m.sender, m.text, m.at]),
				windowDays: window?.days ?? null,
			}),
		)
		.digest("hex");
}
export function makeContext(target: Target, messages: Message[], nextCursor: string | null, id: string, now = new Date(), window?: HistoryWindow): Context {
	return {
		...target,
		id,
		messages,
		contextHash: contextHash(target, messages, window),
		latestBuyerId: messages.filter((m) => m.sender === "buyer").at(-1)?.id ?? null,
		capturedAt: now.toISOString(),
		...(window ? { window } : {}),
		nextCursor,
		range: { from: messages[0]?.at ?? null, to: messages.at(-1)?.at ?? null, count: messages.length, complete: nextCursor === null },
	};
}
export function assertSuggestionContext(context: Context): void {
	const window = context.window;
	if (!window) throw new Error("上下文缺少明确读取窗口，未调用付费模型生成建议");
	if (!context.messages.some((m) => m.sender === "buyer" && inWindow(m.at, window))) throw new Error("当前读取窗口没有可用的买家消息，未调用付费模型生成建议");
}
export function assertInput(input: SendInput, context: Context): void {
	if (
		input.shop !== context.shop ||
		input.conversationId !== context.conversationId ||
		input.contextId !== context.id ||
		input.contextHash !== context.contextHash
	)
		throw new Error("店铺、会话或上下文引用改变，请重新读取并确认");
	if (!context.latestBuyerId) throw new Error("没有可确认的买家消息，不能发送");
}
export function assertFresh(expected: Context, live: Context): void {
	if (
		expected.shopId !== live.shopId ||
		expected.userId !== live.userId ||
		expected.buyerId !== live.buyerId ||
		expected.conversationId !== live.conversationId ||
		expected.window?.days !== live.window?.days ||
		expected.contextHash !== live.contextHash
	)
		throw new Error("账号、收件方或上下文已更新，请重新读取、检查正文并确认");
}
export function sameIntent(a: SendInput, b: SendInput): boolean {
	return (
		a.shop === b.shop &&
		a.conversationId === b.conversationId &&
		a.contextId === b.contextId &&
		a.contextHash === b.contextHash &&
		a.text === b.text &&
		a.requestId === b.requestId
	);
}
export const targetOf = (c: Context): Target => ({
	shop: c.shop,
	shopId: c.shopId,
	userId: c.userId,
	conversationId: c.conversationId,
	buyerId: c.buyerId,
	buyerName: c.buyerName,
});
