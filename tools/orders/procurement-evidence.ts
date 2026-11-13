// 采购状态只取当前采购账号的完整成功快照；精确规格映射优先使用已发布商品稿，不按商品标题或相似名称猜采购关系。
import { z } from "zod";
import type { PurchaseFact } from "../../connectors/sites/1688/purchases.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import type { ProcurementItem, ProcurementListingRow, ProcurementSourceRow } from "./procurement-items.ts";
import type { Coverage, Match, MatchNeed, MatchRecord } from "./procurement-matches.ts";
import { exceptionFor, matchSku } from "./similar.ts";

export type EvidenceSource = ProcurementSourceRow & { skus: unknown; exceptions: string | null };
export type EvidenceListing = ProcurementListingRow & { variants: unknown; offer: unknown };
export type EvidenceCatalog = { shop: string; shopId: string; productId: string; models: unknown };
export type PurchaseEvidence = {
	coverage: Coverage & { loginId: string | null };
	records: MatchRecord[];
};

type AccountRow = {
	selected: string | null;
	account: string | null;
	loginId: string | null;
	revision: string | null;
	capturedAt: Date | null;
	headStatus: string | null;
	lastStatus: string | null;
	lastError: string | null;
};

const instant = (value: string | null) => {
	if (!value) return null;
	const source = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d$/.test(value) ? `${value.replace(" ", "T")}+08:00` : value;
	const date = new Date(/^\d+$/.test(source) ? Number(source) : source);
	return Number.isFinite(date.getTime()) && date.getTime() > 0 ? date.toISOString() : null;
};

export async function readPurchaseEvidence(sql: Sql): Promise<PurchaseEvidence> {
	const accounts = await sql<AccountRow[]>`select s.buy_account as selected, a.account_id as account, a.name as "loginId", a.revision,
		a.last_success_at as "capturedAt", head.status as "headStatus", last.status as "lastStatus", last.error as "lastError"
		from order_settings s left join reimbursement_accounts a on a.account_id = s.buy_account or a.name = s.buy_account
		left join reimbursement_runs head on head.id = a.revision and head.account_id = a.account_id
		left join lateral (select status, error from reimbursement_runs where account_id = a.account_id order by started_at desc limit 1) last on true
		where s.id = 1`;
	const account = accounts.length === 1 ? accounts[0] : undefined;
	const error =
		accounts.length > 1
			? "采购账号对应多个已保存身份，无法确认当前账号"
			: !account?.selected
				? "尚未选择采购账号"
				: !account.account
					? "当前采购账号尚无已保存的 1688 订单记录"
					: account.lastStatus === "failed"
						? (account.lastError ?? "当前采购账号最近同步失败，保留上次成功记录")
						: account.lastStatus === "running"
							? "当前采购账号订单正在同步，尚未发布新快照"
							: !account.revision || account.headStatus !== "succeeded" || !account.capturedAt
								? "当前采购账号尚无完整成功的 1688 订单快照"
								: null;
	const coverage = {
		account: account?.account ?? null,
		loginId: account?.loginId ?? null,
		capturedAt: account?.capturedAt?.toISOString() ?? null,
		complete: error === null,
		error,
	};
	if (!account?.account || !account.revision || account.headStatus !== "succeeded") return { coverage, records: [] };
	type StoredFact = Omit<PurchaseFact, "items"> & { items: (PurchaseFact["items"][number] & { fulfillment?: MatchRecord["fulfillment"] })[] };
	const rows = await sql<{ fact: StoredFact }[]>`select o.fact from reimbursement_orders o
		join reimbursement_accounts a on a.account_id = o.account_id and a.revision = o.revision
		join reimbursement_runs r on r.id = o.revision and r.account_id = o.account_id and r.status = 'succeeded'
		where o.account_id = ${account.account} and o.revision = ${account.revision}`;
	return {
		coverage,
		records: rows.flatMap(({ fact }) =>
			fact.items.map((item) => ({
				account: account.account!,
				orderId: fact.orderId,
				lineId: item.lineId,
				offerId: item.offerId,
				skuId: item.skuId,
				quantity: item.quantity,
				createdAt: instant(fact.createdAt),
				paidAt: fact.paymentEvidence === "gmtPayment" ? instant(fact.paidAt) : null,
				status: fact.status,
				...(item.fulfillment ? { fulfillment: item.fulfillment } : {}),
			})),
		),
	};
}

const models = z.array(z.object({ modelId: z.string().nullable(), sku: z.string().nullable() }));
const variants = z.object({ variants: z.array(z.object({ sku: z.string().min(1), skuId: z.string().min(1), specId: z.string() })) });
const offer = z.object({ offerId: z.string().min(1), skus: z.array(z.object({ skuId: z.string().min(1), specId: z.string() })) });
const sourceSkus = z.array(z.object({ skuId: z.string().min(1), specId: z.string(), name: z.string(), attrs: z.array(z.string()).optional() }));
const missing = (reason: string) => ({ target: null, reason });

export function procurementTarget(
	order: { shop: string; shopId: string },
	item: ProcurementItem,
	sources: EvidenceSource[],
	listings: EvidenceListing[],
	catalog: EvidenceCatalog[],
): Pick<MatchNeed, "target" | "reason"> {
	const own = listings.filter((row) => row.shop === order.shop && row.shopId === order.shopId && row.productId === item.itemId);
	if (own.length) {
		const current = catalog.filter((row) => row.shop === order.shop && row.shopId === order.shopId && row.productId === item.itemId);
		if (current.length !== 1) return missing("没有唯一的当前店铺商品规格快照，无法核对 SKU 货源对应");
		const parsedModels = models.safeParse(current[0]!.models);
		if (!parsedModels.success) return missing("当前商品快照没有可核对的规格编号与 SKU");
		const model = parsedModels.data.filter((model) => model.modelId === item.modelId);
		if (model.length !== 1 || !model[0]!.sku || parsedModels.data.filter((m) => m.sku === model[0]!.sku).length !== 1)
			return missing("当前订单规格没有唯一的 Shopee SKU 对应");
		const candidates: NonNullable<MatchNeed["target"]>[] = [];
		for (const row of own) {
			const mapped = variants.safeParse(row.variants),
				origin = offer.safeParse(row.offer);
			if (!mapped.success || !origin.success || origin.data.offerId !== row.offerId) return missing("已发布商品稿的货源规格映射不完整或冲突");
			for (const variant of mapped.data.variants.filter((v) => v.sku === model[0]!.sku)) {
				if (origin.data.skus.filter((sku) => sku.skuId === variant.skuId && sku.specId === variant.specId).length !== 1)
					return missing("商品稿中的 1688 SKU 与规格快照不一致");
				candidates.push({ offerId: row.offerId, skuId: variant.skuId, specId: variant.specId });
			}
		}
		return candidates.length === 1 ? { target: candidates[0]! } : missing("商品稿没有唯一的 SKU 货源对应");
	}
	const chosen = sources.filter((source) => source.itemId === item.itemId && !source.broken);
	if (chosen.length !== 1) return missing("没有唯一的人工已选货源，不能按商品名称猜采购关系");
	const source = chosen[0]!,
		parsed = sourceSkus.safeParse(source.skus);
	if (!parsed.success) return missing("已选货源缺少可核对的 SKU 编号和规格");
	// 采购状态与实际加购共用唯一规格对齐；相似度只用于候选提示，不能决定买哪个 SKU。
	const matched = matchSku(item.spec, parsed.data, source.exceptions);
	return matched && (item.spec || exceptionFor(item.spec, source.exceptions) !== undefined || matched.specId === "")
		? { target: { offerId: source.offerId, skuId: matched.skuId, specId: matched.specId } }
		: missing("人工已选货源没有唯一且明确的规格对应");
}

export function summarizePurchase(matches: Match[]): Match {
	if (matches.length === 1) return matches[0]!;
	const paidQty = matches.reduce((sum, match) => sum + match.paidQty, 0),
		unpaidQty = matches.reduce((sum, match) => sum + match.unpaidQty, 0),
		requiredQty = matches.reduce((sum, match) => sum + match.requiredQty, 0);
	const state =
		!matches.length || matches.some((match) => match.state === "unknown")
			? "unknown"
			: matches.some((match) => match.state === "refund")
				? "refund"
				: matches.every((match) => match.state === "paid")
					? "paid"
					: paidQty > 0 || (unpaidQty > 0 && paidQty + unpaidQty < requiredQty) || matches.some((match) => match.state === "partial")
						? "partial"
						: unpaidQty > 0
							? "unpaid"
							: matches.every((match) => match.state === "closed")
								? "closed"
								: "unmatched";
	const labels = {
		unknown: "采购状态待核对",
		refund: "采购退款待核对",
		paid: "已采购付款",
		partial: "部分已采购",
		unpaid: "1688 待付款",
		closed: "采购单已关闭",
		unmatched: "尚未匹配采购单",
	};
	return {
		state,
		label: labels[state],
		paidQty,
		unpaidQty,
		requiredQty,
		reason: [...new Set(matches.map((match) => match.reason).filter(Boolean))].join("；") || (!matches.length ? "订单缺少可核对的规格需求" : null),
		matches: matches.flatMap((match) => match.matches),
		canPurchase: matches.length > 0 && matches.every((match) => match.canPurchase),
	};
}

export function assertProcurementAvailable(orders: { sn: string; purchase: Match }[], selected: string[]) {
	for (const sn of selected) {
		const order = orders.find((order) => order.sn === sn);
		if (order?.purchase.canPurchase !== true)
			throw new Usage(
				`订单 ${sn} 的 1688 采购状态${order ? `为「${order.purchase.label}」：${order.purchase.reason ?? "请核对采购记录"}` : "无法确认"}，停止加购以避免重复`,
			);
	}
}
