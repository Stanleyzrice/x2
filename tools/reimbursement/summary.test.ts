// 付款日期边界按上海自然日处理，汇总使用完整匹配集与精确原实付分，不受列表分页影响。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "../../platform/db/index.ts";
import { paymentRange, summarizeOriginalAmounts } from "./facts.ts";
import { listRecords } from "./index.ts";

test("起止付款日期包含上海当天，截止次日零时排除；默认不限制历史", () => {
	assert.deepEqual(paymentRange(), { from: null, toExclusive: null });
	assert.deepEqual(paymentRange("2026-11-01", "2026-11-01"), { from: "2026-10-31T16:00:00.000Z", toExclusive: "2026-11-01T16:00:00.000Z" });
	assert.deepEqual(paymentRange("", "2024-02-29"), { from: null, toExclusive: "2024-02-29T16:00:00.000Z" });
	assert.deepEqual(paymentRange("2026-11-01"), { from: "2026-10-31T16:00:00.000Z", toExclusive: null });
	assert.throws(() => paymentRange("2026-02-30"), /有效日历日期/);
	assert.throws(() => paymentRange("2026-11-02", "2026-11-01"), /不能晚于/);
	assert.throws(() => paymentRange("11/01/2026"), /YYYY-MM-DD/);
});

test("原实付精确相加，区分空结果、零金额和未知金额", () => {
	assert.deepEqual(summarizeOriginalAmounts(["900719925474099312345", "1", null]), {
		orderCount: 3,
		knownCount: 2,
		missingCount: 1,
		amountMinor: "900719925474099312346",
		amountDisplay: "¥9,007,199,254,740,993,123.46",
		complete: false,
	});
	assert.equal(summarizeOriginalAmounts([null, null]).amountMinor, null);
	assert.equal(summarizeOriginalAmounts([null, null]).amountDisplay, null);
	assert.equal(summarizeOriginalAmounts(["0"]).amountDisplay, "¥0.00");
	assert.equal(summarizeOriginalAmounts([]).amountDisplay, "¥0.00");
	assert.equal(summarizeOriginalAmounts([]).complete, true);
});

test("总额及未报帐金额覆盖全部52个匹配项，不受页码影响，账号搜索日期沿用同一筛选", async () => {
	const amounts = [
		...Array.from({ length: 50 }, (_, i) => ({ minor: "100", reported: i < 25 })),
		{ minor: "5000", reported: true },
		{ minor: null, reported: false },
	];
	const queries: { text: string; values: unknown[] }[] = [];
	const scope = {};
	const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
		const text = strings.join("?").trim();
		queries.push({ text, values });
		if (text.startsWith("where")) return scope;
		if (text.includes("originalMinor")) return amounts;
		return [];
	}) as unknown as Sql;
	for (const offset of [0, 50]) {
		const result = await listRecords(sql, { account: "A", search: "商品", paidFrom: "2026-11-01", paidTo: "2026-11-01", offset });
		assert.equal(result.total, 52);
		assert.equal(result.summary.amountDisplay, "¥100.00");
		assert.equal(result.summary.knownCount, 51);
		assert.equal(result.summary.missingCount, 1);
		assert.deepEqual(result.pendingSummary, {
			orderCount: 26,
			knownCount: 25,
			missingCount: 1,
			amountMinor: "2500",
			amountDisplay: "¥25.00",
			complete: false,
		});
	}
	const aggregation = queries.filter((q) => q.text.includes("originalMinor"));
	assert.equal(aggregation.length, 2);
	for (const query of aggregation) {
		assert.ok(query.values.includes(scope));
		assert.doesNotMatch(query.text, /limit|offset/i);
	}
	assert.ok(queries.some((q) => q.text.includes("o.paid_at >=") && q.values.includes("2026-10-31T16:00:00.000Z")));
	assert.ok(queries.some((q) => q.text.includes("o.paid_at <") && q.values.includes("2026-11-01T16:00:00.000Z")));
});

test("未报帐仅有未知原实付时不显示零金额，全部已报帐时待报为空", async () => {
	let amounts: { minor: string | null; reported: boolean }[] = [
		{ minor: "900719925474099312345", reported: true },
		{ minor: null, reported: false },
	];
	const sql = ((strings: TemplateStringsArray) => (strings.join("").includes("originalMinor") ? amounts : [])) as unknown as Sql;
	const pending = (await listRecords(sql, { search: "", offset: 0 })).pendingSummary;
	assert.equal(pending.orderCount, 1);
	assert.equal(pending.missingCount, 1);
	assert.equal(pending.amountDisplay, null);
	amounts = amounts.map((row) => ({ ...row, reported: true }));
	const empty = (await listRecords(sql, { search: "", offset: 0 })).pendingSummary;
	assert.equal(empty.orderCount, 0);
	assert.equal(empty.amountDisplay, "¥0.00");
	assert.equal(empty.complete, true);
});

test("订单行返回独立人工标记、默认版本和已报帐时间，不改原实付展示", async () => {
	const fact = {
		orderId: "order",
		status: "success",
		statusLabel: "交易成功",
		createdAt: null,
		paidAt: "2026-10-01T00:00:00.000Z",
		supplier: null,
		currency: "CNY",
		goodsMinor: "100",
		freightMinor: "10",
		discountMinor: "0",
		paidMinor: "0",
		paymentEvidence: "gmtPayment",
		items: [],
		receipt: { paidAt: "2026-10-01T00:00:00.000Z", originalMinor: "110", revision: "original" },
	};
	const rows = [
		{ account: "A", fact, reported: false, reportRevision: 0, reportedAt: null },
		{ account: "B", fact, reported: true, reportRevision: 4, reportedAt: new Date("2026-11-01T10:00:00Z") },
	];
	const sql = ((strings: TemplateStringsArray) => {
		const text = strings.join("").trim();
		if (text.startsWith("select o.account_id")) return rows;
		if (text.includes("originalMinor")) return rows.map((r) => ({ minor: r.fact.receipt.originalMinor, reported: r.reported }));
		return [];
	}) as unknown as Sql;
	const result = await listRecords(sql, { search: "", offset: 0 });
	assert.deepEqual(
		result.rows.map((r) => ({ reported: r.reported, reportRevision: r.reportRevision, reportedAt: r.reportedAt, paidDisplay: r.paidDisplay })),
		[
			{ reported: false, reportRevision: 0, reportedAt: null, paidDisplay: "¥1.10" },
			{ reported: true, reportRevision: 4, reportedAt: "2026-11-01T10:00:00.000Z", paidDisplay: "¥1.10" },
		],
	);
	assert.equal(result.summary.amountDisplay, "¥2.20");
	assert.equal(result.pendingSummary.amountDisplay, "¥1.10");
});
