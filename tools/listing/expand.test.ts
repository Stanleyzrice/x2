// 规格展开：单默认模型转一至两层，按来源规格保留旧模型，校验稀疏组合、图片、指纹及幂等。
import assert from "node:assert/strict";
import { test } from "node:test";
import { SpecId } from "../../connectors/sites/1688/api.ts";
import type { ProductInfo } from "../../connectors/sites/shopee/products.ts";
import { ModelId } from "../../connectors/sites/shopee/seller.ts";
import { expandProductInfo } from "../../connectors/sites/shopee/variants.ts";
import { buildExpand, expandAlready, expandedMerchantSku, expandHash, expandParams, expandState } from "./expand.ts";

const originalId = ModelId.parse("345");
function fixture(): ProductInfo {
	return {
		name: "兩件起購髮夾",
		parent_sku: "LT123",
		status: 1,
		is_unlisted: false,
		category_path: [100147],
		images: ["cover"],
		description_info: { description: "舊描述與圖片", description_type: "normal" },
		weight: { value: "0.3", unit: 1 },
		min_purchase_limit: 2,
		std_tier_variation_list: [{ custom_value: "", value_list: [{ custom_value: "", id: 0 }], id: 0, group_id: "0" }],
		model_list: [
			{
				id: originalId,
				name: "",
				sku: "LT123-red",
				sku_image: "",
				is_default: true,
				tier_index: [0],
				price_info: { normal_price: "119.00" },
				stock_detail: { total_seller_stock: 50 },
			},
		],
	};
}
function input() {
	return expandParams.parse({
		shop: "cheeroutdoor",
		id: "987",
		offerId: "123",
		tiers: [
			{
				name: "顏色",
				options: [
					{ name: "紅", imageId: "red-img" },
					{ name: "藍", imageId: "blue-img" },
				],
			},
			{ name: "尺寸", options: [{ name: "小" }, { name: "大" }] },
		],
		models: [
			{ skuId: "100", specId: "red", tierIndex: [0, 0], costRmb: 1.2, weightKg: 0.3, price: 119, stock: 50, imageId: "red-img", existingModelId: originalId },
			{ skuId: "101", specId: "blue", tierIndex: [1, 1], costRmb: 1.4, weightKg: 0.3, price: 129, stock: 40, imageId: "blue-img" },
		],
	});
}
function readback() {
	const before = fixture(),
		p = input(),
		built = buildExpand(before, p);
	const now: ProductInfo = {
		...structuredClone(before),
		std_tier_variation_list: built.info.std_tier_variation_list,
		model_list: p.models.map((m, i) => ({
			id: m.existingModelId ?? ModelId.parse(String(1000 + i)),
			sku: expandedMerchantSku(p.offerId, m.specId, m.skuId),
			name: m.tierIndex.map((x, a) => p.tiers[a]!.options[x]!.name).join(","),
			tier_index: m.tierIndex,
			sku_image: m.imageId,
			price_info: { normal_price: String(m.price) },
			stock_detail: { total_seller_stock: m.stock },
		})),
	};
	return { before, p, built, now };
}

test("一层规格图只挂第一层选项，model sku_image 为空以满足站点验证", () => {
	const p = input();
	assert.equal(expandParams.parse({ ...p, targetWeightKg: "0.3" }).targetWeightKg, 0.3);
	p.tiers = p.tiers.slice(0, 1);
	p.models = p.models.map((m) => ({ ...m, tierIndex: [m.tierIndex[0]!] }));
	const built = buildExpand(fixture(), p);
	assert.ok(built.info.model_list.every((m) => m.sku_image === ""));
	assert.deepEqual(
		built.info.std_tier_variation_list[0]!.value_list.map((o) => o.image_id),
		["red-img", "blue-img"],
	);
});

test("native属性数组返回顺序不改变指纹，属性值改变仍改变指纹", () => {
	const a = fixture();
	a.attributes = [
		{ attribute_id: 2, attribute_values: [{ value_id: 22 }, { value_id: 21 }] },
		{ attribute_id: 1, attribute_values: [{ value_id: 11 }] },
	];
	const b = structuredClone(a);
	b.attributes!.reverse();
	b.attributes![1]!.attribute_values.reverse();
	assert.equal(expandHash(a), expandHash(b));
	b.attributes![0]!.attribute_values[0]!.value_id = 12;
	assert.notEqual(expandHash(a), expandHash(b));
});
test("单默认模型展开稀疏两层：保留原id和价格，不发送旧库存/货号；新SKU按specId生成并绑定图片", () => {
	const p = input(),
		built = buildExpand(fixture(), p),
		payload = expandProductInfo(built.info);
	assert.equal(payload.model_list.length, 2);
	assert.deepEqual(Object.keys(payload).sort(), ["model_list", "std_tier_variation_list"]);
	assert.deepEqual(payload.model_list[0], { id: 345, tier_index: [0, 0], price: "119", sku_image: "red-img" });
	const added = payload.model_list[1]!;
	assert.deepEqual(added, {
		id: 0,
		tier_index: [1, 1],
		price: "129",
		sku: "LT123-blue",
		stock_setting_list: [{ sellable_stock: 40 }],
		is_default: false,
		confirm_empty_gtin: false,
		gtin_code: "",
		sku_image: "blue-img",
	});
	assert.equal(payload.std_tier_variation_list[0]!.value_list[1]!.image_id, "blue-img");
	assert.equal(built.mapping[1]!.skuId, "101");
	assert.equal(built.mapping[1]!.costRmb, 1.4);
});
test("指纹忽略订单库存和对象键/模型顺序，但覆盖原价、原SKU、图片、描述、起购和重量", () => {
	const before = fixture(),
		base = expandHash(before),
		stock = structuredClone(before);
	stock.model_list![0]!.stock_detail!.total_seller_stock = 49;
	assert.equal(expandHash(stock), base);
	for (const mutate of [
		(n: ProductInfo) => {
			n.model_list![0]!.price_info!.normal_price = "120";
		},
		(n: ProductInfo) => {
			n.model_list![0]!.sku = "wrong";
		},
		(n: ProductInfo) => {
			n.images = ["changed"];
		},
		(n: ProductInfo) => {
			n.description_info = { description: "人工新改", description_type: "normal" };
		},
		(n: ProductInfo) => {
			n.min_purchase_limit = 1;
		},
		(n: ProductInfo) => {
			n.weight = { value: "0.5" };
		},
	]) {
		const changed = structuredClone(before);
		mutate(changed);
		assert.notEqual(expandHash(changed), base);
	}
});
test("错误来源、漏旧模型、旧价格改变、重复/越界/未用选项、超过重量与merchantSKU碰撞均拦住", () => {
	const before = fixture(),
		p = input();
	assert.throws(() => buildExpand(before, { ...p, offerId: expandParams.shape.offerId.parse("999") }), /offerId/);
	assert.throws(() => buildExpand(before, { ...p, models: p.models.map((m) => ({ ...m, existingModelId: undefined })) }), /全部原modelId/);
	assert.throws(() => buildExpand(before, { ...p, models: [{ ...p.models[0]!, price: 120 }, p.models[1]!] }), /不改旧规格价格/);
	assert.throws(() => buildExpand(before, { ...p, models: [p.models[0]!, { ...p.models[1]!, tierIndex: [0, 0] }] }), /重复/);
	assert.throws(() => buildExpand(before, { ...p, models: [p.models[0]!, { ...p.models[1]!, tierIndex: [2, 1] }] }), /越界/);
	assert.throws(() => buildExpand(before, { ...p, models: [p.models[0]!] }), /没有对应/);
	assert.throws(() => buildExpand(before, { ...p, models: [p.models[0]!, { ...p.models[1]!, weightKg: 0.5 }] }), /商品级重量/);
	assert.throws(
		() =>
			buildExpand(before, {
				...p,
				models: [
					{ ...p.models[0]!, specId: SpecId.parse("x".repeat(50)) },
					{ ...p.models[1]!, specId: SpecId.parse(`${"x".repeat(49)}z`) },
				],
			}),
		/merchantSKU重复/,
	);
	assert.throws(() => buildExpand(before, { ...p, models: [p.models[0]!, { ...p.models[1]!, price: 600 }] }), /5倍/);
	assert.equal(expandParams.safeParse({ ...p, models: Array(101).fill(p.models[0]) }).success, false);
	assert.equal(expandParams.safeParse({ ...p, models: [{ ...p.models[0]!, imageId: "https://example.com/image" }] }).success, false);
});
test("显式较高商品重量才写weight，原库存仍不提交；全部SKU需由调用者按同一重量核价", () => {
	const p = input();
	p.models[1]!.weightKg = 0.5;
	p.targetWeightKg = 0.5;
	const built = buildExpand(fixture(), p);
	assert.deepEqual(built.info.weight, { value: "0.5", unit: 1 });
	assert.equal("stock_setting_list" in built.info.model_list[0]!, false);
});

test("P002同型的一层八款可保留原模型在非零选项，追加其余七款", () => {
	const p = expandParams.parse({
		shop: "cheeroutdoor",
		id: "987",
		offerId: "123",
		tiers: [{ name: "款式", options: Array.from({ length: 8 }, (_, i) => ({ name: `款${i}`, imageId: `pic-${i}` })) }],
		models: Array.from({ length: 8 }, (_, i) => ({
			skuId: String(100 + i),
			specId: i === 3 ? "red" : `new-${i}`,
			tierIndex: [i],
			costRmb: 1.2,
			weightKg: 0.3,
			price: 119,
			stock: 50,
			imageId: `pic-${i}`,
			...(i === 3 ? { existingModelId: originalId } : {}),
		})),
	});
	const built = buildExpand(fixture(), p);
	assert.equal(built.info.model_list.length, 8);
	assert.equal(built.info.model_list.filter((m) => m.id === 0).length, 7);
	assert.deepEqual(built.info.model_list[3], { id: originalId, tier_index: [3], price: "119", sku_image: "" });
});
test("完整回读后幂等跳过；错价/错图/旧id替换/多漏模型/其他字段变化保持未知", () => {
	const { p, built, now } = readback();
	assert.equal(expandState(now, built.baseline, p), true);
	assert.equal(expandAlready(now, p), true);
	const order = structuredClone(now);
	order.model_list![0]!.stock_detail!.total_seller_stock = 48;
	order.model_list![1]!.stock_detail!.total_seller_stock = 39;
	assert.equal(expandAlready(order, p), true);
	assert.equal(expandState(order, built.baseline, p), null);
	for (const mutate of [
		(n: ProductInfo) => {
			n.model_list![0]!.id = ModelId.parse("9999");
		},
		(n: ProductInfo) => {
			n.model_list![1]!.price_info!.normal_price = "130";
		},
		(n: ProductInfo) => {
			n.model_list![1]!.sku_image = "wrong";
		},
		(n: ProductInfo) => {
			n.model_list!.pop();
		},
		(n: ProductInfo) => {
			n.images = ["wrong"];
		},
		(n: ProductInfo) => {
			n.min_purchase_limit = 1;
		},
	]) {
		const broken = structuredClone(now);
		mutate(broken);
		assert.equal(expandState(broken, built.baseline, p), null);
	}
});
