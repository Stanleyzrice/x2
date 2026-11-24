// 人工原始快照的回归：保留1688身份，缺失库存不伪装成零，原文规格不偷偷翻译。
import assert from "node:assert/strict";
import { test } from "node:test";
import { updatedAttributes } from "./category.ts";
import {
	mergeSourceFields,
	originalSourceApproved,
	sourceDeleteParams,
	sourceFieldsSchema,
	sourceOffer,
	sourceProductSchema,
	sourcePublicationHash,
	sourceUpdateParams,
} from "./source-data.ts";
import { specsFrom } from "./variants.ts";

const source = () =>
	sourceProductSchema.parse({
		platform: "1688",
		sourceId: "123",
		url: "https://detail.1688.com/offer/123.html",
		title: "苹果图案室内居家保暖棉拖鞋",
		images: ["https://example.com/main.jpg"],
		minQty: 1,
		freightRmb: 0,
		freeShipping: true,
		props: [
			{
				name: "颜色",
				values: [
					{ name: "苹果红", image: "https://example.com/red.jpg" },
					{ name: "海盐蓝", image: "https://example.com/blue.jpg" },
				],
			},
		],
		skus: [
			{ id: "red", specId: "sred", name: "苹果红", attrs: ["苹果红"], price: 12, stock: 5, image: "https://example.com/red.jpg", weightKg: 0.3 },
			{ id: "blue", specId: "sblue", name: "海盐蓝", attrs: ["海盐蓝"], price: 12, stock: 4, image: "https://example.com/blue.jpg", weightKg: 0.3 },
		],
		description: { text: "鞋面材质：毛绒。", images: [], blocks: [{ type: "text", text: "鞋面材质：毛绒。" }] },
		errors: [],
	});

test("1688商品编号和原规格编号保持原值", () => {
	const p = source();
	p.skus[0]!.specId = "spec-red";
	assert.equal(sourceOffer(p).offer?.offerId, "123");
	assert.equal(sourceOffer(p).offer?.skus[0]?.specId, "spec-red");
});

test("缺失库存保持未知，须明确补充后才能转换规格", () => {
	const p = source();
	p.skus[0]!.stock = null;
	assert.equal(sourceOffer(p).offer, null);
	assert.match(sourceOffer(p).problems.join("；"), /苹果红.*库存/);
	assert.equal(sourceOffer(p, { stocks: { red: 8 } }).offer?.skus[0]?.stock, 8);
	assert.equal(p.skus[0]!.stock, null);
});

test("原文模式使用原始层名和选项名，不调用繁体转换", () => {
	const offer = sourceOffer(source()).offer!;
	const result = specsFrom(offer, [], null, { originalText: true });
	assert.equal(result.specs.tiers[0]?.name, "颜色");
	assert.deepEqual(
		result.specs.tiers[0]?.options.map((o) => o.name),
		["苹果红", "海盐蓝"],
	);
});

test("仅明确点击批准的原文来源及相同指纹可走人工原图发布", () => {
	const approval = { kind: "original-source" as const, sourceProductId: "4", hash: "a".repeat(64), at: new Date().toISOString() };
	assert.equal(originalSourceApproved(approval, "4", "original", approval.hash), true);
	assert.equal(originalSourceApproved(approval, "5", "original", approval.hash), false);
	assert.equal(originalSourceApproved(approval, "4", "processed", approval.hash), false);
	assert.equal(originalSourceApproved(approval, "4", "original", "b".repeat(64)), false);
	assert.equal(originalSourceApproved(undefined, "4", "original", approval.hash), false);
});

test("人工原文规格超过平台长度时保留原值并报问题，不能静默裁剪", () => {
	const p = source();
	p.skus[0]!.attrs = ["苹果红".repeat(10)];
	p.props[0]!.values[0]!.name = p.skus[0]!.attrs[0]!;
	const result = specsFrom(sourceOffer(p).offer!, [], null, { originalText: true });
	assert.equal(result.specs.tiers[0]!.options[0]!.name, p.skus[0]!.attrs[0]);
});

test("删除必须明确给出非空备选编号，不能把缺少编号解释为全部", () => {
	for (const sourceIds of [undefined, [], [""], ["not-a-source-id"]]) assert.throws(() => sourceDeleteParams.parse({ shop: "cheeroutdoor", sourceIds }));
	assert.deepEqual(sourceDeleteParams.parse({ shop: "cheeroutdoor", targetShop: "ni1206", sourceIds: ["2", "2", "1"] }), {
		shop: "cheeroutdoor",
		targetShop: "ni1206",
		sourceIds: ["2", "1"],
	});
});

test("备选补充的CLI JSON与网页结构化输入等价，存储结构仍拒绝JSON字符串", () => {
	const base = { shop: "cheeroutdoor", sourceId: "38" };
	const fields = {
		weightKg: 2,
		freightRmb: 3,
		minQty: 1,
		daysToShip: 15,
		categoryPath: [100636, 101169, 101828],
		attributes: [{ attribute_id: 100832, attribute_values: [{ value_id: 4364 }] }],
		stocks: { "6007569749314": 50 },
		salePricesTwd: { "6007569749314": 249 },
		weightsKg: { "6007569749314": 0.4 },
		hiddenSkuImages: ["https://example.com/sku.png"],
		tierLabels: [{ source: "颜色", name: "款式", options: { 红色: "珊瑚紅" } }],
		prices: { "6007569749314": 15 },
		mainImages: ["https://example.com/main.jpg"],
		detailImages: ["https://example.com/detail.jpg"],
	};
	const jsonFields = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, JSON.stringify(value)]));
	assert.deepEqual(sourceUpdateParams.parse({ ...base, ...jsonFields }), sourceUpdateParams.parse({ ...base, ...fields }));
	assert.deepEqual(sourceUpdateParams.parse(base), base);
	for (const [key, value] of Object.entries(jsonFields)) assert.equal(sourceFieldsSchema.safeParse({ [key]: value }).success, false, key);
	for (const key of Object.keys(fields)) {
		assert.equal(sourceUpdateParams.safeParse({ ...base, [key]: "[invalid-json" }).success, false, key);
		assert.equal(sourceUpdateParams.safeParse({ ...base, [key]: "null" }).success, false, key);
	}
	for (const key of ["weightKg", "freightRmb", "minQty", "daysToShip"]) assert.equal(sourceUpdateParams.safeParse({ ...base, [key]: "" }).success, false, key);
	assert.equal(sourceUpdateParams.parse({ ...base, freightRmb: "0" }).freightRmb, 0);
});

test("备选更新的属性名称来自当前类目所选值，换类目或未知类目清除旧标签", () => {
	const tree = [
		{
			id: "100832",
			name: "桌子種類",
			mandatory: true,
			maxValues: 1,
			values: [
				{ valueId: "4364", name: "邊桌" },
				{ valueId: "1", name: "其他" },
			],
		},
		{ id: "100831", name: "組裝", mandatory: false, maxValues: 1, values: [{ valueId: "3823", name: "需組裝" }] },
	];
	const given = [
		{ attribute_id: 100832, attribute_values: [{ value_id: 4364 }] },
		{ attribute_id: 100831, attribute_values: [{ value_id: 3823 }] },
	];
	assert.deepEqual(updatedAttributes(tree, given, false), { attributes: given, text: "桌子種類：邊桌\n組裝：需組裝", missing: [] });
	assert.deepEqual(updatedAttributes(undefined, given, false), { attributes: given, text: null, missing: [] });
	assert.deepEqual(updatedAttributes(undefined, undefined, true), { attributes: null, text: null, missing: [] });
	assert.equal(updatedAttributes(undefined, undefined, false), null);
	assert.match(updatedAttributes(tree, [{ attribute_id: 100832, attribute_values: [{ value_id: 999 }] }], false)!.missing.join("；"), /可选值/);
	assert.match(updatedAttributes(tree, [given[1]!], false)!.missing.join("；"), /必填.*桌子種類/);
	assert.match(updatedAttributes(tree, [{ attribute_id: 999, attribute_values: [{ value_id: 4364 }] }], false)!.missing.join("；"), /不在当前类目/);
});

test("重选类目不会从来源补充值复活旧属性和备货天数，其他人工值保留", () => {
	const previous = sourceFieldsSchema.parse({
		title: "人工标题",
		weightKg: 2,
		freightRmb: 3,
		stocks: { "6007569749314": 50 },
		salePricesTwd: { "6007569749314": 249 },
		weightsKg: { "6007569749314": 0.4 },
		hiddenSkuImages: ["https://example.com/sku.png"],
		tierLabels: [{ source: "颜色", name: "款式", options: { 红色: "珊瑚紅" } }],
		categoryPath: [100636, 101169],
		attributes: [{ attribute_id: 100832, attribute_values: [{ value_id: 4364 }] }],
		daysToShip: 15,
	});
	const before = structuredClone(previous);
	const next = { categoryPath: [100636, 101170] };
	const saved = mergeSourceFields(previous, next);
	assert.equal(saved.attributes, undefined, "make不能再取得旧类目的属性补充值");
	assert.equal(saved.daysToShip, undefined, "make不能再取得旧类目的备货天数补充值");
	assert.deepEqual(saved, {
		title: "人工标题",
		weightKg: 2,
		freightRmb: 3,
		stocks: { "6007569749314": 50 },
		salePricesTwd: { "6007569749314": 249 },
		weightsKg: { "6007569749314": 0.4 },
		hiddenSkuImages: ["https://example.com/sku.png"],
		tierLabels: [{ source: "颜色", name: "款式", options: { 红色: "珊瑚紅" } }],
		categoryPath: next.categoryPath,
	});
	assert.deepEqual(previous, before, "原补充值不被原地修改");
	assert.deepEqual(mergeSourceFields(previous, { description: "人工说明" }), { ...previous, description: "人工说明" });
	const explicit = { ...next, attributes: [], daysToShip: 7 };
	assert.deepEqual(mergeSourceFields(previous, explicit), { ...previous, ...explicit });
	assert.equal(mergeSourceFields(previous, { ...next, attributes: [] }).daysToShip, undefined);
	assert.equal(mergeSourceFields(previous, { ...next, daysToShip: 7 }).attributes, undefined);
	assert.equal(mergeSourceFields(previous, { categoryPath: previous.categoryPath }).daysToShip, undefined, "重选相同类目也与稿件清除行为一致");
});

test("已有商品删除后仅重采不能复用旧批准，重新确认必须绑定当前商品指纹", () => {
	const row = { id: "1", shop: "cheeroutdoor", product_id: "900", title: "原文商品", cancelled: false, listed_at: null };
	const hash = sourcePublicationHash(row)!;
	const approval = { kind: "original-source" as const, sourceProductId: "4", hash, at: new Date().toISOString() };
	assert.equal(originalSourceApproved(approval, "4", "original", hash), true);
	assert.equal(originalSourceApproved(null, "4", "original", hash), false);
	assert.equal(originalSourceApproved(approval, "4", "original", sourcePublicationHash({ ...row, product_id: "901" })), false);
	assert.equal(sourcePublicationHash(row, "current-product-hash"), "current-product-hash");
});
