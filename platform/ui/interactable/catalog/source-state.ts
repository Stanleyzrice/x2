// 人工选品的界面状态、发布恢复与本地记忆；只使用工具返回的事实，不推测未知写入的结果。
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

export function publishReceiptOf(raw: string | null): PublishReceipt | null {
	try {
		const value: unknown = JSON.parse(raw ?? "null");
		if (!value || typeof value !== "object") return null;
		const receipt = value as Partial<PublishReceipt>;
		if (
			typeof receipt.requestId !== "string" ||
			!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(receipt.requestId) ||
			!receipt.state ||
			!["prepared", "running", "completed", "unknown"].includes(receipt.state)
		)
			return null;
		return {
			requestId: receipt.requestId,
			state: receipt.state,
			...(typeof receipt.token === "string" ? { token: receipt.token } : {}),
			...(typeof receipt.error === "string" ? { error: receipt.error } : {}),
		};
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

export const errorOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
export const saved = (key: string) => {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
};
export const remember = (key: string, value: string | null) => {
	try {
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
	} catch {
		// 本地存储不可用时仍可完成当前操作，结果由服务端保存。
	}
};
