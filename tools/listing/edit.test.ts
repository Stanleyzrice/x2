// 已上架商品改标题：只交 name，提交前挡住旧标题变化，回读不明确时不重发。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { editProductInfo } from "../../connectors/sites/shopee/publish.ts";
import { ModelId } from "../../connectors/sites/shopee/seller.ts";
import {
	categoryChange,
	categoryState,
	descriptionChange,
	descriptionState,
	editKey,
	editParams,
	imagesChange,
	imagesState,
	priceModels,
	pricesState,
	sameModels,
	sizeChartChange,
	sizeChartState,
	titleChange,
	titleState,
} from "./edit.ts";

test("Size Chart 参数须成对提供，原图可为空，新图必须是非空 Shopee 图片 id", () => {
	const base = { shop: "cheeroutdoor", id: "123", beforeTitle: "泳裝", title: "泳裝" };
	const before = { size_chart: "", size_chart_id: 0 };
	const after = { ...before, size_chart: "tw-size-chart" };
	assert.deepEqual(editParams.parse({ ...base, beforeSizeChartInfo: before, sizeChartInfo: after }), {
		...base,
		prices: [],
		beforeSizeChartInfo: before,
		sizeChartInfo: after,
	});
	assert.equal(editParams.safeParse({ ...base, beforeSizeChartInfo: before }).success, false);
	assert.equal(editParams.safeParse({ ...base, sizeChartInfo: after }).success, false);
	assert.equal(editParams.safeParse({ ...base, beforeSizeChartInfo: before, sizeChartInfo: before }).success, false);
	assert.equal(editParams.safeParse({ ...base, beforeSizeChartInfo: before, sizeChartInfo: { size_chart: "https://example.com/chart" } }).success, false);
});

test("Size Chart 提交前核对完整原对象，读回核对完整目标对象；已达目标时幂等", () => {
	const before = { size_chart: "", size_chart_id: 0 };
	const after = { ...before, size_chart: "tw-size-chart" };
	assert.deepEqual(sizeChartChange({ size_chart_info: before }, before, after), { size_chart_info: after });
	assert.deepEqual(sizeChartChange({ size_chart_info: after }, before, after), { size_chart_info: after });
	assert.throws(() => sizeChartChange({ size_chart_info: { ...before, size_chart: "human-changed" } }, before, after), /原Size Chart已变/);
	assert.throws(() => sizeChartChange({ size_chart_info: { ...before, size_chart_id: 1 } }, before, after), /原Size Chart已变/);
	assert.throws(() => sizeChartChange({}, before, after), /原Size Chart已变/);
	assert.equal(
		sizeChartState({ size_chart_info: { size_chart_id: 0, size_chart: "https://down-tw.img.susercontent.com/file/tw-size-chart?origin=site" } }, after),
		true,
	);
	assert.equal(sizeChartState({ size_chart_info: before }, after), null);
	assert.equal(sizeChartState({ size_chart_info: { ...after, size_chart_id: 1 } }, after), null);
	assert.equal(sizeChartState({ size_chart_info: { ...after, extra: "unconfirmed" } }, after), null);
	assert.equal(sizeChartState({}, after), null);
	assert.equal(sizeChartState({}, undefined), true);
	assert.deepEqual(sizeChartChange({}, undefined, undefined), {});
	const base = { ...editParams.parse({ shop: "cheeroutdoor", id: "123", beforeTitle: "泳裝", title: "泳裝" }), shopId: "456" };
	assert.notEqual(editKey(base), editKey({ ...base, beforeSizeChartInfo: before, sizeChartInfo: after }));
	assert.notEqual(
		editKey({ ...base, beforeSizeChartInfo: before, sizeChartInfo: after }),
		editKey({ ...base, beforeSizeChartInfo: before, sizeChartInfo: { ...after, size_chart: "other-chart" } }),
	);
	assert.equal(
		editKey({ ...base, beforeSizeChartInfo: before, sizeChartInfo: after }),
		editKey({ ...base, beforeSizeChartInfo: { size_chart_id: 0, size_chart: "" }, sizeChartInfo: { size_chart_id: 0, size_chart: after.size_chart } }),
	);
});

test("改描述核对完整description_info，保留未改field_list和图片；不提供时不发送", () => {
	const before = {
		description_type: "json" as const,
		description: JSON.stringify({
			field_list: [
				{ type: 0, value: "滑板圖案款" },
				{ type: 1, value: "detail-image" },
			],
		}),
	};
	const after = { ...before, description: before.description.replace("滑板圖案款", "卡通刺繡圖案款") };
	assert.deepEqual(descriptionChange({ description_info: before }, before, after), { description_info: after });
	assert.throws(() => descriptionChange({ description_info: { ...before, description: "人工新改的描述" } }, before, after), /原描述已变/);
	assert.throws(() => descriptionChange({}, before, after), /原描述已变/);
	assert.equal(descriptionState({ description_info: { description: after.description, description_type: "json" } }, after), true);
	assert.equal(descriptionState({ description_info: { ...after, description: after.description.replace("detail-image", "wrong-image") } }, after), null);
	assert.equal(descriptionState({ description_info: { ...after, extra: "站点新增的字段" } }, after), null);
	assert.deepEqual(descriptionChange({ description_info: after }, before, after), { description_info: after });
	assert.deepEqual(editProductInfo({ title: "中性标题", descriptionInfo: after }), { name: "中性标题", description_info: after });
	assert.deepEqual(editProductInfo({ title: "原标题" }), { name: "原标题" });
	const base = { shop: "cheeroutdoor", id: "123", beforeTitle: "滑板圖案", title: "卡通圖案" };
	assert.equal(editParams.safeParse({ ...base, beforeDescriptionInfo: before, descriptionInfo: after }).success, true);
	assert.equal(editParams.safeParse({ ...base, descriptionInfo: after }).success, false);
	assert.equal(editParams.safeParse({ ...base, beforeDescriptionInfo: before }).success, false);
	const old = { ...editParams.parse(base), shopId: "456" };
	assert.notEqual(editKey({ ...old, beforeDescriptionInfo: before, descriptionInfo: after }), editKey(old));
});

test("详情图读回会省略图片宽高，只豁免缺失的尺寸；文字、图片顺序及其他字段仍须一致", () => {
	const fields = [
		{ type: 0, value: "原始商品介紹" },
		{ type: 1, value: "detail-one", width: 1500, height: 1500 },
		{ type: 1, value: "detail-two", width: 750, height: 1100 },
	];
	const expected = { description_type: "json" as const, description: JSON.stringify({ field_list: fields }) };
	const now = { description_type: "json" as const, description: JSON.stringify({ field_list: fields.map(({ width: _w, height: _h, ...rest }) => rest) }) };
	assert.equal(descriptionState({ description_info: now }, expected), true);
	assert.equal(descriptionState({ description_info: { ...now, description: now.description.replace("detail-one", "wrong-image") } }, expected), null);
	assert.equal(descriptionState({ description_info: { ...now, description: now.description.replace("原始商品介紹", "人工新改") } }, expected), null);
	assert.equal(
		descriptionState({ description_info: { ...now, description: JSON.stringify({ field_list: [fields[0], fields[2], fields[1]] }) } }, expected),
		null,
	);
	assert.equal(
		descriptionState({ description_info: { ...expected, description: expected.description.replace('"width":1500', '"width":1400') } }, expected),
		null,
	);
	assert.equal(descriptionState({ description_info: { ...now, extra: "未知字段" } }, expected), null);
});

test("独立换主图核对完整原图列表，读回顺序和数量须一致；旧参数key不变", () => {
	const base = { shop: "cheeroutdoor", id: "123", beforeTitle: "餐具盒", title: "餐具盒" };
	const before = ["old-cover", "old-second"],
		images = ["clean-cover", "clean-second"];
	assert.deepEqual(imagesChange({ images: before }, before, images), { images });
	assert.throws(() => imagesChange({ images: ["changed-cover", "old-second"] }, before, images), /原图片已变/);
	assert.throws(() => imagesChange({}, before, images), /原图片已变/);
	assert.throws(() => imagesChange({ images: before.toReversed() }, before, images), /原图片已变/);
	assert.equal(imagesState({ images: images.map((id) => `https://down-tw.img.susercontent.com/file/${id}`) }, images), true);
	assert.equal(imagesState({ images: images.toReversed() }, images), null);
	assert.equal(imagesState({ images: [images[0]] }, images), null);
	assert.equal(imagesState({ images: [...images, "extra"] }, images), null);
	assert.deepEqual(imagesChange({ images }, before, images), { images });
	assert.equal(editParams.safeParse({ ...base, beforeImages: before, images }).success, true);
	assert.equal(editParams.safeParse({ ...base, images }).success, false);
	assert.equal(editParams.safeParse({ ...base, beforeImages: before }).success, false);
	assert.equal(editParams.safeParse({ ...base, beforeImages: before, images: [] }).success, false);
	assert.deepEqual(editProductInfo({ title: base.title, images }), { name: base.title, images });
	const old = { ...editParams.parse(base), shopId: "456" };
	const oldKey = `edit:456:123:${createHash("sha256")
		.update(JSON.stringify([base.beforeTitle, base.title, []]))
		.digest("hex")}`;
	assert.equal(editKey(old), oldKey);
	assert.notEqual(editKey({ ...old, beforeImages: before, images }), oldKey);
	assert.notEqual(editKey({ ...old, beforeImages: before, images }), editKey({ ...old, beforeImages: before, images: images.toReversed() }));
});

test("改标题只生成 name；已经是目标标题时不再提交", () => {
	assert.deepEqual(titleChange("新新好物｜KT地墊", "新新好物｜KT地墊", "【滿199出貨】新新好物｜KT地墊"), {
		info: { name: "【滿199出貨】新新好物｜KT地墊" },
	});
	assert.deepEqual(titleChange("【滿199出貨】KT地墊", "KT地墊", "【滿199出貨】KT地墊"), { skip: "已经是目标标题，不再提交" });
});

test("在售类目修改核对原路径、仅提交明确类目和属性，读回按属性id匹配", () => {
	const before = [100636, 100711, 101159];
	const target = [100636, 100711, 101160];
	const attribute = { attribute_id: 100131, attribute_values: [{ value_id: 1128 }] };
	const attributes = [attribute];
	assert.deepEqual(categoryChange({ category_path: before }, before, target, attributes), { category_path: target, attributes });
	assert.throws(() => categoryChange({ category_path: [100636, 101111] }, before, target, attributes), /原类目已变/);
	assert.equal(categoryState({ category_path: target, attributes: [{ ...attribute, name: "服务器附带名称" }] }, target, attributes), true);
	assert.equal(categoryState({ category_path: before, attributes }, target, attributes), null);
	assert.equal(categoryState({ category_path: target, attributes: [] }, target, attributes), null);
	assert.equal(
		categoryState(
			{ category_path: target, attributes: [{ attribute_id: attribute.attribute_id, attribute_values: [{ raw_value: "nil" }] }] },
			target,
			attributes,
		),
		null,
	);
	assert.equal(categoryState({ category_path: target }, undefined, undefined), true);
	const base = { shop: "cheeroutdoor", id: "123", beforeTitle: "地墊", title: "地墊" };
	assert.equal(editParams.safeParse({ ...base, beforeCategoryPath: before, categoryPath: target, attributes }).success, true);
	assert.equal(editParams.safeParse({ ...base, categoryPath: target }).success, false);
	assert.equal(editParams.safeParse({ ...base, attributes }).success, false);
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
