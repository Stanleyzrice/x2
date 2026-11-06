// 分类写入只核对完整身份、成员与顺序，不把相同数量当作相同商品。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ShopCategory } from "../../connectors/sites/shopee/shop-categories.ts";
import { checkIdentity } from "./facts.ts";
import {
	assertCategoryCanHide,
	assertCategoryOrder,
	assertSameCategoryMembers,
	categoryOrder,
	checkExistingCategory,
	sameMembers,
	shopCategoryCreateInput,
	shopCategorySortInput,
} from "./shop-categories.ts";

const category = (overrides: Partial<ShopCategory> = {}): ShopCategory => ({
	id: "1",
	name: "地墊腳墊",
	status: "active",
	sortWeight: 2,
	type: "customized",
	productCount: 2,
	productIds: ["11", "12"],
	...overrides,
});

test("店铺身份不同不能准备分类写入", () => {
	assert.throws(() => checkIdentity({ shop: "cheeroutdoor", shopId: "1554182542" }, { username: "other", shopId: "1" }), /店铺身份不匹配/);
});
test("成员核对要求完整且唯一的ID集合，数量相同但商品不同也不通过", () => {
	assert.equal(sameMembers(["12", "11"], ["11", "12"]), true);
	assert.equal(sameMembers(["11", "13"], ["11", "12"]), false);
	assert.equal(sameMembers(["11", "11"], ["11", "12"]), false);
	assert.equal(sameMembers(undefined, ["11", "12"]), false);
	assert.throws(() => assertSameCategoryMembers(category({ productIds: ["11", "13"] }), ["11", "12"]), /已有不同商品/);
});
test("同名多个分类与隐藏仍有有效商品的分类都拒绝", () => {
	assert.throws(() => checkExistingCategory([category(), category({ id: "2" })], "地墊腳墊"), /不唯一/);
	assert.throws(() => assertCategoryCanHide(category()), /仍有 2 个有效商品/);
	assert.doesNotThrow(() => assertCategoryCanHide(category({ productCount: 0, productIds: ["99"] })));
});
test("排序必须包含全部当前分类；按sortWeight从高到低读回", () => {
	const categories = [category({ id: "2", sortWeight: 1 }), category({ id: "1", sortWeight: 2 })];
	assert.deepEqual(categoryOrder(categories), ["1", "2"]);
	assert.doesNotThrow(() => assertCategoryOrder(categories, ["2", "1"]));
	assert.throws(() => assertCategoryOrder(categories, ["1"]), /分类已增删/);
});
test("CLI成员与排序参数拒绝重复ID，创建绑定草稿id", () => {
	const base = { shop: "cheeroutdoor", name: "地墊腳墊", requestId: "4d531ddc-7f42-45ad-95b2-bcf633445fa2", draftId: "3" };
	assert.deepEqual(shopCategoryCreateInput.parse({ ...base, productIds: "11,12" }).productIds, ["11", "12"]);
	assert.equal(shopCategoryCreateInput.safeParse({ ...base, productIds: "11,11" }).success, false);
	assert.equal(shopCategorySortInput.safeParse({ shop: base.shop, requestId: base.requestId, ids: "1,1" }).success, false);
});
