// 单稿类目例外：显式理由只放行指定叶子，不改变店铺范围或已建商品限制。
import assert from "node:assert/strict";
import { test } from "node:test";
import { categoryAllowed } from "./category.ts";
import { categoryBlock } from "./edits.ts";
import { listing } from "./index.ts";

test("类目例外只匹配记录的叶子，空理由和其他类别都不能放行", () => {
	const allowed = new Set(["101160"]);
	assert.equal(categoryAllowed("101837", allowed), false);
	assert.equal(categoryAllowed("101837", allowed, { categoryId: "101837", reason: "用户明确指定本款上架" }), true);
	assert.equal(categoryAllowed("101838", allowed, { categoryId: "101837", reason: "用户明确指定本款上架" }), false);
	assert.equal(categoryAllowed("101837", allowed, { categoryId: "101837", reason: "   " }), false);
	assert.equal(categoryAllowed("101160", allowed), true);
	assert.equal(categoryAllowed("101837", null), true);
	const draft = { shop: "cheeroutdoor", product_id: null, listed_at: null };
	const exception = { categoryId: "101837", reason: "用户明确指定本款上架" };
	assert.equal(categoryBlock("野餐墊", draft, "101837", "野餐相關", allowed, exception), null);
	assert.match(categoryBlock("野餐墊", { ...draft, product_id: "123" }, "101837", "野餐相關", allowed, exception)!, /已经建了商品/);
});

test("category工具显式例外必须带理由；原有调用格式仍可用", () => {
	const p = listing.tools.category!.params;
	assert.equal(p.safeParse({ id: "166", category: "101837" }).success, true);
	assert.equal(p.safeParse({ id: "166", category: "101837", allowOutsideShop: true }).success, false);
	assert.equal(p.safeParse({ id: "166", category: "101837", allowOutsideShop: true, reason: " " }).success, false);
	assert.equal(p.safeParse({ id: "166", category: "101837", allowOutsideShop: true, reason: "用户明确要求本款上架" }).success, true);
});
