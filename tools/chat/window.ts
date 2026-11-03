// Chat 的明确读取窗口：按服务端当前时间滚动，不删除原始事实或发送证据。
import { z } from "zod";

export const historyDays = z
	.preprocess((value) => (typeof value === "string" && value.trim() ? Number(value) : value), z.number().int().positive())
	.describe("调用方明确指定的读取窗口天数（正整数）");
export type HistoryWindow = { days: number; from: string; to: string };
export function rollingWindow(days: number, now = new Date()): HistoryWindow {
	const checked = historyDays.parse(days);
	const from = new Date(now.getTime() - checked * 24 * 60 * 60_000);
	if (!Number.isFinite(from.getTime()) || !Number.isFinite(now.getTime())) throw new Error("读取窗口超出有效日期范围");
	return { days: checked, from: from.toISOString(), to: now.toISOString() };
}
export function currentContextWindow(context: { window?: HistoryWindow; messages: { at: string }[] }, now = new Date()): HistoryWindow {
	const frozen = context.window;
	if (!frozen) throw new Error("上下文缺少明确读取窗口，请重新读取并确认");
	const original = rollingWindow(frozen.days, new Date(frozen.to));
	if (original.from !== frozen.from) throw new Error("上下文窗口范围无效，请重新读取并确认");
	const current = rollingWindow(frozen.days, now);
	if (context.messages.some((m) => !inWindow(m.at, current))) throw new Error("上下文消息已超出当前读取窗口，请重新读取并确认");
	return current;
}
export function inWindow(at: string | null, window: HistoryWindow): boolean {
	if (at === null) return false;
	const time = Date.parse(at);
	return Number.isFinite(time) && time >= Date.parse(window.from) && time <= Date.parse(window.to);
}
