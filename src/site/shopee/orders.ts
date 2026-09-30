// 订单。查过的事实（2026-09-30）：订单列表的 order_list_tab：100 全部、200 未付款、300 待出货、400 运送中、500 已完成；
// 列表只回订单 id，内容要再按 id 读详情，一次最多 5 张（多了回「Number of export orders is too big」）；
// 详情有两种外壳 package_level_order_card（分包裹的）、order_card
import { IMAGE, seller, type Write, write } from "./seller.ts";

export type OrderItem = {
	itemId: string;
	modelId: string;
	name: string;
	/** 规格名，例「L42銀色（最大拉力69kg）」；只有一个规格的商品是空字符串 */
	spec: string;
	qty: number;
	image: string;
};

export type Package = { packageNumber: string; channel: string; trackingNo: string; status: number; arrangeBy: string | null };

export type Order = {
	orderId: string;
	orderSn: string;
	shopId: string;
	status: string;
	/** 出货期限，ISO 时间 */
	shipBy: string | null;
	/** 买家付的总额（新台币） */
	total: number;
	items: OrderItem[];
	packages: Package[];
};

export const TAB = { all: 100, unpaid: 200, toShip: 300, shipping: 400, completed: 500 } as const;

type Ref = { order_id: number; shop_id: number; region_id?: string };

/** 订单列表的一页：只有订单 id，按下单时间从新到旧 */
export async function orderIndex(tab: number, pageNo = 1, pageSize = 40): Promise<{ total: number; refs: Ref[] }> {
	const b = await seller("/api/v3/order/search_order_list_index", {
		body: {
			order_list_tab: tab, entity_type: 1, pagination: { from_page_number: pageNo, page_number: pageNo, page_size: pageSize },
			filter: { fulfillment_type: 0, is_drop_off: 0, fulfillment_source: 0, action_filter: 0 }, sort: { sort_type: 3, ascending: false },
		},
	});
	if (!Array.isArray(b.data?.index_list)) throw new Error("Shopee 订单列表没有 index_list（不能当成没有订单）");
	return { total: Number(b.data.pagination?.total ?? 0), refs: b.data.index_list };
}

const time = (seconds: unknown) => (Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString() : null);

/** 订单详情，最多 5 张 */
export async function orderCards(tab: number, refs: Ref[]): Promise<Order[]> {
	if (refs.length > 5) throw new Error("订单详情一次最多 5 张");
	if (refs.length === 0) return [];
	const b = await seller("/api/v3/order/get_order_list_card_list", {
		body: { order_list_tab: tab, need_count_down_desc: false, order_param_list: refs.map((r) => ({ order_id: r.order_id, shop_id: r.shop_id, region_id: r.region_id ?? "TW" })) },
	});
	if (!Array.isArray(b.data?.card_list)) throw new Error("Shopee 订单详情没有 card_list");
	return (b.data.card_list as any[]).map((w): Order => {
		const card = w.package_level_order_card ?? w.order_card;
		const units: any[] = card.package_list?.length ? card.package_list : [card];
		const packages: any[] = w.package_level_order_card
			? units.map((u) => ({ ext: u.package_ext_info ?? {}, f: u.fulfilment_info ?? {} }))
			: (card.package_ext_info_list ?? []).map((ext: any) => ({ ext, f: card.fulfilment_info ?? {} }));
		const items = units.flatMap((u) => (u.item_info_group?.item_info_list ?? []).flatMap((l: any) => l.item_list ?? []));
		const orderId = String(card.order_ext_info?.order_id ?? "");
		return {
			orderId,
			orderSn: String(card.card_header?.order_sn ?? ""),
			shopId: String(refs.find((r) => String(r.order_id) === orderId)?.shop_id ?? refs[0]!.shop_id),
			status: String(units[0]?.status_info?.status ?? card.status_info?.status ?? ""),
			shipBy: time(card.order_ext_info?.ship_by_date),
			total: Number(units[0]?.payment_info?.total_price ?? 0),
			items: items.map((it: any) => ({
				itemId: String(it.inner_item_ext_info?.item_id ?? ""),
				modelId: String(it.inner_item_ext_info?.model_id ?? ""),
				name: String(it.name ?? ""),
				// 「商品規格: L42銀色（最大拉力69kg） [4bd272e…]」：去掉前缀和最后方括号里的编号
				spec: String(it.description ?? "").replace(/^\s*商品規格\s*[:：]\s*/, "").replace(/\s*\[[^\]]*\]\s*$/, ""),
				qty: Number(it.amount ?? 0),
				image: it.image ? `${IMAGE}${it.image}_tn` : "",
			})),
			packages: packages.map(({ ext, f }) => ({
				packageNumber: String(ext.package_number ?? ""),
				channel: String(f.fulfilment_channel_name ?? ""),
				trackingNo: String(ext.consignment_no ?? f.tracking_number_list?.[0] ?? ""),
				status: Number(ext.fulfilment_status ?? 0),
				arrangeBy: time(ext.acl1_arrange_ship_date),
			})),
		};
	});
}

/** 一个标签下的全部订单（列表翻到底，详情 5 张一批） */
export async function orders(tab: number): Promise<Order[]> {
	const refs: Ref[] = [];
	for (let n = 1; ; n++) {
		const { total, refs: page } = await orderIndex(tab, n);
		refs.push(...page);
		if (refs.length >= total || page.length === 0) break;
	}
	const out: Order[] = [];
	for (let i = 0; i < refs.length; i += 5) out.push(...await orderCards(tab, refs.slice(i, i + 5)));
	return out;
}

/** 当前登录的店铺里待出货的全部订单 */
export const toShipOrders = () => orders(TAB.toShip);

/** 一张订单的原样详情（get_one_order）：下单时间 create_time、买家付的 total_price、运费 shipping_fee、
 * 买家 buyer_user（user_id；hide_chat_button 是 false 才能聊聊）。地址、电话也在里面，用的时候只取要的字段 */
export async function oneOrder(orderId: string): Promise<any> {
	const b = await seller("/api/v3/order/get_one_order", { query: { order_id: orderId } });
	if (String(b.data?.order_id) !== orderId) throw new Error(`Shopee 回的订单不是 ${orderId}`);
	return b.data;
}

/** 写：蝦皮店到店安排出货（dropoff）。结果未知时不许重发，先回读订单 */
export function arrangeDropoff(orderId: string, packageNumber: string): Promise<Write> {
	return write("/api/v3/shipment/init_order", { body: { order_id: Number(orderId), package_number: packageNumber, shipping_mode: "dropoff" } });
}
