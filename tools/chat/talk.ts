// 聊聊的会话、消息从 Shopee 的原样数据变成人看的：谁发的、一句话、时间；再拼成让 Gemini 写回复草稿的提示。纯函数，不碰站点。
// 「谁发的」的认法（2026-09-30 在真店上核对过，lilto 的客服表）：自动回复的状态（会话的 last_message_state、消息的 status）是 auto_reply、offwork_autoreply；
// 平台发的（退货卡片、缺货提醒）来源（source）是 server；会话里对方的 id 是 to_id；消息里 from_shop_id 是这家店的店铺 id 就是我们（消息的 shop_id 是 0）。
// 时间：会话的 last_message_time_nano 是纳秒的字符串（前 13 位是毫秒），消息的 created_timestamp 是秒

import type { Conversation as Raw, Message as RawMessage } from "../../connectors/sites/shopee/chat.ts";

export type Sender = "buyer" | "us" | "auto" | "platform" | "other_auto";
export type Conversation = { id: string; buyer: string; lastText: string; lastFrom: Sender; lastAt: string | null; unread: number; unreplied: boolean };
export type Message = { id: string; sender: Sender; text: string; at: string };

const KINDS: Record<string, string> = {
	image: "[图片]",
	sticker: "[贴图]",
	product: "[商品]",
	item_list: "[商品]",
	order: "[订单]",
	video: "[视频]",
	return_refund_card: "[退货退款]",
	out_of_stock_reminder_card: "[缺货提醒]",
};
const AUTO = ["auto_reply", "offwork_autoreply"];

export const messageText = (type: string | null | undefined, content: unknown): string =>
	type === "text"
		? String((typeof content === "object" && content !== null && "text" in content ? content.text : undefined) ?? "")
		: (KINDS[String(type)] ?? `[${type}]`);

const nano = (v: unknown) => (v ? new Date(Number(String(v).slice(0, 13))).toISOString() : null);

/** 会话列表和「未回覆」合起来：未回覆的排前面，再按最后一条从新到旧 */
export function conversationsOf(all: Raw[], unreplied: Raw[]): Conversation[] {
	const waiting = new Set(unreplied.map((c) => String(c.id)));
	const byId = new Map<string, Raw>();
	for (const c of [...unreplied, ...all]) if (!byId.has(String(c.id))) byId.set(String(c.id), c);
	return [...byId.values()]
		.map(
			(c): Conversation => ({
				id: String(c.id),
				buyer: String(c.to_name ?? ""),
				lastText: messageText(c.latest_message_type, c.latest_message_content),
				lastFrom: AUTO.includes(String(c.last_message_state))
					? c.latest_message_from_id === c.to_id
						? "other_auto"
						: "auto"
					: c.latest_message_source === "server"
						? "platform"
						: c.latest_message_from_id === c.to_id
							? "buyer"
							: "us",
				lastAt: nano(c.last_message_time_nano),
				unread: Number(c.unread_count ?? 0),
				unreplied: waiting.has(String(c.id)),
			}),
		)
		.sort((a, b) => Number(b.unreplied) - Number(a.unreplied) || (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
}

/** 一个会话的消息，从旧到新 */
export function messagesOf(raw: RawMessage[], shopId: string): Message[] {
	return raw
		.map((m): Message => {
			const ours = String(m.from_shop_id) === shopId;
			return {
				id: String(m.id),
				sender: AUTO.includes(String(m.status)) ? (ours ? "auto" : "other_auto") : m.source === "server" ? "platform" : ours ? "us" : "buyer",
				text: messageText(m.type, m.content),
				at: new Date(Number(m.created_timestamp) * 1000).toISOString(),
			};
		})
		.sort((a, b) => a.at.localeCompare(b.at));
}

const WHO: Record<Sender, string> = { buyer: "买家", us: "我们", auto: "我们的自动回复", platform: "平台", other_auto: "买家的自动回复" };

/** 让 Gemini 写回复草稿的提示：人会看、会改，不知道的不编 */
export function draftPrompt(shop: string, messages: Message[]): string {
	return [
		`你是 Shopee 台湾站店铺「${shop}」的客服。下面是和一位买家的聊聊记录（从旧到新）。`,
		"请用台湾繁体中文写一则回覆给买家：口气亲切、有礼貌、简短，直接回答买家最后在问的事。",
		"不知道的事（库存、出货时间、价格、能不能退换）不要编，写成会确认后再回覆。只输出回覆的内容，不要加说明。",
		"",
		...messages.slice(-20).map((m) => `${WHO[m.sender]}：${m.text}`),
	].join("\n");
}
