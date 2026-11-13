// 人工原始快照的回归：保留1688身份，缺失库存不伪装成零，原文规格不偷偷翻译。
import assert from "node:assert/strict";
import { test } from "node:test";
import { originalSourceApproved, sourceDeleteParams, sourceOffer, sourceProductSchema, sourcePublicationHash } from "./source-data.ts";
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

test("已有商品删除后仅重采不能复用旧批准，重新确认必须绑定当前商品指纹", () => {
	const row = { id: "1", shop: "cheeroutdoor", product_id: "900", title: "原文商品", cancelled: false, listed_at: null };
	const hash = sourcePublicationHash(row)!;
	const approval = { kind: "original-source" as const, sourceProductId: "4", hash, at: new Date().toISOString() };
	assert.equal(originalSourceApproved(approval, "4", "original", hash), true);
	assert.equal(originalSourceApproved(null, "4", "original", hash), false);
	assert.equal(originalSourceApproved(approval, "4", "original", sourcePublicationHash({ ...row, product_id: "901" })), false);
	assert.equal(sourcePublicationHash(row, "current-product-hash"), "current-product-hash");
});
