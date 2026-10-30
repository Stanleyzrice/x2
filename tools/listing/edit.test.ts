// 已上架商品改标题：只交 name，提交前挡住旧标题变化，回读不明确时不重发。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelId } from "../../connectors/sites/shopee/seller.ts";
import { priceModels, pricesState, sameModels, titleChange, titleState } from "./edit.ts";

test("改标题只生成 name；已经是目标标题时不再提交", () => {
	assert.deepEqual(titleChange("新新好物｜KT地墊", "新新好物｜KT地墊", "【滿199出貨】新新好物｜KT地墊"), {
		info: { name: "【滿199出貨】新新好物｜KT地墊" },
	});
	assert.deepEqual(titleChange("【滿199出貨】KT地墊", "KT地墊", "【滿199出貨】KT地墊"), { skip: "已经是目标标题，不再提交" });
});

test("原标题已变或未知时不覆盖；读回仍是旧标题时保留未知", () => {
	assert.deepEqual(titleChange("人刚改的标题", "旧标题", "新标题"), { skip: "原标题已变或未知：重新现读并确认，不覆盖" });
	assert.deepEqual(titleChange(null, "旧标题", "新标题"), { skip: "原标题已变或未知：重新现读并确认，不覆盖" });
	assert.equal(titleState("新标题", "新标题"), true);
	assert.equal(titleState("旧标题", "新标题"), null);
	assert.equal(titleState(undefined, "新标题"), null);
});

test("改价按 model id 对齐，保留全部规格、tier_index 和未改价格，不交库存等字段", () => {
	const a = ModelId.parse("1"),
		b = ModelId.parse("2");
	const now = {
		model_list: [
			{ id: a, tier_index: [1, 0], price_info: { normal_price: "90.00" }, stock_detail: { total_seller_stock: 4 } },
			{ id: b, tier_index: [0, 1], price_info: { normal_price: "99.00" } },
		],
	};
	const models = priceModels(now, [{ modelId: a, from: 90, to: 59 }]);
	assert.deepEqual(models, [
		{ id: a, tier_index: [1, 0], price: "59" },
		{ id: b, tier_index: [0, 1], price: "99" },
	]);
	assert.equal(
		sameModels(
			models,
			models.toReversed().map((m) => ({ price: m.price, id: m.id, tier_index: m.tier_index })),
		),
		true,
	);
	assert.equal(
		sameModels(
			models,
			models.map((m) => ({ ...m, price: "90" })),
		),
		false,
	);
	assert.equal(pricesState(now, models), null);
	assert.equal(pricesState({ model_list: [{ ...now.model_list[0], price_info: { normal_price: "59" } }, now.model_list[1]!] }, models), true);
	assert.throws(() => priceModels(now, [{ modelId: a, from: 80, to: 59 }]), /原价已变/);
	assert.throws(
		() =>
			priceModels(now, [
				{ modelId: a, from: 90, to: 59 },
				{ modelId: a, from: 90, to: 59 },
			]),
		/重复/,
	);
	assert.throws(() => priceModels({ model_list: [{ id: a, tier_index: [0], price_info: {} }] }, [{ modelId: a, from: 90, to: 59 }]), /未知/);
	assert.throws(() => priceModels(now, [{ modelId: ModelId.parse("3"), from: 90, to: 59 }]), /不存在/);
	assert.equal(pricesState({ model_list: [] }, models), null);
});
