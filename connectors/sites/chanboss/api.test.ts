// chanboss 的回包解析：拿 fixtures 里的样本（照代码和 NOTES.md 写的）跑解析；订单只认用到的格，别的列表原样回
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { identityOf, ordersOf, pageOf } from "./api.ts";

const sample = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("订单列表：一页的条数、页数是数字；每一行原样回（值不改），用到的格都在", () => {
	const r = ordersOf(sample("list-order"));
	assert.deepEqual([r.total, r.pageCount, r.rows.length], [2, 1, 2]);
	assert.deepEqual(
		r.rows.map((o) => [o.sn, o.id, o.status, o.platform_status, o.item_detail_new?.length]),
		[
			["251009ABCDEF01", 88001234, "paid", "READY_TO_SHIP", 1],
			["251009ABCDEF02", "88001235", "pre_report", "CANCELLED", 0],
		],
	);
	assert.equal(r.rows[0]!.item_detail_new?.[0]?.model_id, 990001);
});

test("订单列表变了（一行没有订单号）：说是哪个接口、哪一格", () => {
	const raw = sample("list-order") as { items: Record<string, unknown>[] };
	delete raw.items[1]!.sn;
	assert.throws(() => ordersOf(raw), /chanboss \/order\/list_order 的回包变了：items\[1\]\.sn 没有了/);
});

test("别的列表：条数、页数收成数字，行原样回；没有 items 是空的", () => {
	assert.deepEqual(pageOf(sample("list-stock"), "/stock/list_stock"), { total: 1, pageCount: 1, rows: [{ sku: "A-1", stock_num: 3, shop_key: "" }] });
	assert.deepEqual(pageOf(null, "/stock/list_stock"), { total: 0, pageCount: 1, rows: [] });
});

test("账号：user_id 是各个列表要带的 seller_id", () => {
	assert.deepEqual(identityOf(sample("sso-check")), { userId: 30001, account: "x2-test", accountType: "seller" });
	assert.throws(() => identityOf({ account: "x" }), /chanboss \/sso\/check 的回包变了：user_id 没有了/);
});
