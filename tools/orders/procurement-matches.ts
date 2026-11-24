// 采购页的事实匹配：沿用精确规格、时间窗口和先后数量分配；有采购记录不等于已付款，不改变原采购写入规则。
export type MatchNeed = {
	sn: string;
	modelId: string;
	qty: number;
	createdAt: string | null;
	target: { offerId: string; skuId: string; specId?: string | null } | null;
	offerIds?: string[];
	reason?: string;
};
export type MatchRecord = {
	account: string;
	orderId: string;
	lineId: string | null;
	offerId: string | null;
	skuId: string | null;
	quantity: string | null;
	createdAt: string | null;
	paidAt: string | null;
	status: string | null;
	fulfillment?: {
		specId: string | null;
		status: string | null;
		statusLabel: string | null;
		refund: { id: string; stage: "售中" | "售后"; status: string | null } | null;
	};
};
export type Coverage = { account: string | null; capturedAt: string | null; complete: boolean; error: string | null };
export type Match = {
	state: "paid" | "unpaid" | "partial" | "refund" | "closed" | "unmatched" | "unknown";
	label: string;
	paidQty: number;
	unpaidQty: number;
	requiredQty: number;
	reason: string | null;
	matches: { orderId: string; qty: number; status: string; paidAt: string | null; url: string }[];
	canPurchase: boolean;
};

type Kind = "paid" | "unpaid" | "refund" | "closed" | "unknown";
type Slot = { record: MatchRecord; created: number | null; left: number; kind: Kind; reason: string | null };
const SKEW_MS = 3600_000;
const INFERENCE = "按账号、精确商品规格、创建时间及数量先后推断匹配；1688 未提供对应 Shopee 订单号。";
const LABELS = {
	paid: "已采购（已付款）",
	unpaid: "已下单待付款",
	partial: "部分采购",
	refund: "退款/售后待核对",
	closed: "采购单已关闭",
	unmatched: "未匹配采购单",
	unknown: "采购状态待核对",
};

function time(value: string | null): number | null {
	if (!value) return null;
	const source = /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d$/.test(value) ? `${value.replace(" ", "T")}+08:00` : value;
	if (!/^\d{13}$/.test(source) && !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(source)) return null;
	const parsed = /^\d{13}$/.test(source) ? Number(source) : Date.parse(source);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function quantity(value: string | null): number | null {
	if (!value || !/^[1-9]\d*$/.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}
function classify(record: MatchRecord, captured: number | null): { kind: Kind; reason: string | null } {
	if (!record.fulfillment) return { kind: "unknown", reason: "采购缓存缺少逐行交易及退款状态，请刷新采购记录。" };
	const f = record.fulfillment;
	if (!f.status) return { kind: "unknown", reason: "采购行交易状态缺失。" };
	if (f.refund && (!f.refund.id || !f.refund.status)) return { kind: "unknown", reason: "采购行退款状态不完整。" };
	if (f.refund && f.refund.status !== "refundclose")
		return {
			kind: "refund",
			reason: f.refund.status === "refundsuccess" ? "匹配到退款成功记录，不能算有效已采购。" : "匹配到退款或售后记录，须核对处理结果。",
		};
	if ([record.status, f.status].some((value) => value !== null && /^(cancel|close|closed|cancelled)$/i.test(value)))
		return { kind: "closed", reason: "匹配到已关闭采购记录，历史付款不能算有效已采购。" };
	if (f.status === "waitbuyerpay") return record.paidAt ? { kind: "unknown", reason: "待付款状态与付款证据冲突。" } : { kind: "unpaid", reason: null };
	if (!["waitsellersend", "waitbuyerreceive", "success"].includes(f.status)) return { kind: "unknown", reason: `采购行状态尚未识别：${f.status}` };
	const paid = time(record.paidAt);
	if (paid === null || captured === null || paid > captured) return { kind: "unknown", reason: "缺少有效付款时间证据，不能据交易状态推断已付款。" };
	const created = time(record.createdAt);
	if (created !== null && paid < created - SKEW_MS) return { kind: "unknown", reason: "付款时间早于采购创建时间，记录时间存在冲突。" };
	return { kind: "paid", reason: null };
}
function sameTarget(need: MatchNeed, record: MatchRecord, exact: boolean): boolean {
	const t = need.target;
	if (!t) return false;
	if (exact) {
		if (record.offerId !== t.offerId || record.skuId !== t.skuId) return false;
		return typeof t.specId !== "string" || record.fulfillment?.specId === t.specId;
	}
	if (record.offerId !== null && record.offerId !== t.offerId) return false;
	if (record.skuId !== null && record.skuId !== t.skuId) return false;
	return typeof t.specId !== "string" || record.fulfillment?.specId == null || record.fulfillment.specId === t.specId;
}

export function matchProcurement(needs: MatchNeed[], records: MatchRecord[], coverage: Coverage): Map<string, Match> {
	const captured = time(coverage.capturedAt);
	const unique = new Map<string, { record: MatchRecord; conflict: boolean }>();
	for (const record of records.filter((r) => r.account === coverage.account)) {
		const key = JSON.stringify([record.account, record.orderId, record.lineId ?? [record.offerId, record.skuId, record.fulfillment?.specId ?? null]]);
		const previous = unique.get(key);
		if (previous) previous.conflict ||= record.lineId === null || JSON.stringify(previous.record) !== JSON.stringify(record);
		else unique.set(key, { record, conflict: false });
	}
	const slots: Slot[] = [...unique.values()].map(({ record, conflict }) => {
		const qty = quantity(record.quantity);
		const parsedCreated = time(record.createdAt);
		const created = parsedCreated !== null && captured !== null && parsedCreated > captured ? null : parsedCreated;
		const classification = classify(record, captured);
		const invalid = conflict
			? "同一采购行出现重复或冲突，不能重复分配数量。"
			: !record.orderId || qty === null || created === null
				? "采购记录缺少有效订单号、整数数量或创建时间。"
				: null;
		return { record, created, left: qty ?? 0, kind: invalid ? "unknown" : classification.kind, reason: invalid ?? classification.reason };
	});
	slots.sort(
		(a, b) =>
			(a.created ?? Infinity) - (b.created ?? Infinity) ||
			a.record.orderId.localeCompare(b.record.orderId) ||
			(a.record.lineId ?? "").localeCompare(b.record.lineId ?? ""),
	);
	const uniqueNeeds = new Map<string, MatchNeed>();
	const conflicts = new Set<string>();
	for (const need of needs) {
		const key = `${need.sn}:${need.modelId}`;
		const previous = uniqueNeeds.get(key);
		if (previous && JSON.stringify(previous) !== JSON.stringify(need)) conflicts.add(key);
		else uniqueNeeds.set(key, need);
	}
	const rows = [...uniqueNeeds.values()].map((need) => {
		const created = time(need.createdAt);
		const invalid = conflicts.has(`${need.sn}:${need.modelId}`)
			? "同一订单规格的需求资料冲突。"
			: (need.reason ??
				(!need.target?.offerId || !need.target.skuId
					? "尚未确定精确货源及规格，不能据商品名称匹配。"
					: !need.sn || !need.modelId || created === null || !Number.isSafeInteger(need.qty) || need.qty < 1
						? "订单创建时间或需求数量缺失，不能安全分配采购数量。"
						: captured !== null && created > captured
							? "采购快照早于订单创建时间，请刷新采购记录后核对。"
							: null));
		return {
			need,
			created,
			invalid,
			paidQty: 0,
			unpaidQty: 0,
			otherQty: 0,
			kinds: new Set<Kind>(),
			matches: [] as Match["matches"],
			active: [] as Slot[],
			reasons: [] as string[],
		};
	});
	rows.sort((a, b) => (a.created ?? Infinity) - (b.created ?? Infinity) || a.need.sn.localeCompare(b.need.sn) || a.need.modelId.localeCompare(b.need.modelId));
	const inRange = (created: number | null, slot: Slot) =>
		created !== null && slot.created !== null && captured !== null && slot.created >= created - SKEW_MS && slot.created <= captured;
	// 所有需求共用同一数量池，历史需求也先占用；关闭/退款记录不会抢占后来的有效采购。
	for (const kind of ["paid", "unpaid", "refund", "closed"] as const) {
		for (const row of rows) {
			if (row.invalid) continue;
			let left = row.need.qty - row.paidQty - row.unpaidQty - row.otherQty;
			for (const slot of slots) {
				if (left <= 0) break;
				if (slot.kind !== kind || slot.left <= 0 || !sameTarget(row.need, slot.record, true) || !inRange(row.created, slot)) continue;
				const qty = Math.min(left, slot.left);
				slot.left -= qty;
				left -= qty;
				if (kind === "paid") row.paidQty += qty;
				else if (kind === "unpaid") row.unpaidQty += qty;
				else row.otherQty += qty;
				if (kind === "paid" || kind === "unpaid") row.active.push(slot);
				row.kinds.add(kind);
				if (slot.reason) row.reasons.push(slot.reason);
				row.matches.push({
					orderId: slot.record.orderId,
					qty,
					status: kind === "refund" ? slot.record.fulfillment!.refund!.status! : slot.record.fulfillment!.status!,
					paidAt: slot.record.paidAt,
					url: `https://trade.1688.com/order/new_step_order_detail.htm?orderId=${encodeURIComponent(slot.record.orderId)}`,
				});
			}
		}
	}
	const result = new Map<string, Match>();
	for (const row of rows) {
		const { need } = row;
		const ambiguous = slots.find(
			(slot) =>
				sameTarget(need, slot.record, false) &&
				(slot.created === null || inRange(row.created, slot)) &&
				(slot.kind === "unknown" || !sameTarget(need, slot.record, true)),
		);
		const uncertainHistory = rows.some((other) => {
			if (other === row || !other.invalid) return false;
			if (other.need.target) return other.need.target.offerId === need.target?.offerId && other.need.target.skuId === need.target?.skuId;
			// 未映射的历史需求可能已用了当前候选采购；不能将“旧规格无法映射”当作“未占用采购数量”。
			return row.active.some(
				(slot) =>
					(!other.need.offerIds?.length || other.need.offerIds.includes(slot.record.offerId!)) &&
					(other.created === null || (slot.created !== null && slot.created >= other.created - SKEW_MS)),
			);
		});
		let state: Match["state"];
		let reason = row.invalid;
		if (reason || !coverage.account || captured === null || !coverage.complete || coverage.error) {
			state = "unknown";
			reason ??=
				coverage.error ?? (!coverage.account ? "采购账号尚未核对。" : captured === null ? "采购记录采集时间未知。" : "采购记录读取不完整，不能确定采购状态。");
		} else if (uncertainHistory) {
			state = "unknown";
			reason = "历史订单的货源规格、时间或数量未能核清，无法排除该采购记录已被占用，请先核对原采购单。";
		} else if (row.paidQty === need.qty) state = "paid";
		else if (row.unpaidQty === need.qty) state = "unpaid";
		else if (ambiguous) {
			state = "unknown";
			reason = ambiguous.reason ?? "相关采购记录的商品或规格编号不完整。";
		} else if (row.kinds.has("refund")) state = "refund";
		else if (row.paidQty + row.unpaidQty > 0) state = "partial";
		else if (row.kinds.has("closed")) state = "closed";
		else state = "unmatched";
		const missing = need.qty - row.paidQty - row.unpaidQty;
		const detail =
			state === "partial"
				? `需求 ${need.qty} 件，已付款 ${row.paidQty} 件，待付款 ${row.unpaidQty} 件。${missing ? `尚缺 ${missing} 件。` : "全部件数均已下单。"}`
				: null;
		result.set(`${need.sn}:${need.modelId}`, {
			state,
			label: LABELS[state],
			paidQty: row.paidQty,
			unpaidQty: row.unpaidQty,
			requiredQty: need.qty,
			reason: [reason, detail, ...new Set(row.reasons), row.matches.length ? INFERENCE : null].filter(Boolean).join("；") || null,
			matches: row.matches,
			canPurchase: state === "unmatched" || state === "closed",
		});
	}
	return result;
}
