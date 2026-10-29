// x2 chanboss <工具>：chanboss（货代）的读工具（预报是写，经订单的写工具）
import { z } from "zod";
import { byPage, day, get, strs, type Toolkit } from "../../../platform/tool.ts";
import { balance, identity, orders, putaway, returnChanges, returns, stock } from "./api.ts";

// 和 shopee 一样叫 --start、--end
const range = { start: day("开始"), end: day("结束", true) };

const tools = {
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

export const chanboss: Toolkit = { name: "chanboss", title: "chanboss（货代）", kind: "site", tools };
