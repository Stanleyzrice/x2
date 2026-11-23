import assert from "node:assert/strict";
import { test } from "node:test";
import { chatAttachmentText, flashModel, hermesChatFields, photoDataLimit, validChat } from "./hermes-schema.ts";

const input = hermesChatFields.refine(validChat);
const photo = { kind: "photo" as const, name: "商品.png", url: "data:image/png;base64,AA==" };

test("Hermes 对话接受旧请求、模型选择和正文附件", () => {
	assert.deepEqual(input.parse({ message: "查看商品", history: [] }), { message: "查看商品", history: [] });
	const request = input.parse({
		message: "",
		model: "deepseek-v4-pro",
		history: [],
		attachments: [
			{ kind: "file", name: "库存.csv", text: "规格,库存\n黑色,8" },
			{ kind: "quote", text: "先核对颜色\n再核对库存" },
		],
	});
	assert.equal(chatAttachmentText(request.attachments!), "文件 库存.csv\n规格,库存\n黑色,8\n\n引用段落\n先核对颜色\n再核对库存");
	assert.equal(input.safeParse({ message: "", history: [] }).success, false);
	assert.equal(input.safeParse({ message: "你好", history: [], model: "未知模型" }).success, false);
});

test("Hermes 照片只随支持图片的模型发送，拒绝远程地址和超限图片", () => {
	const request = { message: "检查颜色", history: [], attachments: [photo] };
	assert.equal(input.safeParse({ ...request, model: flashModel }).success, true);
	assert.equal(input.safeParse({ ...request, model: "deepseek-v4-pro" }).success, false);
	assert.equal(input.safeParse({ ...request, model: flashModel, attachments: [{ ...photo, url: "https://example.com/photo.png" }] }).success, false);
	const large = { ...photo, url: `data:image/png;base64,${"A".repeat(photoDataLimit - 32)}` };
	assert.equal(input.safeParse({ ...request, model: flashModel, attachments: [large, large] }).success, false);
	assert.equal(chatAttachmentText(request.attachments), "照片 商品.png");
});
