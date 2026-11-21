import { z } from "zod";
import { get, type Toolkit } from "../../../platform/tool.ts";
import { identify, origin, photoBytes, searchNotes } from "./api.ts";

export { noteSchema } from "./api.ts";

export const xiaohongshu = {
	name: "xiaohongshu",
	title: "小红书（已登录浏览器的笔记搜索）",
	kind: "site",
	tools: {
		"search-notes": get(
			"读取小红书搜索结果中的笔记、日期和图片地址",
			z.object({ keyword: z.string().trim().min(1).max(80), since: z.iso.date(), limit: z.coerce.number().int().min(1).max(8).default(4) }),
			({ keyword, since, limit }) => searchNotes(keyword, since, limit),
		),
		"read-photo": get("读取小红书图片字节", z.object({ url: z.string().url() }), async ({ url }) => ({ data: await photoBytes(url) })),
	},
	site: {
		key: "xiaohongshu",
		title: "小红书",
		origin,
		hosts: (host) => host === "www.xiaohongshu.com",
		paceMs: 1000,
		challenge: {
			look: () => /验证后继续|完成安全验证|请进行安全验证|請完成安全驗證/.test(document.body?.innerText ?? ""),
			seen: (value: boolean) => value,
			url: (url) => /\/(?:captcha|verify)(?:\/|\?|$)/.test(new URL(url).pathname),
		},
		login: { identify },
	},
} satisfies Toolkit;
