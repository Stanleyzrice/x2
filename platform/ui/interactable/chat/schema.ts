// chat 的参数：引用一家店的聊聊（给了会话就先选中它）。会话、消息每次现读，回复草稿让 Gemini 写；都经网页服务调 actions 里的工具（tools/chat）
import { z } from "zod";
import { title } from "../../props.ts";

export const description =
	"一家店的聊聊（引用，不是数据）：左边是这家店的会话（未回覆的在前面），右边是选中会话的消息，底下输入框，「生成回复」让 Gemini 写草稿进输入框、人改。给了 conversationId 先选中它，不给选第一个。发送还没接上";
export const props = z.object({
	title,
	shop: z.string().min(1).describe("店铺（账号名，例 ni1206）"),
	conversationId: z.string().min(1).optional().describe("先选中哪个会话（x2 chat conversations 里的 id）"),
});
export type Props = z.infer<typeof props>;
export const actions = { conversations: "chat.conversations", messages: "chat.messages", draft: "chat.draft" };
export const examples: z.input<typeof props>[] = [{ shop: "ni1206" }, { title: "问尺寸的买家", shop: "cheeroutdoor", conversationId: "1234567890" }];
