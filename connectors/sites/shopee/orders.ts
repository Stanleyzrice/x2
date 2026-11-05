// 订单。查过的事实（2026-09-30）：订单列表的 order_list_tab：100 全部、200 未付款、300 待出货、400 运送中、500 已完成；
// 列表只回订单 id，内容要再按 id 读详情，一次最多 5 张（多了回「Number of export orders is too big」）；
// 详情有两种外壳 package_level_order_card（分包裹的）、order_card
import { z } from "zod";
import { reply } from "../../../platform/reply.ts";
import { IMAGE, seller, type Write, withData, write } from "./seller.ts";

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
	/** 分包裹订单保留每个包裹的状态，不能只凭第一个包裹决定是否采购。 */
	packageStatuses?: string[];
	shipBy: string | null;
	total: number;
	items: OrderItem[];
	packages: Package[];
};

export const TAB = { all: 100, unpaid: 200, toShip: 300, shipping: 400, completed: 500 } as const;

const scalar = z.union([z.string(), z.number()]).nullish();
const ref = z.looseObject({ order_id: z.union([z.number(), z.string()]), shop_id: z.union([z.number(), z.string()]), region_id: z.string().nullish() });
type Ref = z.output<typeof ref>;
const orderIndexReply = withData(
	z.looseObject({
		index_list: z.array(ref),
		pagination: z.looseObject({
			total: z
				.union([z.number(), z.string().regex(/^\d+$/)])
				.transform(Number)
				.pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
		}),
	}),
);

export function orderIndexOf(raw: unknown): { total: number; refs: Ref[] } {
	const b = reply(orderIndexReply, raw, "Shopee /api/v3/order/search_order_list_index");
	return { total: b.data.pagination.total, refs: b.data.index_list };
}

export async function orderIndex(tab: number, pageNo = 1, pageSize = 40): Promise<{ total: number; refs: Ref[] }> {
	// 没有 index_list 不能当成没有订单：是「回包变了」
	const raw = await seller("/api/v3/order/search_order_list_index", z.unknown(), {
		body: {
			order_list_tab: tab,
			entity_type: 1,
			pagination: { from_page_number: pageNo, page_number: pageNo, page_size: pageSize },
			filter: { fulfillment_type: 0, is_drop_off: 0, fulfillment_source: 0, action_filter: 0 },
			sort: { sort_type: 3, ascending: false },
		},
	});
	return orderIndexOf(raw);
}

const time = (seconds: unknown) => (Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString() : null);

const ext = z.looseObject({ package_number: scalar, consignment_no: scalar, fulfilment_status: scalar, acl1_arrange_ship_date: scalar });
const fulfil = z.looseObject({ fulfilment_channel_name: scalar, tracking_number_list: z.array(z.string()).nullish() });
const item = z.looseObject({
	inner_item_ext_info: z.looseObject({ item_id: scalar, model_id: scalar }).nullish(),
	name: z.string().nullish(),
	description: z.string().nullish(),
	amount: scalar,
	image: z.string().nullish(),
});
/** 一个包裹（分包裹的卡片里一个一个列着；不分包裹的卡片自己就是一个） */
const unit = z.looseObject({
	status_info: z.looseObject({ status: scalar }).nullish(),
	payment_info: z.looseObject({ total_price: scalar }).nullish(),
	item_info_group: z.looseObject({ item_info_list: z.array(z.looseObject({ item_list: z.array(item).nullish() })).nullish() }).nullish(),
	package_ext_info: ext.nullish(),
	fulfilment_info: fulfil.nullish(),
});
const card = unit.extend({
	order_ext_info: z.looseObject({ order_id: scalar, ship_by_date: scalar }).nullish(),
	card_header: z.looseObject({ order_sn: scalar }).nullish(),
	package_list: z.array(unit).nullish(),
	package_ext_info_list: z.array(ext).nullish(),
});
const cards = withData(
	z.looseObject({
		card_list: z.array(
			z
				.looseObject({ package_level_order_card: card.nullish(), order_card: card.nullish() })
				.refine((w) => w.package_level_order_card || w.order_card, "没有 package_level_order_card，也没有 order_card"),
		),
	}),
);

/** 订单详情（get_order_list_card_list）的回包 → 订单（纯函数）。refs 是这一批的订单 id、店铺 id */
export function ordersOf(raw: unknown, refs: Ref[]): Order[] {
	const b = reply(cards, raw, "Shopee /api/v3/order/get_order_list_card_list");
	const out = b.data.card_list.map((w): Order => {
		const card = (w.package_level_order_card ?? w.order_card)!;
		const units = card.package_list?.length ? card.package_list : [card];
		const packages = w.package_level_order_card
			? units.map((u) => ({ ext: u.package_ext_info ?? {}, f: u.fulfilment_info ?? {} }))
			: (card.package_ext_info_list ?? []).map((ext) => ({ ext, f: card.fulfilment_info ?? {} }));
		const items = units.flatMap((u) => (u.item_info_group?.item_info_list ?? []).flatMap((l) => l.item_list ?? []));
		const orderId = String(card.order_ext_info?.order_id ?? "");
		const reference = refs.find((r) => String(r.order_id) === orderId);
		if (!reference) throw new Error(`Shopee 返回了未请求的订单 ${orderId || "（缺少编号）"}`);
		return {
			orderId,
			orderSn: String(card.card_header?.order_sn ?? ""),
			shopId: String(reference.shop_id),
			status: String(units[0]?.status_info?.status ?? card.status_info?.status ?? ""),
			...(units.length > 1 ? { packageStatuses: units.map((u) => String(u.status_info?.status ?? "")) } : {}),
			shipBy: time(card.order_ext_info?.ship_by_date),
			// 订单卡片的金额是新台币乘 100000（2026-10-09：卡片 21000000，get_one_order 的 total_price 是 210）
			total: Number(units[0]?.payment_info?.total_price ?? 0) / 100000,
			items: items.map((it) => ({
				itemId: String(it.inner_item_ext_info?.item_id ?? ""),
				modelId: String(it.inner_item_ext_info?.model_id ?? ""),
				name: String(it.name ?? ""),
				// 「商品規格: L42銀色（最大拉力69kg） [4bd272e…]」：去掉前缀和最后方括号里的编号
				spec: String(it.description ?? "")
					.replace(/^\s*商品規格\s*[:：]\s*/, "")
					.replace(/\s*\[[^\]]*\]\s*$/, ""),
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
	if (out.length !== refs.length || new Set(out.map((o) => o.orderId)).size !== refs.length)
		throw new Error("Shopee 订单卡片不完整或存在重复订单，本次读取不完整");
	return out;
}

export async function orderCards(tab: number, refs: Ref[]): Promise<Order[]> {
	if (refs.length > 5) throw new Error("订单详情一次最多 5 张");
	if (refs.length === 0) return [];
	const raw = await seller("/api/v3/order/get_order_list_card_list", z.unknown(), {
		body: {
			order_list_tab: tab,
			need_count_down_desc: false,
			order_param_list: refs.map((r) => ({ order_id: r.order_id, shop_id: r.shop_id, region_id: r.region_id ?? "TW" })),
		},
	});
	return ordersOf(raw, refs);
}

export async function orders(tab: number): Promise<Order[]> {
	const refs: Ref[] = [];
	for (let n = 1; ; n++) {
		const { total, refs: page } = await orderIndex(tab, n);
		refs.push(...page);
		if (refs.length >= total || page.length === 0) break;
	}
	const out: Order[] = [];
	for (let i = 0; i < refs.length; i += 5) out.push(...(await orderCards(tab, refs.slice(i, i + 5))));
	return out;
}

export const toShipOrders = () => orders(TAB.toShip);

/** 一张订单的原样详情（get_one_order）：下单时间 create_time、买家付的 total_price、运费 shipping_fee、
 * 买家 buyer_user（user_id；hide_chat_button 是 false 才能聊聊）。地址、电话也在里面，用的时候只取要的字段 */
export async function oneOrder(orderId: string): Promise<Record<string, unknown>> {
	const b = await seller("/api/v3/order/get_one_order", withData(z.looseObject({ order_id: scalar })), { query: { order_id: orderId } });
	if (String(b.data.order_id) !== orderId) throw new Error(`Shopee 回的订单不是 ${orderId}`);
	return b.data;
}

export function arrangeDropoff(orderId: string, packageNumber: string): Promise<Write> {
	return write("/api/v3/shipment/init_order", { body: { order_id: Number(orderId), package_number: packageNumber, shipping_mode: "dropoff" } });
}
