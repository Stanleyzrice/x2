// 采购历史完整性与精确显示：覆盖超过三页、分页漂移、重复订单、空页以及缺失金额。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PurchaseFact, PurchasePage } from "../../connectors/sites/1688/purchases.ts";
import { collectAccountHistory, collectHistory, money, present, preservePayment } from "./facts.ts";

const fact = (orderId: string): PurchaseFact => ({
	orderId,
	status: "success",
	statusLabel: "交易成功",
	createdAt: null,
	paidAt: "2026-10-01T00:00:00.000Z",
	supplier: null,
	currency: "CNY",
	goodsMinor: "100",
	freightMinor: "10",
	discountMinor: "0",
	paidMinor: "110",
	paymentEvidence: "gmtPayment",
	items: [],
});
const page = (id: string, total = 4, pages = 4): PurchasePage => ({ total, pages, rows: [fact(id)] });

test("第一次读取完整历史，超过三页仍继续，最后重读首页确认未漂移", async () => {
	const calls: number[] = [];
	const progress: number[] = [];
	const rows = await collectHistory(
		async (n) => {
			calls.push(n);
			return page(String(n));
		},
		async (p) => {
			progress.push(p.page);
		},
	);
	assert.deepEqual(
		rows.map((r) => r.orderId),
		["1", "2", "3", "4"],
	);
	assert.deepEqual(calls, [1, 2, 3, 4, 1]);
	assert.deepEqual(progress, [1, 2, 3, 4]);
});

test("分页重复、空页、总数改变以及首页漂移都不能发布新结果", async () => {
	await assert.rejects(
		collectHistory(
			async () => page("1"),
			async () => {},
		),
		/重复订单/,
	);
	await assert.rejects(
		collectHistory(
			async (n) => (n === 1 ? page("1") : { total: 4, pages: 4, rows: [] }),
			async () => {},
		),
		/为空/,
	);
	await assert.rejects(
		collectHistory(
			async (n) => page(String(n), n === 1 ? 4 : 5),
			async () => {},
		),
		/总数变化/,
	);
	let calls = 0;
	await assert.rejects(
		collectHistory(
			async () => page(String(++calls), 1, 1),
			async () => {},
		),
		/同步期间/,
	);
});

test("空账号历史也需明确总数，读取异常向上层抛出以保留旧数据", async () => {
	assert.deepEqual(
		await collectHistory(
			async () => ({ total: 0, pages: 0, rows: [] }),
			async () => {},
		),
		[],
	);
	await assert.rejects(
		collectHistory(
			async () => page("1", 4, 1),
			async () => {},
		),
		/预计 4/,
	);
	await assert.rejects(
		collectHistory(
			async () => {
				throw new Error("登录失效");
			},
			async () => {},
		),
		/登录失效/,
	);
});

test("金额用BigInt分格式化；未知保留null，长订单链接保持文本ID", () => {
	assert.equal(money("12345678901234567890"), "¥123,456,789,012,345,678.90");
	assert.equal(money("0"), "¥0.00");
	assert.equal(money(null), null);
	assert.match(present(fact("3012345678901234567")).url, /3012345678901234567$/);
	assert.equal(present({ ...fact("1"), paidMinor: null }).paidDisplay, null);
});

test("同一订单更新退款状态时保留原付款事实，源金额缺失或变零不冲减原实付", () => {
	const initial = preservePayment(undefined, fact("1"), "first");
	const refunded = preservePayment(initial, { ...fact("1"), status: "cancel", paidAt: null, paymentEvidence: null, paidMinor: "0" }, "second");
	assert.equal(refunded.status, "cancel");
	assert.equal(refunded.paidMinor, "0", "本轮网站事实仍原样保留");
	assert.deepEqual(refunded.receipt, { paidAt: fact("1").paidAt, originalMinor: "110", revision: "first" });
	assert.throws(() => preservePayment(initial, fact("2"), "third"), /订单不一致/);
	const unknown = preservePayment(undefined, { ...fact("1"), paidAt: null, paymentEvidence: null, paidMinor: null }, "first");
	assert.equal(preservePayment(unknown, fact("1"), "second").receipt.originalMinor, "110");
});

test("读取前后都核对账号；中途切换账号不能发布跨账号记录", async () => {
	let reads = 0;
	const read = async () => {
		reads++;
		return page("1", 1, 1);
	};
	await assert.rejects(
		collectAccountHistory(
			"A",
			async () => "B",
			read,
			async () => {},
		),
		/开始时账号/,
	);
	assert.equal(reads, 0);
	let identity = 0;
	await assert.rejects(
		collectAccountHistory(
			"A",
			async () => (++identity === 1 ? "A" : "B"),
			read,
			async () => {},
		),
		/结束时账号/,
	);
});
