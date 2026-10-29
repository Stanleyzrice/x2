// x2 xiangji <工具>：象寄（图片译字，简体 → 繁体）。译图交一次收一次钱，是写：只经上品的写操作「译图」调（做商品稿时）
import { z } from "zod";
import type { SubmitTool, Toolkit } from "../../../platform/tool.ts";
import { BATCH, type Outcome, translate } from "./api.ts";

/** 交一批图译字：答复了是 done（data 是译好的、没译成的、答复里没有的）；没拿到答复是结果未知，不许重交 */
export const translateImages: SubmitTool = {
	kind: "write",
	description: `把图上的简体字译成繁体（收费，一张约 0.025 元；一批最多 ${BATCH} 张；只经上品的写操作「译图」）`,
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
