// 追加尺寸的纯校验：保护旧规格与库存，核对新规格映射，并阻止重复或并发覆盖。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductInfo } from "../../connectors/sites/shopee/products.ts";
import { ModelId } from "../../connectors/sites/shopee/seller.ts";
import { addSizeHash, addSizeParams, addSizeState, buildAddSize } from "./add-size.ts";

function fixture(): ProductInfo {
	return {
		name: "兩種尺寸地墊",
		parent_sku: "MAT",
		status: 1,
		is_unlisted: false,
		category_path: [1, 2],
		images: ["cover"],
		description_info: { description: "舊描述", description_type: "normal" },
		std_tier_variation_list: [
			{
				custom_value: "款式",
				id: 0,
				group_id: "0",
				value_list: [
					{ custom_value: "小新", image_id: "shin", id: 0 },
					{ custom_value: "小白", image_id: "dog", id: 0 },
				],
			},
			{
				custom_value: "尺寸",
				id: 0,
				group_id: "0",
				value_list: [
					{ custom_value: "40×60cm", id: 0 },
					{ custom_value: "50×80cm", id: 0 },
				],
			},
		],
		model_list: [0, 1, 2, 3].map((i) => ({
			id: ModelId.parse(String(i + 10)),
			name: `${i < 2 ? "小新" : "小白"},${i % 2 ? "50×80cm" : "40×60cm"}`,
			sku: `old-${i}`,
			tier_index: [Math.floor(i / 2), i % 2],
			price_info: { input_normal_price: i % 2 ? "99.00" : "69.00" },
			stock_detail: { total_seller_stock: 50 },
		})),
	};
}
function input() {
	return addSizeParams.parse({
		shop: "ni1206",
		id: "123",
		title: "三種尺寸地墊",
		descriptionInfo: { description: "新描述", description_type: "normal" },
		size: "80×120cm",
		models: [
			{ firstTierIndex: 1, sku: "new-1", price: 199, stock: 50 },
			{ firstTierIndex: 0, sku: "new-0", price: 199, stock: 50 },
		],
	});
}
function readback() {
	const before = fixture(),
		p = input(),
		built = buildAddSize(before, p);
	const now: ProductInfo = {
		...structuredClone(before),
		name: p.title,
		description_info: built.info.description_info,
		std_tier_variation_list: built.info.std_tier_variation_list,
		model_list: [
			...structuredClone(before.model_list!),
			...p.models.map((m) => ({
				id: ModelId.parse(String(100 + m.firstTierIndex)),
				sku: m.sku,
				name: `${m.firstTierIndex ? "小白" : "小新"},${p.size}`,
				tier_index: [m.firstTierIndex, 2],
				price_info: { normal_price: "199.00" },
				stock_detail: { total_seller_stock: 50 },
				sku_image: m.firstTierIndex ? "dog" : "shin",
			})),
		],
	};
	return { before, p, built, now };
}

test("追加尺寸保留所有原规格 id/索引/原价，新增逐款绑定图片，不交旧库存", () => {
	const before = fixture(),
		p = input(),
		{ info } = buildAddSize(before, p);
	assert.equal(info.model_list.length, 6);
	assert.deepEqual(info.std_tier_variation_list[0], before.std_tier_variation_list![0]);
	assert.equal(info.std_tier_variation_list[1]!.value_list[2]!.custom_value, "80×120cm");
	assert.deepEqual(
		info.model_list.slice(0, 4),
		[0, 1, 2, 3].map((i) => ({ id: String(i + 10), tier_index: [Math.floor(i / 2), i % 2], price: i % 2 ? "99" : "69" })),
	);
	assert.deepEqual(Object.keys(info.model_list[0]!).sort(), ["id", "price", "tier_index"]);
	const added = info.model_list[4]!;
	assert.equal(added.id, 0);
	assert.ok("sku" in added);
	if ("sku" in added) {
		assert.equal(added.sku, "new-1");
		assert.deepEqual(added.tier_index, [1, 2]);
		assert.equal(added.sku_image, "dog");
		assert.deepEqual(added.stock_setting_list, [{ sellable_stock: 50 }]);
	}
});

test("快照与原规格回包顺序和库存无关，但原价、描述和在售状态变化会改变快照", () => {
	const before = fixture(),
		equivalent = structuredClone(before);
	equivalent.model_list!.reverse();
	equivalent.model_list![0]!.stock_detail!.total_seller_stock = 49;
	assert.equal(addSizeHash(before), addSizeHash(equivalent));
	equivalent.model_list![0]!.price_info!.input_normal_price = "100";
	assert.notEqual(addSizeHash(before), addSizeHash(equivalent));
	const descriptionChanged = { ...before, description_info: { description: "人改的描述", description_type: "normal" } };
	assert.notEqual(addSizeHash(before), addSizeHash(descriptionChanged));
	assert.notEqual(addSizeHash(before), addSizeHash({ ...before, status: 8 }));
});

test("重复尺寸、重复货号、错配款式以及原规格缺漏均阻止生成写入", () => {
	const before = fixture(),
		p = input();
	assert.throws(() => buildAddSize(before, { ...p, size: "40×60cm" }), /已经存在/);
	assert.throws(() => buildAddSize(before, { ...p, models: [{ ...p.models[0]!, sku: "old-0" }, p.models[1]!] }), /货号/);
	assert.throws(() => buildAddSize(before, { ...p, models: [p.models[0]!, { ...p.models[1]!, firstTierIndex: 1 }] }), /一级款式/);
	assert.throws(() => buildAddSize(before, { ...p, models: [p.models[0]!] }), /一级款式/);
	assert.throws(() => buildAddSize({ ...before, model_list: before.model_list!.slice(0, 3) }, p), /不完整/);
	const wrongIndex = structuredClone(before);
	wrongIndex.model_list![0]!.tier_index = [0, 1];
	assert.throws(() => buildAddSize(wrongIndex, p), /索引/);
	assert.equal(addSizeParams.safeParse({ ...p, models: [{ ...p.models[0]!, price: Number.NaN }] }).success, false);
});

test("回读核对全部新旧规格；错价、错图、旧货号被改及商品下架都保持未知", () => {
	const { p, built, now } = readback();
	assert.equal(addSizeState(now, built.baseline, p, built.info), true);
	const withOrder = structuredClone(now);
	withOrder.model_list![0]!.stock_detail!.total_seller_stock = 48;
	assert.equal(addSizeState(withOrder, built.baseline, p, built.info), true);
	for (const mutate of [
		(n: ProductInfo) => {
			n.model_list![0]!.price_info!.input_normal_price = "70";
		},
		(n: ProductInfo) => {
			n.model_list![4]!.sku_image = "wrong";
		},
		(n: ProductInfo) => {
			n.model_list![0]!.sku = "wrong";
		},
		(n: ProductInfo) => {
			n.status = 8;
		},
		(n: ProductInfo) => {
			n.model_list!.pop();
		},
		(n: ProductInfo) => {
			n.category_path = [3];
		},
	]) {
		const broken = structuredClone(now);
		mutate(broken);
		assert.equal(addSizeState(broken, built.baseline, p, built.info), null);
	}
});
