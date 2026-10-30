// 零销量下架：只收人给的商品、已知的双零销量；未知不当零，回读没变化不当失败重发。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ItemId } from "../../connectors/sites/shopee/seller.ts";
import { eligibleUnlists, firstUnlistBlock, unlistState } from "./unlist.ts";

const id = (s: string) => ItemId.parse(s);
const product = (s: string) => ({ productId: id(s), parentSku: `SKU${s}`, name: `商品${s}` });

test("零销量下架：只收给定的在售商品，确认与付款件数都必须明确为零；重复编号只做一遍", () => {
	const r = eligibleUnlists([id("1"), id("2"), id("3"), id("4"), id("5"), id("1")], ["1", "2", "3", "4", "6"].map(product), [
		{ id: id("1"), confirmed_units: 0, paid_units: 0 },
		{ id: id("2"), confirmed_units: null, paid_units: 0 },
		{ id: id("4"), confirmed_units: 0, paid_units: 1 },
		{ id: id("5"), confirmed_units: 0, paid_units: 0 },
		{ id: id("6"), confirmed_units: 0, paid_units: 0 },
	]);
	assert.deepEqual(r.ready, [product("1")]);
	assert.deepEqual(
		r.skipped.map((x) => x.productId),
		["2", "3", "4", "5"],
	);
	assert.match(r.skipped[0]!.why, /未知/);
	assert.match(r.skipped[1]!.why, /未返回/);
	assert.match(r.skipped[2]!.why, /销量/);
	assert.match(r.skipped[3]!.why, /在售列表/);
});

test("下架回读：明确下架才算做成，仍在售、状态缺失都只算未知，不据此重发", () => {
	assert.equal(unlistState({ status: 8, is_unlisted: true }), true);
	assert.equal(unlistState({ status: "8" }), true);
	assert.equal(unlistState({ status: 1, is_unlisted: false }), null);
	assert.equal(unlistState({ status: 3 }), null);
	assert.equal(unlistState({}), null);
});

test("首次下架：没有核对成功的试跑记录时只允许一件，核对过才允许批量", () => {
	assert.equal(firstUnlistBlock(1, false), null);
	assert.match(firstUnlistBlock(2, false)!, /一个商品/);
	assert.equal(firstUnlistBlock(244, true), null);
});
