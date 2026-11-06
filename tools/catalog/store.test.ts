// 目录读缓存不访问外站；保持分页、店铺归属与快照信息，独立只读查询并发避免叠加远程往返。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "../../platform/db/index.ts";
import { productFact } from "./facts.ts";
import { readCatalog } from "./store.ts";

const fact = {
	...productFact({ productId: "101", name: "缓存商品", status: 1, cover: "" }, null),
	models: [{ modelId: "sku-id", sku: "SKU", name: "默认规格", price: 9, stock: 2, tierIndex: [] }],
};
const batch = {
	id: "revision",
	status: "complete",
	started_at: new Date("2026-11-01T00:00:00Z"),
	captured_at: new Date("2026-11-01T00:01:00Z"),
	finished_at: new Date("2026-11-01T00:01:00Z"),
	complete: true,
	details_complete: false,
	expected_count: 89,
	product_count: 89,
	error: null,
	phase: null,
	page: null,
	observed: null,
};

function fixture(hasSnapshot = true) {
	const active = [0, 0, 0],
		peak = [0, 0, 0];
	const queries: { text: string; values: unknown[] }[] = [];
	const run = (strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
		if (!("raw" in strings)) return [];
		const q = strings
			.reduce((text, part, index) => {
				const value = values[index];
				const fragment = value && typeof value === "object" && "fragment" in value ? String(value.fragment) : "?";
				return text + part + (index < values.length ? fragment : "");
			}, "")
			.replace(/\s+/g, " ")
			.trim();
		if (!q.startsWith("select")) return { fragment: q };
		queries.push({ text: q, values });
		let stage = -1;
		let rows: unknown[];
		if (q.startsWith("select shop, shop_id")) rows = [{ shop: "fixture", shop_id: "10" }];
		else if (q.startsWith("select b.*")) {
			stage = 0;
			rows = hasSnapshot ? [batch] : [];
		} else if (q.startsWith("select * from catalog_syncs")) {
			stage = 0;
			rows = [batch];
		} else if (q.startsWith("select count(*)")) {
			stage = 1;
			rows = [{ total: 89, listedCount: 89, listedDetailsComplete: false }];
		} else if (q.includes(" as facts from catalog_products")) {
			stage = 1;
			rows = [{ facts: q.includes("facts - 'models'") ? { ...fact, models: null, modelsDeferred: true } : fact }];
		} else if (q.startsWith("select distinct status")) {
			stage = 1;
			rows = [{ status: 1, label: "已上架" }];
		} else if (q.startsWith("select l.shop")) {
			stage = 2;
			rows = [
				{ shop: "fixture", shopId: "10", productId: "101", offerId: "201" },
				{ shop: "other", shopId: "20", productId: "101", offerId: "999" },
			];
		} else if (q.startsWith("select item_id") || q.startsWith("select distinct i->>") || q.startsWith("select distinct on (i.product_id)")) {
			stage = 2;
			rows = [];
		} else throw new Error(`意外的查询：${q}`);
		if (stage >= 0) peak[stage] = Math.max(peak[stage]!, ++active[stage]!);
		return new Promise<unknown[]>((resolve) => {
			setImmediate(() => {
				if (stage >= 0) active[stage]!--;
				resolve(rows);
			});
		});
	};
	return { sql: run as unknown as Sql, queries, peak };
}

test("缓存目录并发读取独立数据，保留分页总数、快照及精确店铺货源归属", async () => {
	const f = fixture();
	const result = await readCatalog(f.sql, { shop: "fixture", query: "SKU", status: "1", stock: "all", page: 2, pageSize: 50 });
	assert.deepEqual(f.peak, [2, 3, 4]);
	assert.equal(result.shopId, "10");
	assert.equal(result.snapshot?.revision, "revision");
	assert.equal(result.snapshot?.capturedAt, "2026-11-01T00:01:00.000Z");
	assert.equal(result.snapshot?.detailsComplete, false);
	assert.equal(result.lastAttempt?.revision, "revision");
	assert.equal(result.total, 89);
	assert.equal(result.listedCount, 89);
	assert.equal(result.listedDetailsComplete, false);
	assert.equal(result.page, 2);
	assert.equal(result.pageSize, 50);
	assert.deepEqual(result.statuses, [{ status: 1, label: "已上架" }]);
	assert.equal(result.rows[0]?.productId, "101");
	assert.equal(result.rows[0]?.priceMin, null);
	assert.deepEqual(result.rows[0]?.models, fact.models);
	assert.equal(result.rows[0]?.modelsDeferred, undefined);
	assert.deepEqual(
		result.rows[0]?.suppliers.map((supplier) => supplier.offerId),
		["201"],
	);
	assert.equal(result.rows[0]?.statusChange, null);
	assert.equal(f.queries.length, 10);
	const pageQuery = f.queries.find((q) => q.text.includes(" as facts from catalog_products"))!;
	assert.deepEqual(pageQuery.values.slice(-2), [50, 50]);
});

test("网页目录在数据库投影中延后 SKU 明细，不改变筛选、计数或完整性", async () => {
	const f = fixture();
	const result = await readCatalog(f.sql, { shop: "fixture", query: "SKU", status: "1", stock: "all", page: 1, pageSize: 50 }, true);
	assert.equal(result.rows[0]?.models, null);
	assert.equal(result.rows[0]?.modelsDeferred, true);
	assert.equal(result.rows[0]?.productId, "101");
	assert.equal(result.total, 89);
	assert.equal(result.listedCount, 89);
	assert.equal(result.listedDetailsComplete, false);
	assert.equal(result.snapshot?.detailsComplete, false);
	const pageQuery = f.queries.find((q) => q.text.includes(" as facts from catalog_products"))!;
	assert.match(pageQuery.text, /facts - 'models'/);
	assert.match(pageQuery.text, /jsonb_build_object\('models', null, 'modelsDeferred', true\)/);
});

test("没有当前快照时只读元信息，不扫描商品或附加关联", async () => {
	const f = fixture(false);
	const result = await readCatalog(f.sql, { shop: "fixture", query: "", status: "all", stock: "all", page: 1, pageSize: 50 });
	assert.equal(result.snapshot, null);
	assert.equal(result.lastAttempt?.revision, "revision");
	assert.deepEqual(result.rows, []);
	assert.equal(result.total, 0);
	assert.deepEqual(f.peak, [2, 0, 0]);
	assert.equal(f.queries.length, 3);
});
