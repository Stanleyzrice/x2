// 店铺分类回包解析与请求合约：完整成员、草稿转换和排序字段不混入平台商品类目。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createShopCategoryBody, shopCategoriesOf, shopCategoryDraftsOf, shopCategoryOf, sortShopCategoriesBody } from "./shop-categories.ts";

const sample = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/shop-category-${name}.json`, import.meta.url), "utf8"));

test("店铺分类真回包：有效商品数为零时仍保留完整的异常商品成员", () => {
	const list = shopCategoriesOf(sample("list"));
	assert.equal(list[0]!.id, "12345");
	assert.equal(list[0]!.productCount, 0);
	assert.equal(list[0]!.productIds, undefined);
	const detail = shopCategoryOf(sample("detail"), "12345");
	assert.equal(detail.productCount, 0);
	assert.deepEqual(detail.productIds, ["25000000001", "25000000002"]);
	assert.deepEqual(shopCategoryDraftsOf(sample("drafts")), []);
});

test("详情缺成员字段、错分类或重复成员时不能当作空分类核对成功", () => {
	const raw = sample("detail") as { data: { list: { id: number; product_id_list?: number[] }[] } };
	assert.throws(() => shopCategoryOf(raw, "99999"), /匹配/);
	raw.data.list[0]!.product_id_list = [25000000001, 25000000001];
	assert.throws(() => shopCategoryOf(raw, "12345"), /重复商品/);
	delete raw.data.list[0]!.product_id_list;
	assert.throws(() => shopCategoryOf(raw, "12345"), /回包变了.*product_id_list/);
});

test("创建按当前UI由草稿转换：只交显式草稿、名称与商品，不改商品的平台类目", () => {
	assert.deepEqual(createShopCategoryBody({ name: "地墊腳墊", draftId: "6789", productIds: ["25000000001", "25000000002"] }), {
		independent_shop_category: { name: "地墊腳墊", collection_type: "customized", to_delete_draft_id: 6789, product_id_list: [25000000001, 25000000002] },
	});
	assert.throws(() => createShopCategoryBody({ name: "地墊腳墊", draftId: "6789", productIds: ["25000000001", "25000000001"] }), /不能重复/);
	assert.throws(() => createShopCategoryBody({ name: "地墊腳墊", draftId: "6789", productIds: ["9007199254740993"] }), /不丢精度/);
});

test("分类顺序按UI用倒序权重，完整id列表禁止重复", () => {
	assert.deepEqual(sortShopCategoriesBody({ ids: ["3", "1", "2"] }), {
		collection_list: [
			{ id: 3, sort_weight: 3 },
			{ id: 1, sort_weight: 2 },
			{ id: 2, sort_weight: 1 },
		],
	});
	assert.throws(() => sortShopCategoriesBody({ ids: ["3", "3"] }), /不能重复/);
});
