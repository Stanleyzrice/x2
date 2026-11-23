// 审阅必须绑定实际内容、角色和源规格映射；不连库、不问模型、不上传图片。
import assert from "node:assert/strict";
import { test } from "node:test";
import { SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import { auditCurrent, auditKey, reviewedAuditCurrent, reviewImages } from "./audit.ts";
import type { Product } from "./product.ts";
import { listingReviewParams, makeReviewedAudit, reviewedAuditEditable } from "./review.ts";
import { textCheck } from "./textcheck.ts";
import { creationReviewBlock, sourceLiveReviewBlock } from "./writes.ts";

function product(): Product {
	return {
		parentSku: "LT123",
		title: "保暖棉拖鞋",
		description: "款式及尺碼依選項選購。",
		categoryPath: [1, 2, 3],
		attributes: [],
		preOrder: true,
		daysToShip: 10,
		minPurchase: 1,
		channels: ["30012"],
		tiers: [{ source: "颜色", name: "款式", options: [{ source: "红色", name: "紅色", image: "https://source/red.jpg" }] }],
		variants: [
			{
				sku: "LT123-red",
				skuId: SkuId.parse("source-red"),
				specId: SpecId.parse("spec-red"),
				options: [0],
				costRmb: 10,
				weightKg: 0.4,
				priceTwd: 159,
				stock: 20,
			},
		],
		images: ["cover", "main2"],
		detail: [{ id: "detail", width: 800, height: 800 }],
		optionImages: { "https://source/red.jpg": "option-red" },
		sizeChart: "size-chart",
	};
}

function input(p: Product) {
	return {
		expectedKey: auditKey(p),
		provider: "codex-visual" as const,
		evidence: "已逐图查看成品和原始货源，核对款式、颜色、尺寸建议及繁体文案。",
		textIssues: [],
		images: reviewImages(p).map((id) => ({ id, issues: [] })),
	};
}

test("显式审阅保留真实来源、证据和逐图结果，覆盖尺码图，不写 Gemini 结果", () => {
	const p = product(),
		v = input(p),
		a = makeReviewedAudit(p, v, "2026-11-13T00:00:00.000Z");
	assert.equal(a.provider, "codex-visual");
	assert.equal(a.evidence, v.evidence);
	assert.deepEqual(a.reviewedImageIds, ["cover", "main2", "detail", "option-red", "size-chart"]);
	assert.equal(a.images.find((x) => x.id === "size-chart")!.role, "尺码图");
	assert.equal(auditCurrent(a, p), true);
	assert.equal(reviewedAuditCurrent(a, p), true);
	assert.equal(
		a.images.some((x) => x.dropped),
		false,
	);
	const noted = makeReviewedAudit(p, { ...v, textIssues: ["「产品」为简体", "「产品」为简体"] });
	assert.deepEqual(noted.textIssues, ["「产品」为简体"]);
	const deepseek = makeReviewedAudit(p, { ...v, provider: "deepseek-visual" });
	assert.equal(deepseek.provider, "deepseek-visual");
	assert.equal(reviewedAuditCurrent(deepseek, p), true);
});

test("人工审阅拒绝旧指纹、漏图、重复或外来图片，空证据不能过门槛", () => {
	const p = product(),
		v = input(p);
	assert.throws(() => makeReviewedAudit(p, { ...v, expectedKey: "0".repeat(64) }), /已变化/);
	assert.throws(() => makeReviewedAudit(p, { ...v, images: v.images.slice(1) }), /完整覆盖/);
	assert.throws(() => makeReviewedAudit(p, { ...v, images: [...v.images, v.images[0]!] }), /重复/);
	assert.throws(() => makeReviewedAudit(p, { ...v, images: [...v.images.slice(1), { id: "foreign", issues: [] }] }), /完整覆盖/);
	assert.equal(listingReviewParams.safeParse({ id: "234", ...v, evidence: " " }).success, false);
	assert.equal(listingReviewParams.safeParse({ id: "234", ...v, provider: "gemini" }).success, false);
	const a = makeReviewedAudit(p, v);
	assert.equal(auditCurrent({ ...a, evidence: "" }, p), false);
	assert.equal(auditCurrent({ ...a, images: [] }, p), false);
	assert.equal(auditCurrent({ ...a, reviewedImageIds: a.reviewedImageIds!.slice(1) }, p), false);
	assert.equal(auditCurrent({ key: auditKey(p), provider: "codex-visual" }, p), false);
	assert.equal(auditCurrent({ key: auditKey(p) }, p), true);
});

test("主图顺序、图片角色、规格图映射和源 SKU 变化使审核指纹失效", () => {
	const p = product(),
		key = auditKey(p);
	assert.notEqual(auditKey({ ...p, images: ["main2", "cover"] }), key);
	assert.notEqual(auditKey({ ...p, images: ["cover"], detail: [{ id: "main2", width: 800, height: 800 }, ...p.detail] }), key);
	assert.notEqual(auditKey({ ...p, optionImages: { "https://source/red.jpg": "main2" } }), key);
	assert.notEqual(auditKey({ ...p, tiers: [{ ...p.tiers[0]!, options: [{ ...p.tiers[0]!.options[0]!, image: "https://source/other.jpg" }] }] }), key);
	assert.notEqual(auditKey({ ...p, variants: [{ ...p.variants[0]!, skuId: SkuId.parse("source-other") }] }), key);
	assert.notEqual(auditKey({ ...p, sizeChart: "chart-other" }), key);
	assert.notEqual(auditKey({ ...p, description: "新文案" }), key);
	assert.equal(auditKey({ ...p, variants: [{ ...p.variants[0]!, priceTwd: 169, stock: 10 }] }), key);
	const a = makeReviewedAudit(p, input(p));
	assert.equal(reviewedAuditCurrent(a, { ...p, images: ["main2", "cover"] }), false);
});

test("已建或上架商品不能经草稿工具保存审阅", () => {
	assert.doesNotThrow(() => reviewedAuditEditable({ product_id: null, listed_at: null }));
	assert.throws(() => reviewedAuditEditable({ product_id: "123", listed_at: null }), /已经建成/);
	assert.throws(() => reviewedAuditEditable({ product_id: null, listed_at: new Date() }), /已经建成/);
});

test("建商品前现验审阅：未审、过期或缺逐图结果均拦住，当前真实审核才放行", () => {
	const p = product(),
		a = makeReviewedAudit(p, input(p));
	assert.match(creationReviewBlock(null, p)!, /尚未完成当前审核/);
	assert.match(creationReviewBlock(a, { ...p, images: ["main2", "cover"] })!, /重新审阅/);
	assert.match(creationReviewBlock({ ...a, images: [] }, p)!, /重新审阅/);
	assert.equal(creationReviewBlock(a, p), null);
	assert.equal(creationReviewBlock({ key: auditKey(p), provider: "gemini", textIssues: [], images: [], at: "2026-11-13T00:00:00.000Z" }, p), null);
});

test("人工备选的处理图和已审图须有当前真实审阅，原图批准不能替代", () => {
	const p = product(),
		a = makeReviewedAudit(p, input(p));
	const approval = { kind: "original-source" as const, sourceProductId: "source-1", hash: "hash", at: "2026-11-16T00:00:00.000Z" };
	for (const imageMode of ["processed", "reviewed"] as const) {
		const source = { approval, id: "source-1", imageMode, hash: "hash" };
		assert.ok(sourceLiveReviewBlock(null, p, source), "没有审核时，原图批准不能授权处理图");
		assert.ok(creationReviewBlock(null, p, source), "建商品同样不能凭原图批准使用处理图");
		assert.ok(sourceLiveReviewBlock(a, undefined, source), "商品不完整时不能上架");
		assert.ok(sourceLiveReviewBlock(a, { ...p, images: ["main2", "cover"] }, source), "图片变化后旧审核失效");
		assert.ok(sourceLiveReviewBlock({ ...a, images: [] }, p, source), "缺少逐图结果不能上架");
		assert.equal(sourceLiveReviewBlock(a, p, { ...source, approval: null }), null);
		assert.equal(creationReviewBlock(a, p, { ...source, approval: null }), null);
		const gemini = { ...a, provider: "gemini" as const };
		assert.equal(Boolean(creationReviewBlock(gemini, p, source)), imageMode === "reviewed");
		assert.equal(Boolean(sourceLiveReviewBlock(gemini, p, source)), imageMode === "reviewed");
	}
});

test("原图备选上架继续要求匹配来源与当前内容的原图批准", () => {
	const p = product(),
		a = makeReviewedAudit(p, input(p));
	const source = {
		approval: { kind: "original-source" as const, sourceProductId: "source-1", hash: "hash", at: "2026-11-16T00:00:00.000Z" },
		id: "source-1",
		imageMode: "original" as const,
		hash: "hash",
	};
	assert.equal(sourceLiveReviewBlock(null, undefined, source), null);
	assert.ok(sourceLiveReviewBlock(a, p, { ...source, approval: null }), "真实审核不改变原图快捷上架批准要求");
	assert.ok(sourceLiveReviewBlock(a, p, { ...source, id: "another-source" }));
	assert.ok(sourceLiveReviewBlock(a, p, { ...source, hash: "changed" }));
});

test("textCheck复用当前已完成的显式审阅，不再取图或调用Gemini", async () => {
	const p = product(),
		a = makeReviewedAudit(p, input(p));
	let imageReads = 0;
	const result = await textCheck(p, {
		cachedAudit: a,
		image: async () => {
			imageReads++;
			throw new Error("不应重新取图");
		},
	});
	assert.equal(result, a);
	assert.equal(imageReads, 0);
	const changed = { ...p, title: "已修改的保暖棉拖鞋" };
	await assert.rejects(textCheck(changed, { cachedAudit: a, image: async () => Promise.reject(new Error("新指纹必须重新审阅")) }), /重新审阅/);
	await assert.rejects(textCheck(p, { cachedAudit: a, force: true, image: async () => Promise.reject(new Error("强制重新审阅")) }), /强制重新审阅/);
});
