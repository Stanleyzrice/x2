import type { Outcome } from "../writes.ts";

export type ProcurementSource = { offerId: string; url: string; title: string; chosen: boolean; broken: string | null; origin: "chosen" | "listing" };
export type PurchaseTarget = { offerId: string; skuId: string; specId?: string | null };
export type PurchaseMatch = {
	state: "paid" | "unpaid" | "partial" | "refund" | "closed" | "unmatched" | "unknown";
	label: string;
	paidQty: number;
	unpaidQty: number;
	requiredQty: number;
	reason: string | null;
	matches: { orderId: string; qty: number; status: string; paidAt: string | null; url: string }[];
	canPurchase: boolean;
};
export type OrderLine = {
	itemId: string;
	modelId: string;
	name: string;
	spec: string;
	qty: number;
	image: string | null;
	sources: ProcurementSource[];
	purchase?: PurchaseMatch;
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
	purchase?: PurchaseMatch;
};
export type Quantities = { qty: number; paidQty: number; unpaidQty: number; buyQty: number; reviewQty: number };
export type SkuDemand = Quantities & {
	image: string | null;
	key: string;
	name: string;
	spec: string;
	target: PurchaseTarget | null;
	orders: (Quantities & { sn: string; shop: string })[];
};
export type Monitor = {
	checkedAt: string | null;
	error: string | null;
	orders: Order[];
	excluded?: { sn: string; status: string; reason: string }[];
	demand?: SkuDemand[];
	purchases?: { selected?: string | null; account: string | null; loginId: string | null; capturedAt: string | null; complete: boolean; error: string | null };
};
export type PurchaseResult = { state: string; outcome?: Outcome | null };
