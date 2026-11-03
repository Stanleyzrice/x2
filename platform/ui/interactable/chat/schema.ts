// Chat 页面保存店铺和客服规则引用；可变会话、草稿和确认数据由服务端校验。
import { z } from "zod";
import { title } from "../../props.ts";

export const description = "固定店铺与显式读取窗口的买家聊聊：持续读取新消息，过期记录移出当前页面，保留人工草稿及逐条确认发送";
export const props = z.strictObject({
	title,
	shop: z.string().min(1),
	policyPath: z.string().min(1),
	historyDays: z.number().int().positive(),
	conversationId: z.string().min(1).optional(),
});
export type Props = z.infer<typeof props>;
export const actions = {
	pending: "chat.pending",
	conversations: "chat.conversations",
	messages: "chat.messages",
	draft: "chat.draft",
	saveDraft: "chat.save-draft",
	reconcile: "chat.reconcile",
};
export const writeActions = { send: "chat.send" };
export const writePreviews = { send: "chat.preview" };
export const inputs = ["conversationId", "cursor", "contextId", "text", "revision", "requestId", "contextHash"];
export const examples: z.input<typeof props>[] = [{ shop: "ni1206", policyPath: ".agents/skills/chat/SKILL.md", historyDays: 7 }];
