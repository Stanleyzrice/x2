// Shopee 卖家中心（台湾站）。接口是卖家中心页面自己用的：请求带 cookie（页面自带）、查询参数 SPC_CDS、请求头 x-csrftoken，
// 两个值都在页面的 cookie 里，所以请求在页面里发（browser.ts）。响应的外壳是 { code, message, data }，code 0 是成功。
// 查过的事实（2026-09-30）：订单列表的 order_list_tab：100 全部、200 未付款、300 待出货、400 运送中、500 已完成；
// 订单详情一次最多 5 张（多了回「Number of export orders is too big」）；详情有两种外壳 package_level_order_card、order_card。
import { page } from "../browser.ts";

export const ORIGIN = "https://seller.shopee.tw";

export type OrderItem = {
	itemId: string;
	modelId: string;
	name: string;
	/** 规格名，例「L42銀色（最大拉力69kg）」；只有一个规格的商品是空字符串 */
	spec: string;
	qty: number;
	image: string;
};

export type Order = {
	orderId: string;
	orderSn: string;
	shopId: string;
	status: string;
	/** 出货期限，ISO 时间 */
	shipBy: string | null;
	items: OrderItem[];
};

/** 当前登录的店铺里待出货的全部订单 */
export async function toShipOrders(): Promise<Order[]> {
	const p = await page(ORIGIN);
	return p.run(async () => {
		const cookie = (n: string) => document.cookie.split("; ").find((c) => c.startsWith(`${n}=`))?.slice(n.length + 1) ?? "";
		const post = async (path: string, body: unknown) => {
			const r = await fetch(`${path}?SPC_CDS=${cookie("SPC_CDS")}&SPC_CDS_VER=2`, {
				method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-csrftoken": cookie("csrftoken") }, body: JSON.stringify(body),
			});
			if (r.url.includes("/account/signin")) throw new Error("Shopee 没有登录：先在浏览器里登录卖家中心");
			const j = await r.json();
			if (j.code !== 0) throw new Error(`Shopee 回 ${j.code}：${j.message}`);
			return j.data;
		};
		const refs: { order_id: number; shop_id: number }[] = [];
		for (let n = 1; ; n++) {
			const d = await post("/api/v3/order/search_order_list_index", {
				order_list_tab: 300, entity_type: 1, pagination: { from_page_number: n, page_number: n, page_size: 40 },
				filter: { fulfillment_type: 0, is_drop_off: 0, fulfillment_source: 0, action_filter: 0 }, sort: { sort_type: 3, ascending: false },
			});
			refs.push(...d.index_list);
			if (refs.length >= d.pagination.total || d.index_list.length === 0) break;
		}
		const orders = [];
		for (let i = 0; i < refs.length; i += 5) {
			const d = await post("/api/v3/order/get_order_list_card_list", {
				order_list_tab: 300, need_count_down_desc: false,
				order_param_list: refs.slice(i, i + 5).map((r) => ({ order_id: r.order_id, shop_id: r.shop_id, region_id: "TW" })),
			});
			for (const c of d.card_list) {
				const card = c.package_level_order_card ?? c.order_card;
				const groups = [...(card.package_list ?? []).map((p: { item_info_group: unknown }) => p.item_info_group), card.item_info_group].filter(Boolean);
				const items = groups.flatMap((g: { item_info_list: { item_list: unknown[] }[] }) => g.item_info_list.flatMap((l) => l.item_list)) as Record<string, any>[];
				orders.push({
					orderId: String(card.order_ext_info.order_id),
					orderSn: card.card_header.order_sn,
					shopId: String(refs[i]!.shop_id),
					status: card.status_info?.status ?? "",
					shipBy: card.order_ext_info.ship_by_date > 0 ? new Date(card.order_ext_info.ship_by_date * 1000).toISOString() : null,
					items: items.map((it) => ({
						itemId: String(it.inner_item_ext_info.item_id),
						modelId: String(it.inner_item_ext_info.model_id),
						name: it.name,
						// 「商品規格: L42銀色（最大拉力69kg） [4bd272e…]」：去掉前缀和最后方括号里的编号
						spec: String(it.description ?? "").replace(/^商品規格:\s*/, "").replace(/\s*\[[^\]]*\]\s*$/, ""),
						qty: it.amount,
						image: it.image ? `https://down-tw.img.susercontent.com/file/${it.image}_tn` : "",
					})),
				});
			}
		}
		return orders;
	});
}
