// 采购工作区只展示服务端给出的订单事实与写入结果，不在浏览器里拼采购规格。
export type OrderLine = {
	itemId: string;
	modelId: string;
	name: string;
	spec: string;
	qty: number;
	image: string | null;
	sources: {
		offerId: string;
		url: string;
		title: string;
		chosen: boolean;
		broken: string | null;
		origin: "chosen" | "listing";
	}[];
};
export type Order = {
	sn: string;
	shop: string;
	createdAt: string | null;
	shipBy: string | null;
	items: string;
	lines: OrderLine[];
	step: string;
	cartPending: boolean;
	cartDone: boolean;
};
export type Monitor = { checkedAt: string | null; error: string | null; orders: Order[] };
export type PurchaseResult = {
	state: string;
	outcome?: { ran: { id: string; display: string; status: string; why?: string }[]; unknown: boolean; blocked: string | null } | null;
};
