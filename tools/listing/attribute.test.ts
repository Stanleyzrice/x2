import assert from "node:assert/strict";
import { test } from "node:test";
import type { Attribute } from "../../connectors/sites/shopee/products.ts";
import { replaceDraftAttribute } from "./attribute.ts";

const tree: Attribute[] = [
	{ id: "1", name: "商品種類", mandatory: true, maxValues: 1, values: [{ valueId: "11", name: "一般商品" }] },
	{
		id: "2",
		name: "季節裝飾",
		mandatory: true,
		maxValues: 1,
		values: [
			{ valueId: "21", name: "否" },
			{ valueId: "22", name: "是" },
		],
	},
];
const original = [
	{ attribute_id: 1, attribute_values: [{ value_id: 11 }] },
	{ attribute_id: 2, attribute_values: [{ value_id: 21 }] },
];

test("以站点可选值替换指定草稿属性，保留另一项必填值", () => {
	assert.deepEqual(replaceDraftAttribute(tree, original, "季節裝飾", "是"), {
		attributes: [original[0], { attribute_id: 2, attribute_values: [{ value_id: 22 }] }],
		text: "商品種類：一般商品\n季節裝飾：是",
	});
	assert.equal(original[1]!.attribute_values[0]!.value_id, 21);
});

test("未知选项或缺少其他必填属性时拒绝变更", () => {
	assert.throws(() => replaceDraftAttribute(tree, original, "季節裝飾", "未知"), /没有唯一对应可选值/);
	assert.throws(() => replaceDraftAttribute(tree, [original[1]!], "季節裝飾", "是"), /商品種類/);
});
