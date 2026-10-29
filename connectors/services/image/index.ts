// x2 image <工具>：取图（不经浏览器）：认格式、量尺寸、算 sha256
import { z } from "zod";
import { get, type Toolkit } from "../../../platform/tool.ts";
import { fetchImage } from "./api.ts";

export const image: Toolkit = {
	name: "image",
	title: "取图（认格式、量尺寸、算 sha256）",
	kind: "service",
	tools: {
		inspect: get("取一张图：格式、宽高、大小、sha256（不回字节）", z.object({ url: z.string().url().describe("图片地址") }), async (p) => {
			const b = await fetchImage(p.url);
			return { mime: b.mime, width: b.width, height: b.height, bytes: b.bytes.length, sha256: b.sha256 };
		}),
	},
};
