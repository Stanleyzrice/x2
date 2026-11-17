// 人工选品的界面状态、发布恢复与本地记忆；只使用工具返回的事实，不推测未知写入的结果。
import { z } from "zod";
import type { CollectionSession, PublishReceipt, SourceItem, SourceReceipt } from "./source-types.ts";

export const collectionStatusLabels: Record<CollectionSession["status"], string> = {
	browsing: "采集已启用",
	scanning: "正在扫描当前页",
	collecting: "正在采集当前页",
	complete: "本次采集完成",
	stopped: "采集已停止",
	error: "采集需要处理",
};

export const sourceCanPublish = (item: SourceItem) => item.status !== "listed" && item.status !== "unknown";
export const sourceCanSelect = (item: SourceItem) => sourceCanPublish(item) || item.deletable;

const publishReceipt = z.object({
	requestId: z.string().regex(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i),
	state: z.enum(["prepared", "running", "completed", "unknown"]),
	token: z.string().optional().catch(undefined),
	error: z.string().optional().catch(undefined),
});

export function publishReceiptOf(raw: string | null): PublishReceipt | null {
	try {
		const result = publishReceipt.safeParse(JSON.parse(raw ?? "null"));
		if (!result.success) return null;
		const { requestId, state, token, error } = result.data;
		return { requestId, state, ...(token === undefined ? {} : { token }), ...(error === undefined ? {} : { error }) };
	} catch {
		return null;
	}
}

export const currentPublishResult = (receipt: PublishReceipt | null | undefined, result: SourceReceipt | null): SourceReceipt | null =>
	receipt && result?.requestId === receipt.requestId ? result : null;

export function publishUnresolved(receipt: PublishReceipt | null | undefined, result: SourceReceipt | null): boolean {
	const state = currentPublishResult(receipt, result)?.state ?? receipt?.state;
	return state === "running" || state === "unknown";
}
