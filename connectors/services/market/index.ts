// x2 market <工具>：知虾镜像（MARKET_URL、MARKET_SECRET）：用 SQL 读市场数据（只读，一次最多 5000 行、5 秒）
import { z } from "zod";
import { get, type Toolkit } from "../../../platform/tool.ts";
import { query } from "./api.ts";

export const market: Toolkit = {
	name: "market",
	title: "知虾镜像（MARKET_URL、MARKET_SECRET；只读 SQL，最多 5000 行、5 秒）",
	kind: "service",
	tools: {
		sql: get("跑一句只读的 SQL，回 { rows }", z.object({ sql: z.string().trim().min(1).describe("SQL（select）") }), async (p) => query(p.sql)),
	},
};
