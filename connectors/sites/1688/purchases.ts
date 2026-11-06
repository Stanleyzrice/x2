// 1688 采购事实：保留接口的分单位整数和缺失值，订单号不经不安全的 number，付款只保留网站给出的时间证据。
import { z } from "zod";
import { reply } from "../../../platform/reply.ts";
import { buyerOrderData } from "./api.ts";

const scalar = z.union([z.string(), z.number()]).nullish();
const pageCount = z
	.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
	.transform(Number)
	.pipe(z.number().int().nonnegative());
const item = z.looseObject({
	idStr: z.string().nullish(),
	id: scalar,
	sourceId: scalar,
	skuId: scalar,
	specId: scalar,
	productName: scalar,
	mainSummImageUrl: z.string().nullish(),
	price: scalar,
	quantity: z.union([z.looseObject({ realAmount: scalar, calAmount: scalar }), z.string(), z.number()]).nullish(),
	specInfo: z.looseObject({ specItems: z.array(z.looseObject({ specValue: scalar })).nullish() }).nullish(),
	entryStatus: scalar,
	entryStatusLabel: scalar,
	entryExtension: z.looseObject({ refundId: scalar, refundStatus: scalar, refundIdForAs: scalar, refundStatusForAs: scalar }).nullish(),
});
const order = z.looseObject({
	idStr: z.string().nullish(),
	id: scalar,
	status: scalar,
	statusLabel: scalar,
	gmtCreate: scalar,
	gmtPayment: scalar,
	sumProductPayment: scalar,
	carriage: scalar,
	allPromotionFee: scalar,
	sumPayment: scalar,
	sellerLoginId: scalar,
	sellerCompanyName: scalar,
	sellerInfo: z.looseObject({ loginId: scalar, companyName: scalar }).nullish(),
	orderEntries: z.array(item).nullish(),
});

export type PurchaseFact = {
	orderId: string;
	status: string | null;
	statusLabel: string | null;
	createdAt: string | null;
	paidAt: string | null;
	supplier: string | null;
	currency: "CNY";
	goodsMinor: string | null;
	freightMinor: string | null;
	discountMinor: string | null;
	paidMinor: string | null;
	paymentEvidence: "gmtPayment" | null;
	items: {
		lineId: string | null;
		offerId: string | null;
		skuId: string | null;
		name: string | null;
		image: string | null;
		spec: string | null;
		quantity: string | null;
		unitPriceMinor: string | null;
		fulfillment?: {
			specId: string | null;
			status: string | null;
			statusLabel: string | null;
			refund: { id: string; stage: "售中" | "售后"; status: string | null } | null;
		};
	}[];
};
export type PurchasePage = { total: number; pages: number; rows: PurchaseFact[] };
const textOf = (value: string | number | null | undefined) => (value === null || value === undefined || value === "" ? null : String(value));

function exactId(value: string | number | null | undefined): string | null {
	if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("1688 采购单 ID 是不安全的数字，不能准确关联订单");
	return textOf(value);
}

function fulfillmentOf(entry: z.infer<typeof item>): NonNullable<PurchaseFact["items"][number]["fulfillment"]> {
	const extra = entry.entryExtension;
	const afterSale = exactId(extra?.refundIdForAs);
	const duringSale = exactId(extra?.refundId);
	return {
		specId: exactId(entry.specId),
		status: textOf(entry.entryStatus),
		statusLabel: textOf(entry.entryStatusLabel),
		refund: afterSale
			? { id: afterSale, stage: "售后", status: textOf(extra?.refundStatusForAs) }
			: duringSale
				? { id: duringSale, stage: "售中", status: textOf(extra?.refundStatus) }
				: null,
	};
}

/** 采购行给的是完整图片 URL；协议相对地址用 HTTPS，不把未知 id 拼成猜测的 CDN 地址。 */
export function purchaseImageUrl(value: string | null | undefined): string | null {
	const text = value?.trim();
	if (!text) return null;
	try {
		const url = new URL(text.startsWith("//") ? `https:${text}` : text);
		return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? url.href : null;
	} catch {
		return null;
	}
}

export function minorOf(value: string | number | null | undefined): string | null {
	if (value === null || value === undefined || value === "") return null;
	if ((typeof value === "number" && !Number.isSafeInteger(value)) || !/^\d+$/.test(String(value))) throw new Error("1688 采购金额不是可准确读取的非负整数分");
	return BigInt(value).toString();
}

function paidTime(value: string | number | null | undefined): string | null {
	if (value === null || value === undefined || value === "" || value === 0 || value === "0") return null;
	const source = String(value);
	const ms = /^\d+$/.test(source)
		? Number(source)
		: /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d$/.test(source)
			? Date.parse(`${source.replace(" ", "T")}+08:00`)
			: Number.NaN;
	if (!Number.isSafeInteger(ms) || ms <= 0 || !Number.isFinite(new Date(ms).getTime())) return null;
	return new Date(ms).toISOString();
}

export function purchaseFactsOf(raw: unknown): PurchasePage {
	const envelope = reply(z.looseObject({ data: z.looseObject({ result: z.string() }) }), raw, "1688 采购事实列表");
	const payload = reply(
		z.looseObject({ data: z.looseObject({ total: pageCount, pages: pageCount, data: z.array(order) }) }),
		JSON.parse(envelope.data.result),
		"1688 采购事实分页",
	).data;
	return {
		total: payload.total,
		pages: payload.pages,
		rows: payload.data.map((o) => {
			const orderId = exactId(o.idStr ?? o.id);
			if (!orderId || !/^\d+$/.test(orderId)) throw new Error("1688 采购单没有可准确读取的订单号");
			const paidAt = paidTime(o.gmtPayment);
			return {
				orderId,
				status: textOf(o.status),
				statusLabel: textOf(o.statusLabel),
				createdAt: textOf(o.gmtCreate),
				paidAt,
				supplier: textOf(o.sellerCompanyName) ?? textOf(o.sellerInfo?.companyName) ?? textOf(o.sellerLoginId) ?? textOf(o.sellerInfo?.loginId),
				currency: "CNY",
				goodsMinor: minorOf(o.sumProductPayment),
				freightMinor: minorOf(o.carriage),
				discountMinor: minorOf(o.allPromotionFee),
				paidMinor: minorOf(o.sumPayment),
				paymentEvidence: paidAt ? "gmtPayment" : null,
				items: (o.orderEntries ?? []).map((i) => ({
					lineId: exactId(i.idStr ?? i.id),
					offerId: exactId(i.sourceId),
					skuId: exactId(i.skuId),
					name: textOf(i.productName),
					image: purchaseImageUrl(i.mainSummImageUrl),
					spec:
						i.specInfo?.specItems
							?.map((s) => textOf(s.specValue))
							.filter(Boolean)
							.join(" / ") || null,
					quantity: textOf(typeof i.quantity === "object" && i.quantity !== null ? (i.quantity.realAmount ?? i.quantity.calAmount) : i.quantity),
					unitPriceMinor: minorOf(i.price),
					fulfillment: fulfillmentOf(i),
				})),
			};
		}),
	};
}

export async function purchaseFacts(pageNo = 1): Promise<PurchasePage> {
	return purchaseFactsOf(await buyerOrderData(pageNo, 50, ""));
}
