// x2 gemini <工具>：Gemini（看图、看字；GEMINI_API_KEY）。上品的筛字、译图检查、文字检查经它；这里给 agent 一个直接问的工具
import { z } from "zod";
import { get, type Toolkit } from "../../../platform/tool.ts";
import { gemini as ask, model } from "./api.ts";

export const gemini: Toolkit = {
	name: "gemini",
	title: "Gemini（GEMINI_API_KEY；GEMINI_MODEL 换模型）",
	kind: "service",
	tools: {
		ask: {
			...get("问一句（只有字，不带图），回模型的回答", z.object({ prompt: z.string().min(1).describe("提示") }), async (p) => ({
				model: model(),
				text: await ask(p.prompt, []),
			})),
			text: (r) => r.text,
		},
	},
};
