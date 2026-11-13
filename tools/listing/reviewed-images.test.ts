// 已审图片必须绑定真实来源、选定SKU和文件SHA；不允许把错图、假原图或旧规格审阅当作可发布图片。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { type Offer, OfferId, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import type { Pic, Pics } from "./pics.ts";
import {
	REVIEWED_CACHE_CHUNK_BYTES,
	reviewedImagesManifest,
	reviewedImagesPreview,
	reviewedImagesScope,
	reviewedOptions,
	validateReviewedBytes,
	validateReviewedFileDigests,
	validateReviewedManifest,
	validateSavedReviewedImages,
	writeReviewedImageCache,
} from "./reviewed-images.ts";
import { specsFrom } from "./variants.ts";

const sourceSha = "a".repeat(64),
	processedSha = "b".repeat(64),
	finalSha = "c".repeat(64);
const url = (s: string) => `https://example.com/${s}.png`;
function row() {
	const offer: Offer = {
		offerId: OfferId.parse("123"),
		url: "https://detail.1688.com/offer/123.html",
		title: "棉拖鞋",
		image: url("main"),
		images: [url("main")],
		unit: "双",
		minQty: 1,
		props: [
			{ name: "颜色", values: ["蓝", "红"].map((name) => ({ name, image: url(name) })) },
			{ name: "尺码", values: ["36-37", "38-39"].map((name) => ({ name, image: "" })) },
		],
		skus: ["蓝", "红"].flatMap((color, c) =>
			["36-37", "38-39"].map((size, s) => ({
				skuId: SkuId.parse(`${c}-${s}`),
				specId: SpecId.parse(`spec-${c}-${s}`),
				name: `${color}/${size}`,
				attrs: [color, size],
				price: 15,
				stock: 8,
				image: url(color),
				weightKg: 0.4,
			})),
		),
	};
	const variants = specsFrom(offer).specs;
	for (const variant of variants.variants) variant.priceTwd = 199;
	return {
		shop: "cheeroutdoor",
		offer_id: offer.offerId,
		offer: Object.assign(offer, { detail: [url("detail"), url("detail2")] }),
		variants,
		images: { main: [{ from: url("main"), sha: sourceSha }] } as Partial<Pics>,
	};
}
const entry = (sourceUrl: string) => ({
	sourceUrl,
	sourceSha256: sourceSha,
	path: "/tmp/reviewed.png",
	sha256: processedSha,
	provider: "openai-image" as const,
	evidence: "已核对原图实物、繁体文案与对应款式",
});
function manifest(r: ReturnType<typeof row>) {
	return reviewedImagesManifest.parse({
		expectedScope: reviewedImagesScope(r),
		main: [entry(url("main"))],
		detail: [entry(url("detail"))],
		options: reviewedOptions(r).map((o) => ({ ...entry(o.sourceUrl), skuIds: o.skuIds })),
	});
}

test("预览保留完整主图、详情来源与全部规格映射；导入计划不修改成本、价格、库存和源SKU", () => {
	const r = row(),
		before = structuredClone(r),
		m = manifest(r);
	const preview = reviewedImagesPreview(r);
	assert.equal(preview.sourceDetailCount, 2);
	assert.deepEqual(preview.sourceDetail, [url("detail"), url("detail2")]);
	assert.equal(preview.requiredOptions.length, 2);
	assert.equal(preview.savedSourceShas[url("main")], sourceSha);
	validateReviewedManifest(r, m);
	assert.deepEqual(r, before);
	const priced = structuredClone(r);
	priced.variants.variants[0]!.priceTwd = 209;
	priced.variants.variants[0]!.stock = 7;
	assert.equal(reviewedImagesScope(priced), preview.expectedScope, "独立图片审阅不改核价或库存，也不因销售库存改变失效");
});

test("源规格更换、虚构skuId、漏规格、同规格重复和错色映射均拒绝", () => {
	const r = row(),
		m = manifest(r);
	const changed = structuredClone(r);
	changed.variants.variants[0]!.specId = SpecId.parse("wrong");
	assert.throws(() => reviewedImagesScope(changed), /specId/);
	for (const edit of [
		(x: typeof m) => {
			x.options[0]!.skuIds[0] = "not-selected";
		},
		(x: typeof m) => {
			x.options.pop();
		},
		(x: typeof m) => {
			x.options[0]!.skuIds.pop();
		},
		(x: typeof m) => {
			x.options[0]!.skuIds.push(x.options[0]!.skuIds[0]!);
		},
		(x: typeof m) => {
			[x.options[0]!.skuIds, x.options[1]!.skuIds] = [x.options[1]!.skuIds, x.options[0]!.skuIds];
		},
	]) {
		const invalid = structuredClone(m);
		edit(invalid);
		assert.throws(() => validateReviewedManifest(r, invalid), /规格图|SKU/);
	}
	const remapped = structuredClone(r);
	remapped.variants.tiers[0]!.options[0]!.image = url("another");
	assert.throws(() => validateReviewedManifest(remapped, m), /已变/);
});

test("来源须属于本稿、clean-original必须同SHA，拆分详情允许同原URL但文件不可重复", () => {
	const r = row(),
		m = manifest(r);
	const wrong = structuredClone(m);
	wrong.main[0]!.sourceUrl = url("foreign");
	assert.throws(() => validateReviewedManifest(r, wrong), /来源URL/);
	const fake = structuredClone(m);
	fake.main[0]!.provider = "clean-original";
	assert.throws(() => validateReviewedManifest(r, fake), /clean-original/);
	const split = structuredClone(m);
	split.detail.push({ ...split.detail[0]!, path: "/tmp/panel2.png", sha256: "d".repeat(64) });
	assert.doesNotThrow(() => validateReviewedManifest(r, split));
	split.detail.push({ ...split.detail[0]! });
	assert.throws(() => validateReviewedManifest(r, split), /重复图片/);
	assert.equal(reviewedImagesManifest.safeParse({ ...m, main: [{ ...m.main[0], path: "relative.png" }] }).success, false);
	assert.equal(reviewedImagesManifest.safeParse({ ...m, main: [{ ...m.main[0], evidence: " " }] }).success, false);
});

test("实际文件SHA、来源SHA、占位和详情长宽比校验，不因provider而豁免", () => {
	const input = entry(url("main"));
	const bytes = { bytes: new Uint8Array(), mime: "image/png", sha256: processedSha, width: 800, height: 800 };
	assert.doesNotThrow(() => validateReviewedBytes(input, bytes, sourceSha, "main"));
	assert.throws(() => validateReviewedBytes(input, bytes, finalSha, "main"), /来源原图SHA/);
	assert.throws(() => validateReviewedBytes(input, { ...bytes, sha256: finalSha }, sourceSha, "main"), /文件SHA/);
	assert.throws(() => validateReviewedBytes(input, { ...bytes, width: 10 }, sourceSha, "main"), /尺寸/);
	assert.throws(() => validateReviewedBytes(input, { ...bytes, width: 790, height: 2766 }, sourceSha, "detail"), /详情图/);
	assert.throws(() => validateReviewedBytes(input, { ...bytes, width: 699 }, sourceSha, "detail"), /详情图/);
});

test("已保存审阅必须有真实上传及处理来源；换规格、丢审阅、图片drop后不能续做或发布", () => {
	const r = row(),
		m = manifest(r);
	const pic = (input: (typeof m.main)[number] & { skuIds?: string[] }): Pic => ({
		from: input.sourceUrl,
		sha: input.sourceSha256,
		final: finalSha,
		imageId: `uploaded-${input.sourceUrl}`,
		width: 800,
		height: 800,
		review: {
			provider: input.provider,
			evidence: input.evidence,
			sourceSha256: input.sourceSha256,
			processedSha256: input.sha256,
			path: input.path,
			scope: m.expectedScope,
			skuIds: input.skuIds,
			at: "2026-11-13T00:00:00.000Z",
		},
	});
	r.images = { imageMode: "reviewed", main: m.main.map(pic), detail: m.detail.map(pic), options: m.options.map(pic) };
	assert.doesNotThrow(() => validateSavedReviewedImages(r));
	const missing = structuredClone(r);
	delete missing.images.main![0]!.review;
	assert.throws(() => validateSavedReviewedImages(missing), /来源/);
	const swapped = structuredClone(r);
	swapped.images.options![0]!.review!.skuIds = ["foreign"];
	assert.throws(() => validateSavedReviewedImages(swapped), /映射/);
	const dropped = structuredClone(r);
	dropped.images.main![0]!.drop = "审阅发现款式不对应";
	assert.throws(() => validateSavedReviewedImages(dropped), /失效/);
});

test("数据库端完整摘要须匹配处理SHA；篡改、bytes缺失和尺寸变化均拒绝", () => {
	const pics: Partial<Pics> = {
		main: [
			{
				from: url("main"),
				width: 800,
				height: 900,
				review: {
					provider: "openai-image",
					evidence: "实际审阅",
					sourceSha256: sourceSha,
					processedSha256: processedSha,
					path: "/tmp/reviewed.png",
					scope: finalSha,
					at: "2026-11-13T00:00:00.000Z",
				},
			},
		],
	};
	const saved = { sha256: processedSha, digest: processedSha, bytes_length: 928863, width: 800, height: 900 };
	assert.doesNotThrow(() => validateReviewedFileDigests(pics, [saved]));
	assert.throws(() => validateReviewedFileDigests(pics, [{ ...saved, digest: finalSha }]), /完整内容SHA256/);
	assert.throws(() => validateReviewedFileDigests(pics, [{ ...saved, digest: null, bytes_length: null }]), /没有保存bytes/);
	assert.throws(() => validateReviewedFileDigests(pics, [{ ...saved, bytes_length: 0 }]), /没有保存bytes/);
	assert.throws(() => validateReviewedFileDigests(pics, []), /没有保存bytes/);
	assert.throws(() => validateReviewedFileDigests(pics, [{ ...saved, height: 901 }]), /尺寸/);
});

function cacheFixture(initial: Uint8Array | null, corruptFinalDigest = false) {
	const expected = Uint8Array.from({ length: REVIEWED_CACHE_CHUNK_BYTES * 2 + 7 }, (_, i) => (i * 37) % 256);
	const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
	const image = { bytes: expected, mime: "image/png", sha256: digest(expected), width: 1024, height: 1536 };
	let data = initial === null ? null : new Uint8Array(initial),
		reads = 0,
		initialized = 0;
	const chunks: Uint8Array[] = [];
	const store = {
		read: async () => {
			reads++;
			return {
				sha256: image.sha256,
				digest: data ? (corruptFinalDigest && reads > 1 ? sourceSha : digest(data)) : null,
				bytes_length: data?.length ?? null,
				width: image.width,
				height: image.height,
			};
		},
		initialize: async () => {
			initialized++;
			data = new Uint8Array();
		},
		append: async (chunk: Uint8Array) => {
			chunks.push(new Uint8Array(chunk));
			data = new Uint8Array(Buffer.concat([Buffer.from(data!), Buffer.from(chunk)]));
		},
	};
	return { image, store, chunks, data: () => data, reads: () => reads, initialized: () => initialized };
}

test("已缓存PNG完整摘要和长度匹配时直接复用，不重发bytes或初始化缓存", async () => {
	const seed = cacheFixture(null),
		f = cacheFixture(seed.image.bytes);
	assert.deepEqual(await writeReviewedImageCache(f.image, f.store), { reused: true, chunks: 0 });
	assert.equal(f.initialized(), 0);
	assert.equal(f.reads(), 1);
	assert.equal(f.chunks.length, 0);
	assert.deepEqual(f.data(), f.image.bytes);
});

test("错误缓存明确拒绝，不覆盖或追加，不能靠同SHA键掩盖字节损坏", async () => {
	const seed = cacheFixture(null),
		changed = new Uint8Array(seed.image.bytes);
	changed[0] = changed[0]! ^ 255;
	const f = cacheFixture(changed);
	await assert.rejects(writeReviewedImageCache(f.image, f.store), /缓存完整摘要或长度不符/);
	assert.equal(f.initialized(), 0);
	assert.equal(f.chunks.length, 0);
	assert.deepEqual(f.data(), changed);
});

test("缺缓存时以不超过64KiB的参数块保留全部原始字节，最后核完整摘要再返回", async () => {
	const f = cacheFixture(null);
	assert.deepEqual(await writeReviewedImageCache(f.image, f.store), { reused: false, chunks: 3 });
	assert.deepEqual(
		f.chunks.map((c) => c.length),
		[REVIEWED_CACHE_CHUNK_BYTES, REVIEWED_CACHE_CHUNK_BYTES, 7],
	);
	assert.equal(f.reads(), 2);
	assert.equal(f.initialized(), 1);
	assert.deepEqual(f.data(), f.image.bytes);
});

test("分块后完整摘要不符或追加失败均抛出，事务调用方不会提交未验证缓存", async () => {
	const f = cacheFixture(null, true);
	let committed = false;
	await assert.rejects(async () => {
		await writeReviewedImageCache(f.image, f.store);
		committed = true;
	}, /缓存完整摘要或长度不符/);
	assert.equal(committed, false);
	const interrupted = cacheFixture(null);
	await assert.rejects(
		writeReviewedImageCache(interrupted.image, {
			...interrupted.store,
			append: async () => {
				throw new Error("connection closed during append");
			},
		}),
		/connection closed during append/,
	);
	assert.equal(interrupted.reads(), 1, "追加失败不能伪造最终摘要检查通过");
});
