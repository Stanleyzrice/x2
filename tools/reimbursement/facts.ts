// 完整采购分页的校验与金额显示：未知不补零，汇总只使用明确付款时间的订单，原实付不扣退款。
import type { PurchaseFact, PurchasePage } from "../../connectors/sites/1688/purchases.ts";
import { Usage } from "../../platform/errors.ts";

export type Progress = { page: number; pages: number; observed: number; total: number };
export type StoredPurchase = PurchaseFact & { receipt: { paidAt: string | null; originalMinor: string | null; revision: string | null } };

export async function collectAccountHistory(
	expected: string,
	identify: () => Promise<string | null>,
	read: (page: number) => Promise<PurchasePage>,
	progress: (value: Progress) => Promise<void>,
): Promise<PurchaseFact[]> {
	if ((await identify()) !== expected) throw new Error("1688 同步开始时账号身份不符");
	const facts = await collectHistory(read, progress);
	if ((await identify()) !== expected) throw new Error("1688 同步结束时账号身份变化");
	return facts;
}

export function preservePayment(previous: StoredPurchase | undefined, next: PurchaseFact, revision: string): StoredPurchase {
	if (previous && previous.orderId !== next.orderId) throw new Error("采购订单不一致，不能合并付款事实");
	const old = previous?.receipt;
	const currentPaid = next.paymentEvidence !== null;
	const paidAt = old?.paidAt ?? (currentPaid ? next.paidAt : null);
	const originalMinor = old?.originalMinor ?? (currentPaid ? next.paidMinor : null);
	const sourceRevision = old?.originalMinor !== null && old?.originalMinor !== undefined ? old.revision : currentPaid ? revision : (old?.revision ?? null);
	return { ...next, receipt: { paidAt, originalMinor, revision: sourceRevision } };
}

export async function collectHistory(read: (page: number) => Promise<PurchasePage>, progress: (value: Progress) => Promise<void>): Promise<PurchaseFact[]> {
	const first = await read(1);
	if (first.total > 0 && first.pages < 1) throw new Error("1688 有订单但未给出有效分页数");
	const facts = new Map<string, PurchaseFact>();
	const add = (page: PurchasePage, n: number) => {
		if (page.total !== first.total || page.pages !== first.pages) throw new Error("1688 分页总数变化，本次不替换上次成功数据");
		if (!page.rows.length && n <= first.pages && first.total > 0) throw new Error(`1688 第 ${n} 页为空，历史读取不完整`);
		for (const row of page.rows) {
			if (facts.has(row.orderId)) throw new Error(`1688 分页出现重复订单 ${row.orderId}，历史读取不完整`);
			facts.set(row.orderId, row);
		}
	};
	add(first, 1);
	await progress({ page: 1, pages: first.pages, observed: facts.size, total: first.total });
	for (let n = 2; n <= first.pages; n++) {
		add(await read(n), n);
		await progress({ page: n, pages: first.pages, observed: facts.size, total: first.total });
	}
	if (facts.size !== first.total) throw new Error(`1688 预计 ${first.total} 张订单，只完整读取 ${facts.size} 张`);
	const end = await read(1);
	if (end.total !== first.total || end.pages !== first.pages || end.rows.map((r) => r.orderId).join(",") !== first.rows.map((r) => r.orderId).join(","))
		throw new Error("1688 同步期间订单列表变化，本次不发布不完整快照");
	return [...facts.values()];
}

export function money(minor: string | null): string | null {
	if (minor === null) return null;
	const value = BigInt(minor);
	return `¥${(value / 100n).toLocaleString("en-US")}.${(value % 100n).toString().padStart(2, "0")}`;
}

export function paymentRange(paidFrom = "", paidTo = ""): { from: string | null; toExclusive: string | null } {
	const midnight = (day: string) => {
		if (!/^\d{4}-\d\d-\d\d$/.test(day)) throw new Usage("付款日期应为 YYYY-MM-DD");
		const calendar = new Date(`${day}T00:00:00Z`);
		if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) throw new Usage("付款日期不是有效日历日期");
		return Date.parse(`${day}T00:00:00+08:00`);
	};
	const from = paidFrom ? midnight(paidFrom) : null;
	const through = paidTo ? midnight(paidTo) : null;
	if (from !== null && through !== null && from > through) throw new Usage("付款起始日期不能晚于截止日期");
	return { from: from === null ? null : new Date(from).toISOString(), toExclusive: through === null ? null : new Date(through + 86_400_000).toISOString() };
}

export function summarizeOriginalAmounts(amounts: Iterable<string | null>) {
	let total = 0n;
	let knownCount = 0;
	let missingCount = 0;
	for (const minor of amounts) {
		if (minor === null) missingCount++;
		else {
			total += BigInt(minor);
			knownCount++;
		}
	}
	const amountMinor = knownCount || !missingCount ? total.toString() : null;
	return { orderCount: knownCount + missingCount, knownCount, missingCount, amountMinor, amountDisplay: money(amountMinor), complete: missingCount === 0 };
}

export function present(fact: PurchaseFact) {
	return {
		...fact,
		url: `https://trade.1688.com/order/new_step_order_detail.htm?orderId=${encodeURIComponent(fact.orderId)}`,
		paidDisplay: money(fact.paidMinor),
		goodsDisplay: money(fact.goodsMinor),
		freightDisplay: money(fact.freightMinor),
		discountDisplay: money(fact.discountMinor),
		items: fact.items.map((i) => ({ ...i, image: i.image ?? null, unitPriceDisplay: money(i.unitPriceMinor) })),
	};
}
