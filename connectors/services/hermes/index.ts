import { z } from "zod";
import { get, type Toolkit } from "../../../platform/tool.ts";
import { checkHermesConnection } from "./api.ts";

export { askDeepSeek, deepSeekStatus } from "./api.ts";

export const hermes: Toolkit = {
	name: "hermes",
	title: "Hermes Agent（智能代理）",
	kind: "service",
	tools: {
		"check-connection": get(
			"测试本机 Hermes 运行环境和 DeepSeek 模型连接",
			z.object({ apiKey: z.string().optional(), model: z.string().min(1), python: z.string().optional() }),
			(p) => checkHermesConnection(p.apiKey, p.model, p.python),
		),
	},
};
