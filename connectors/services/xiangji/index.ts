// x2 xiangji <工具>：象寄（图片译字，简体 → 繁体）。译图交一次收一次钱，是写：只经业务工具调
import { z } from "zod";
import type { SubmitTool, Toolkit } from "../../../platform/tool.ts";
import { BATCH, type Outcome, translate } from "./api.ts";

export const translateImages: SubmitTool = {
	kind: "write",
	description: `把图上的简体字译成繁体（收费，一张约 0.025 元；一批最多 ${BATCH} 张；只经业务工具调）`,
	params: z.object({ urls: z.array(z.string().url()).min(1).max(BATCH).describe("图片地址") }),
	submit: async (p) => {
		const r = await translate(p.urls);
		return r.kind === "done" ? { kind: "done", data: r satisfies Outcome } : r;
	},
};

export const xiangji: Toolkit = {
	name: "xiangji",
	title: "象寄（图片译字；XIANGJI_USER_KEY、XIANGJI_IMG_TRANS_KEY）",
	kind: "service",
	tools: { translate: translateImages },
};
