// 身份匹配直接测试生产纯函数；DB stub 只返回元数据，实际 prepare 提前返回，不接触网站。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "../../platform/db/index.ts";
import { catalogWriteBlock, sameCatalogProduct } from "./write-guard.ts";
import { LISTING_WRITES } from "./writes.ts";

const saved = { id: "9", shopId: "77", productId: "42", parentSku: "old-sku" };
const existing = { shopId: "77", productId: "42", parentSku: "renamed" };

test("已有商品按稳定店铺和商品 id 匹配 Catalog，SKU 改名不改变身份", () => {
	assert.equal(sameCatalogProduct(saved, existing), true);
	assert.equal(sameCatalogProduct({ ...saved, parentSku: "another-sku" }, existing), true);
	assert.equal(sameCatalogProduct({ ...saved, shopId: "78" }, existing), false);
	assert.equal(sameCatalogProduct({ ...saved, productId: "43", parentSku: existing.parentSku }, existing), false);
});
test("已知商品 id 不能退回同 SKU 猜配；缺失身份不匹配", () => {
	assert.equal(sameCatalogProduct({ ...saved, productId: null, parentSku: existing.parentSku }, existing), false);
	assert.equal(sameCatalogProduct({ ...saved, shopId: null }, existing), false);
	assert.equal(sameCatalogProduct({ ...saved, productId: null, parentSku: null }, existing), false);
});
test("建商品尚无 productId 时保留旧 SKU 互斥；其他或空 SKU 不匹配", () => {
	assert.equal(sameCatalogProduct(saved, { shopId: "77", parentSku: "old-sku" }), true);
	assert.equal(sameCatalogProduct(saved, { shopId: "77", parentSku: "other-sku" }), false);
	assert.equal(sameCatalogProduct(saved, { shopId: "78", parentSku: "old-sku" }), false);
	assert.equal(sameCatalogProduct({ ...saved, parentSku: "" }, { shopId: "77", parentSku: "" }), false);
});
test("DB 层只读当前店铺未结 Catalog 元数据，由实际 matcher 决定阻断", async () => {
	let reads = 0;
	const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
		reads++;
		const q = strings.join("?").replace(/\s+/g, " ");
		assert.match(q, /op = 'Catalog状态' and status in \('已提交', '结果未知', '不一致'\)/);
		assert.match(q, /and params->'expected'->>'shopId' = \?/);
		assert.deepEqual(values, ["77"]);
		// 直接交回固定结果，不在 stub 内实现 SQL 或身份筛选。
		return [saved];
	}) as unknown as Sql;
	assert.match((await catalogWriteBlock(sql, existing))!, /没核清.*#9/);
	assert.equal(await catalogWriteBlock(sql, { ...existing, productId: "43", parentSku: saved.parentSku }), null);
	assert.equal(await catalogWriteBlock(sql, { shopId: "77", parentSku: "" }), null);
	assert.equal(reads, 2);
});
test("建商品 prepare 在读取商品稿和访问网站之前被未结 Catalog 阻断", async () => {
	const queries: string[] = [];
	const sql = (async (strings: TemplateStringsArray) => {
		const q = strings.join("?").replace(/\s+/g, " ");
		queries.push(q);
		assert.match(q, /from writes where op = 'Catalog状态'/, "阻断后不能继续读取商品稿或进入网站步骤");
		return [saved];
	}) as unknown as Sql;
	const result = await LISTING_WRITES.建商品!.prepare(sql, {
		listingId: 1,
		shop: "ni1206",
		shopId: "77",
		parentSku: "old-sku",
		productInfo: {},
		hash: "fixture",
	});
	assert.deepEqual(result, { skip: "同一个商品有没核清的 Catalog 写入 #9：先核清再做" });
	assert.equal(queries.length, 1);
});
