// x2 image <工具>：取原图（不经浏览器），认格式、量尺寸、算 sha256，也可显式保存到本地。
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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
		save: get(
			"取一张来源图保存到本地，返回原始格式、尺寸与SHA256；不改图、不调用图像模型",
			z.object({ url: z.string().url().describe("图片地址"), out: z.string().min(1).describe("本地输出路径") }),
			async (p) => {
				const b = await fetchImage(p.url);
				const path = resolve(p.out);
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, b.bytes, { flag: "wx" });
				return { path, sourceUrl: p.url, mime: b.mime, width: b.width, height: b.height, bytes: b.bytes.length, sha256: b.sha256 };
			},
		),
	},
};
