// x2 1688 <工具>：1688 的读工具（加购是写，经订单的写工具）
import { z } from "zod";
import { Usage } from "../../../platform/errors.ts";
import { all, byPage, get, type SubmitTool, str, strs, type Toolkit } from "../../../platform/tool.ts";
import { account, addToCart, alibabaCookie, buyerOrders, cart, offer, offerIdOf, refund, search, traces } from "./api.ts";
import { SLIDER } from "./challenge.ts";

/** 加购：把货源的一个规格加进这个浏览器登录着的账号的购物车，发一次、回结果（同一个规格加两次，车里是两倍：经订单的写操作「加购」保护） */
export const cartAdd: SubmitTool = {
	kind: "write",
	description: "加购：把货源的一个规格加进购物车（只经订单的写工具 orders.cart）",
	params: z.object({ offerId: str("货源 id"), specId: str("规格的 specId"), qty: z.number().int().positive().describe("件数") }),
	submit: async (p) => {
		const r = await addToCart(p.offerId, p.specId, p.qty);
		return r.kind === "sent" ? { kind: "done" } : r;
	},
};

const tools = {
	"cart-add": cartAdd,
	account: get("登录着的 1688 账号", undefined, () => account()),
	offer: get("一家货源：标题、起订量、属性、每个规格的价格和库存", z.object({ id: str("货源 id 或 1688 链接") }), (p) => {
		const id = offerIdOf(p.id);
		if (!id) throw new Usage(`认不出货源：${p.id}`);
		return offer(id);
	}),
	search: all("按关键词搜货源（第一页）", z.object({ keyword: str("关键词") }), (p) => search(p.keyword)),
	cart: all("购物车里的全部规格和件数", undefined, () => cart()),
	orders: byPage(
		"采购单（在 1688 买的订单），新的在前；金额是元",
		z.object({ status: z.string().default("").describe("交易状态（采购单列表接口的 tradeStatus）；不给是全部") }),
		async (p, n) => {
			const r = await buyerOrders(n, 50, p.status);
			return { rows: r.rows, more: n < r.pages };
		},
	),
	refund: get(
		"一张退款单：状态、类型、退的钱、退货运单号",
		z.object({ id: str("退款单号（TQ 开头）"), stage: z.enum(["售中", "售后"]).default("售中").describe("售中（行上的 refundId）还是售后（refundIdForAs）") }),
		(p) => refund(p.id, p.stage),
	),
	traces: all("采购单的物流轨迹", z.object({ orders: strs("采购单号") }), (p) => traces(p.orders.map((orderId) => ({ orderId })))),
};

export const alibaba: Toolkit = {
	name: "1688",
	title: "1688（采购）",
	kind: "site",
	tools,
	site: {
		key: "1688",
		title: "1688",
		origin: "https://www.1688.com",
		hosts: (h) => h === "1688.com" || h.endsWith(".1688.com"),
		// 读得太密跳滑块验证
		paceMs: 3000,
		challenge: SLIDER,
		login: {
			identify: async () => {
				const a = await account();
				return { id: a.userId, name: a.loginId || a.userId };
			},
			cookie: { url: "https://www.1688.com/", signedIn: alibabaCookie },
		},
	},
};
