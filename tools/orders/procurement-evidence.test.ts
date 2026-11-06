// 采购页从本地完整快照读事实，测试只使用模拟 SQL 与明确 SKU 对应，不访问账号或站点。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "../../platform/db/index.ts";
import { monitor } from "./procurement.ts";
import {
	assertProcurementAvailable,
	type EvidenceCatalog,
	type EvidenceListing,
	type EvidenceSource,
	procurementTarget,
	readPurchaseEvidence,
	summarizePurchase,
} from "./procurement-evidence.ts";
import type { Match } from "./procurement-matches.ts";

const target = { shop: "one", shopId: "10" };
const item = { itemId: "11", modelId: "12", name: "名称相同不用于匹配", spec: "大号", qty: 1, image: "" };
const listing: EvidenceListing = {
	...target,
	productId: "11",
	offerId: "101",
	title: null,
	variants: { variants: [{ sku: "sku-one", skuId: "201", specId: "spec-one" }] },
	offer: { offerId: "101", skus: [{ skuId: "201", specId: "spec-one" }] },
};
const catalog: EvidenceCatalog = { ...target, productId: "11", models: [{ modelId: "12", sku: "sku-one" }] };
const source: EvidenceSource = {
	itemId: "11",
	offerId: "102",
	title: null,
	itemImage: null,
	broken: null,
	skus: [],
	exceptions: null,
};

function evidenceFixture(overrides: Record<string, unknown> = {}, duplicate = false) {
	const account = {
		selected: "tb-current",
		account: "4067517207",
		loginId: "tb-current",
		revision: "current-head",
		capturedAt: new Date("2026-11-06T06:00:00Z"),
		headStatus: "succeeded",
		lastStatus: "succeeded",
		lastError: null,
		...overrides,
	};
	const fact = {
		orderId: "3012345678901234567",
		status: "waitsellersend",
		createdAt: String(Date.parse("2026-11-06T04:00:00Z")),
		paidAt: "2026-11-06T04:05:00.000Z",
		paymentEvidence: "gmtPayment",
		items: [
			{
				lineId: "line-1",
				offerId: "101",
				skuId: "201",
				quantity: "2",
				fulfillment: { specId: "spec-one", status: "waitsellersend", statusLabel: "待发货", refund: null },
			},
		],
	};
	const queries: { text: string; values: unknown[] }[] = [];
	const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
		const text = strings.join("?").trim();
		queries.push({ text, values });
		if (text.includes("from order_settings s")) return Promise.resolve(duplicate ? [account, { ...account, account: "other" }] : [account]);
		if (text.includes("from reimbursement_orders o")) return Promise.resolve([{ fact }]);
		throw new Error(`意外查询：${text}`);
	}) as unknown as Sql;
	return { sql, queries, fact };
}

test("读取唯一当前采购账号的完整成功head，不筛掉未付订单且不混入旧revision", async () => {
	const f = evidenceFixture();
	const result = await readPurchaseEvidence(f.sql);
	assert.deepEqual(result.coverage, { account: "4067517207", loginId: "tb-current", capturedAt: "2026-11-06T06:00:00.000Z", complete: true, error: null });
	assert.equal(result.records[0]?.orderId, "3012345678901234567");
	assert.equal(result.records[0]?.createdAt, "2026-11-06T04:00:00.000Z");
	assert.equal(result.records[0]?.fulfillment?.status, "waitsellersend");
	assert.deepEqual(f.queries[1]?.values, ["4067517207", "current-head"]);
	assert.match(f.queries[1]!.text, /a.revision = o.revision/);
	assert.doesNotMatch(f.queries[1]!.text, /paid_at is not null/i);
	assert.match(f.queries[0]!.text, /where account_id = a.account_id/);
	assert.ok(f.queries.every((query) => query.text.startsWith("select")));
});

test("账号映射冲突或无成功head不读采购行；当前账号同步失败保留旧事实但完整性不冒充成功", async () => {
	for (const fixture of [evidenceFixture({}, true), evidenceFixture({ account: null }), evidenceFixture({ headStatus: null })]) {
		const result = await readPurchaseEvidence(fixture.sql);
		assert.equal(result.coverage.complete, false);
		assert.ok(result.coverage.error);
		assert.deepEqual(result.records, []);
		assert.equal(fixture.queries.length, 1);
	}
	const failed = evidenceFixture({ lastStatus: "failed", lastError: "当前账号读取失败" });
	const result = await readPurchaseEvidence(failed.sql);
	assert.equal(result.coverage.complete, false);
	assert.equal(result.coverage.error, "当前账号读取失败");
	assert.equal(result.records.length, 1);
});

test("历史付款receipt不能替代当前付款证据，旧cache缺少履约字段保留未知", async () => {
	const f = evidenceFixture();
	f.fact.paymentEvidence = "";
	const legacy: Partial<(typeof f.fact.items)[number]> = f.fact.items[0]!;
	delete legacy.fulfillment;
	const result = await readPurchaseEvidence(f.sql);
	assert.equal(result.records[0]?.paidAt, null);
	assert.equal(result.records[0]?.fulfillment, undefined);
});

test("精确型号经本店catalog SKU与已发布稿映射，不使用其他店或名称相同的货源", () => {
	assert.deepEqual(procurementTarget(target, item, [], [listing], [catalog]).target, { offerId: "101", skuId: "201", specId: "spec-one" });
	assert.equal(procurementTarget(target, item, [], [{ ...listing, shopId: "other" }], [catalog]).target, null);
	assert.equal(procurementTarget(target, item, [], [listing], [{ ...catalog, shop: "other" }]).target, null);
	const duplicate = {
		...catalog,
		models: [
			{ modelId: "12", sku: "sku-one" },
			{ modelId: "13", sku: "sku-one" },
		],
	};
	assert.equal(procurementTarget(target, item, [], [listing], [duplicate]).target, null);
	assert.equal(procurementTarget(target, item, [], [listing, listing], [catalog]).target, null);
	assert.equal(procurementTarget(target, item, [], [{ ...listing, offer: { offerId: "999", skus: [] } }], [catalog]).target, null);
});

test("人工选货源只接受唯一明确规格或人工例外，不用相似度排名猜规格", () => {
	const selected = { ...source, skus: [{ skuId: "202", specId: "spec-large", name: "大号" }] };
	assert.deepEqual(procurementTarget(target, item, [selected], [], []).target, { offerId: "102", skuId: "202", specId: "spec-large" });
	assert.equal(procurementTarget(target, { ...item, spec: "大号加厚" }, [selected], [], []).target, null);
	assert.equal(procurementTarget(target, item, [selected, selected], [], []).target, null);
	assert.equal(procurementTarget(target, item, [{ ...selected, broken: "失效" }], [], []).target, null);
	assert.equal(procurementTarget(target, { ...item, spec: "页面规格" }, [{ ...selected, exceptions: "页面规格 = 大号" }], [], []).target?.skuId, "202");
});

const match = (state: Match["state"], canPurchase = false): Match => ({
	state,
	label: state,
	paidQty: state === "paid" ? 1 : 0,
	unpaidQty: state === "unpaid" ? 1 : 0,
	requiredQty: 1,
	reason: "实际状态",
	matches: [],
	canPurchase,
});

test("订单按全部行聚合，未知/退款不被其他已付款行盖过，后端阻止已有或不明采购再次加购", () => {
	assert.equal(summarizePurchase([match("paid"), match("paid")]).state, "paid");
	assert.equal(summarizePurchase([match("paid"), match("unpaid")]).state, "partial");
	assert.equal(summarizePurchase([match("unpaid"), match("unmatched", true)]).state, "partial");
	assert.equal(summarizePurchase([match("paid"), match("unknown")]).state, "unknown");
	assert.equal(summarizePurchase([match("paid"), match("refund")]).state, "refund");
	assert.equal(summarizePurchase([]).canPurchase, false);
	for (const state of ["paid", "unpaid", "partial", "refund", "unknown"] as const)
		assert.throws(() => assertProcurementAvailable([{ sn: "order", purchase: match(state) }], ["order"]), /停止加购/);
	assert.throws(() => assertProcurementAvailable([], ["missing"]), /无法确认/);
	assert.doesNotThrow(() => assertProcurementAvailable([{ sn: "order", purchase: match("unmatched", true) }], ["order"]));
});

test("monitor首屏只读完整采购快照，已出货历史需求先占量但不进入待出货列表", async () => {
	const f = evidenceFixture();
	const current = {
		sn: "new-order",
		shop: target.shop,
		shop_id: target.shopId,
		created_at: new Date("2026-11-06T05:00:00Z"),
		ship_by: null,
		items_text: "当前待采购",
		items: [item],
		step: null,
		cart_pending: false,
		cart_done: false,
	};
	const previous = { ...current, sn: "shipped-order", created_at: new Date("2026-11-06T03:30:00Z") };
	const queries: string[] = [];
	const sql = ((strings: TemplateStringsArray | string[], ...values: unknown[]) => {
		if (!("raw" in strings)) return {};
		const query = strings.join("?");
		queries.push(query);
		if (query.includes("from orders o")) return Promise.resolve(query.includes("and o.procurement_eligible") ? [current] : [previous, current]);
		if (query.includes("from sources")) return Promise.resolve([]);
		if (query.includes("from listings")) return Promise.resolve([listing]);
		if (query.includes("from catalog_products")) return Promise.resolve([catalog]);
		return f.sql(strings, ...(values as never[]));
	}) as unknown as Sql;
	f.fact.items[0]!.quantity = "1";
	const result = await monitor(sql, [target.shop]);
	assert.equal(result.purchases.account, "4067517207");
	assert.equal(result.purchases.complete, true);
	assert.deepEqual(
		result.orders.map((order) => order.sn),
		["new-order"],
	);
	assert.equal(result.orders[0]?.purchase.state, "unmatched");
	assert.equal(result.orders[0]?.purchase.paidQty, 0);
	assert.equal(result.orders[0]?.purchase.canPurchase, true);
	f.fact.items[0]!.quantity = "2";
	const enough = await monitor(sql, [target.shop]);
	assert.equal(enough.orders[0]?.purchase.state, "paid");
	assert.equal(enough.orders[0]?.lines[0]?.purchase.paidQty, 1);
	assert.equal(enough.orders[0]?.purchase.canPurchase, false);
	previous.items = [{ ...item, modelId: "old-model-without-mapping" }];
	const uncertain = await monitor(sql, [target.shop]);
	assert.equal(uncertain.orders[0]?.purchase.state, "unknown");
	assert.equal(uncertain.orders[0]?.purchase.canPurchase, false);
	assert.ok(queries.every((query) => query.startsWith("select")));
});
