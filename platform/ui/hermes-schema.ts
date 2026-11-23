// Hermes 对话请求的纯数据协议，由输入界面和服务端共用。
import { z } from "zod";

export const flashModel = "deepseek-flash";
export const hermesModels = [flashModel, "deepseek-v4-pro"] as const;
export const hermesModel = z.enum(hermesModels);
export type HermesModel = (typeof hermesModels)[number];
export const modelLabels: Record<HermesModel, string> = {
	"deepseek-flash": "DeepSeek Flash",
	"deepseek-v4-pro": "DeepSeek V4 Pro",
};

export const attachmentLimit = 4;
export const textFileLimit = 8_000;
export const quoteLimit = 4_000;
export const photoBytesLimit = 1024 * 1024;
export const photoDataLimit = Math.ceil(photoBytesLimit / 3) * 4 + 24;
export const photoTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export const textFileExtensions = [".txt", ".md", ".csv", ".tsv", ".json", ".log", ".yaml", ".yml", ".xml"] as const;

const filename = z.string().trim().min(1).max(255);
const attachment = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("file"), name: filename, text: z.string().trim().min(1).max(textFileLimit) }),
	z.object({ kind: z.literal("quote"), text: z.string().trim().min(1).max(quoteLimit) }),
	z.object({
		kind: z.literal("photo"),
		name: filename,
		url: z
			.string()
			.max(photoDataLimit)
			.regex(/^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/),
	}),
]);
export type HermesAttachment = z.output<typeof attachment>;

export const conversationTurn = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(30_000) });
export type HermesTurn = z.output<typeof conversationTurn>;

export const hermesChatFields = z.object({
	message: z.string().trim().max(10_000),
	model: hermesModel.optional(),
	history: z.array(conversationTurn).max(16),
	attachments: z.array(attachment).max(attachmentLimit).optional(),
});

export function validChat({ message, model, attachments = [] }: z.output<typeof hermesChatFields>) {
	const photoSize = attachments.reduce((size, item) => size + (item.kind === "photo" ? item.url.length : 0), 0);
	return (message.length > 0 || attachments.length > 0) && photoSize <= photoDataLimit && (!photoSize || model === flashModel);
}

export function chatAttachmentText(attachments: HermesAttachment[]) {
	return attachments
		.map((item) => {
			if (item.kind === "file") return `文件 ${item.name}\n${item.text}`;
			if (item.kind === "quote") return `引用段落\n${item.text}`;
			return `照片 ${item.name}`;
		})
		.join("\n\n");
}
