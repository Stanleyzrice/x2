// x2 chanboss <工具>：chanboss（货代）的读工具（预报是写，经订单的写工具）
import { z } from "zod";
import { byPage, day, get, type SubmitTool, str, strs, type Toolkit } from "../../../platform/tool.ts";
import { balance, forecast, identity, orders, putaway, returnChanges, returns, stock } from "./api.ts";

// 和 shopee 一样叫 --start、--end
const range = { start: day("开始"), end: day("结束", true) };

/** 预报一张订单：发一次、回结果（经订单的写操作「预报」保护；读回对账用订单的读） */
export const forecastOrder: SubmitTool = {
	kind: "write",
	description: "预报一张订单（只经订单的写工具 orders.forecast）",
	params: z.object({
		sn: str("Shopee 订单号"),
		orderId: str("chanboss 上这张订单的 id"),
		orderTime: z.number().describe("chanboss 上的下单时间（秒）"),
		sendwayId: z.number().describe("发货线路"),
		lineId: z.number().describe("线路"),
		warehouseId: z.number().describe("仓库"),
		lines: z.array(z.object({ platformModelId: z.string(), modelId: z.string(), count: z.number().int().positive(), trackNum: z.string() })).min(1),
	}),
	submit: async ({ sn: _, ...body }) => forecast(body),
};

const tools = {
	forecast: forecastOrder,
	identity: get("登录着的 chanboss 账号", undefined, async () => {
		const i = await identity();
		return { ...i, userId: String(i.userId) };
	}),
	orders: byPage(
		"订单（两家店的 Shopee 订单在 chanboss 的进度），按下单时间筛",
		z.object({ ...range, sns: strs("只读这几张 Shopee 订单号（最多 100）").optional() }),
		async (p, n) => {
			const r = await orders(p.start, p.end, n, p.sns ?? []);
			return { rows: r.rows, more: n < r.pageCount };
		},
	),
	stock: byPage("库存（含库存是 0 的）", undefined, async (_, n) => {
		const r = await stock(n);
		return { rows: r.rows, more: n < r.pageCount };
	}),
	returns: byPage("平台退回 chanboss 的退件", undefined, async (_, n) => {
		const r = await returns(n);
		return { rows: r.rows, more: n < r.pageCount };
	}),
	putaway: byPage(
		"退件在库：上架 shelf、分拣中 sorting、已分出 sort_out",
		z.object({ status: z.enum(["shelf", "sorting", "sort_out"]).describe("状态"), ...range }),
		async (p, n) => {
			const r = await putaway(p.status, p.start, p.end, n);
			return { rows: r.rows, more: n < r.pageCount };
		},
	),
	"return-changes": byPage("退件换货", undefined, async (_, n) => {
		const r = await returnChanges(n);
		return { rows: r.rows, more: n < r.pageCount };
	}),
	balance: byPage("扣款流水", z.object(range), async (p, n) => {
		const r = await balance(p.start, p.end, n);
		return { rows: r.rows, more: n < r.pageCount };
	}),
};

export const chanboss: Toolkit = {
	name: "chanboss",
	title: "chanboss（货代）",
	kind: "site",
	tools,
	site: {
		key: "chanboss",
		title: "chanboss",
		origin: "https://c.chanboss.com",
		hosts: (h) => h === "c.chanboss.com",
		login: {
			identify: async () => {
				const i = await identity();
				return { id: String(i.userId), name: i.account };
			},
		},
	},
};
