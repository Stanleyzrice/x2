// 聊聊（x2 chat <工具>）：卖家中心的买家聊天，读这家店的会话、一个会话的消息，让 Gemini 写回复草稿（人看、人改）。都在登录着这家店的浏览器里读。
// 网页上的 chat 组件经网页服务调这几个工具（组件的 schema.ts 声明了调哪几个）。发消息还没有接上
import { z } from "zod";
import { gemini } from "../../connectors/services/gemini/api.ts";
import { conversations, messages, unreplied } from "../../connectors/sites/shopee/chat.ts";
import { shop as currentShop } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import { get, str, type Toolkit } from "../../platform/tool.ts";
import { conversationsOf, draftPrompt, messagesOf } from "./talk.ts";

const shop = str("店铺（账号名，例 ni1206；也可以给店铺 id）");
const conversation = z.object({ shop, conversationId: str("会话 id（x2 chat conversations 里的）") });

async function read(p: z.infer<typeof conversation>) {
	return inAccount("shopee", p.shop, async () => messagesOf(await messages(p.conversationId), (await currentShop()).shopId));
}

export const chat: Toolkit = {
	name: "chat",
	title: "聊聊：读会话和消息，让 Gemini 写回复草稿",
	kind: "tool",
	tools: {
		conversations: get(
			"这家店最近的会话（最新的 50 个和「未回覆」的）：未回覆的排前面，再按最后一条从新到旧",
			z.object({ shop }),
			(p) => inAccount("shopee", p.shop, async () => conversationsOf(await conversations(), (await unreplied()).rows)),
			{ text: (l) => l.map((c) => `${c.unreplied ? "[未回覆] " : ""}${c.id} ${c.buyer}：${c.lastText}`).join("\n") || "没有会话" },
		),
		messages: get("一个会话最近的 30 条消息，从旧到新；sender 是 buyer、us、auto（我们的自动回复）、platform、other_auto", conversation, read, {
			text: (l) => l.map((m) => `${m.at} ${m.sender}：${m.text}`).join("\n"),
		}),
		draft: get(
			"让 Gemini 照这个会话写一则回复的草稿（台湾繁体；不知道的不编）：给人看、人改，不会发出去",
			conversation,
			async (p) => ({
				text: (await gemini(draftPrompt(p.shop, await read(p)), [])).trim(),
			}),
			{ text: (r) => r.text },
		),
	},
};
