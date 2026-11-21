// 已审图片必须绑定真实来源、选定SKU和文件SHA；不允许把错图、假原图或旧规格审阅当作可发布图片。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { inspect } from "../../connectors/services/image/api.ts";
import { type Offer, OfferId, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import type { Sql } from "../../platform/db/index.ts";
import { finish, makeImages } from "./images.ts";
import type { Pic, Pics } from "./pics.ts";
import {
	problemsAfterReviewedImages,
	REVIEWED_CACHE_CHUNK_BYTES,
	reviewedAssetsParams,
	reviewedImagesManifest,
	reviewedImagesPreview,
	reviewedImagesScope,
	reviewedOptions,
	validatePublishedAssetSources,
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

test("已建商品的详情和规格素材分别绑定原详情与逐SKU原图", () => {
	const r = row();
	const input = { detail: [entry(url("detail"))], options: [{ ...entry(url("蓝")), skuId: "0-0" }] };
	const parse = (manifest: typeof input) => reviewedAssetsParams.parse({ id: "26", productId: "900", offerId: "123", manifest }).manifest;
	assert.doesNotThrow(() => validatePublishedAssetSources(r, parse(input)));
	assert.throws(() => validatePublishedAssetSources(r, parse({ ...input, detail: [entry(url("main"))] })), /原详情/);
	assert.throws(() => validatePublishedAssetSources(r, parse({ ...input, options: [{ ...entry(url("红")), skuId: "0-0" }] })), /与原货源SKU不匹配/);
	assert.throws(() => validatePublishedAssetSources(r, parse({ ...input, options: [...input.options, ...input.options] })), /重复SKU/);
});

test("已建商品可单独上传主图，须来自该稿的原主图", () => {
	const parse = (sourceUrl: string) =>
		reviewedAssetsParams.parse({ id: "26", productId: "900", offerId: "123", manifest: { main: [entry(sourceUrl)] } }).manifest;
	assert.doesNotThrow(() => validatePublishedAssetSources(row(), parse(url("main"))));
	assert.throws(() => validatePublishedAssetSources(row(), parse(url("detail"))), /原主图/);
});

function savedReviewedRow() {
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
			at: "2026-11-17T00:00:00.000Z",
		},
	});
	return { ...r, images: { imageMode: "reviewed" as const, main: m.main.map(pic), detail: m.detail.map(pic), options: m.options.map(pic) } };
}

test("已审图片导入及续做清除已解决的原图超限和未上传告警，保留其他硬缺项及人工图片说明", () => {
	const r = savedReviewedRow();
	const stale = [
		"图：缺可用的主图（仅准备货源，待图片处理和审阅）",
		"图：缺可用的主图，待图片处理与审阅（x2 listing reviewed-images-preview）",
		"图：主图 12 张，须明确选择最多 9 张",
		"图：详情图 30 张，须明确选择最多 12 张",
		`图：详情图 超过张数，不用（${url("detail2")}）`,
		`图：规格图 尚未上传（${url("蓝")}）`,
	];
	const hard = ["货源：起订量 2，无法单件购买", "核价：缺国内运费", "类目：不在本店允许的类目里", "属性：必填材质待确认", "图：实物花色待人工核对"];
	const problems = [...stale, ...hard].join("\n");
	assert.equal(problemsAfterReviewedImages({ ...r, problems }), hard.join("\n"));
	assert.equal(problemsAfterReviewedImages({ ...r, problems: stale.join("\n") }), null);
	assert.equal(problemsAfterReviewedImages({ ...r, problems: hard.join("\n") }), hard.join("\n"), "恢复已有导入时可复用当前图，不重排或重传");
});

test("当前已审图片仍有drop、漏规格或不合规尺寸时，不清旧图片问题", () => {
	for (const change of [
		(r: ReturnType<typeof savedReviewedRow>) => {
			r.images.main[0]!.drop = "当前图片不合格";
		},
		(r: ReturnType<typeof savedReviewedRow>) => {
			r.images.options.pop();
		},
		(r: ReturnType<typeof savedReviewedRow>) => {
			r.images.detail[0]!.width = 699;
		},
	]) {
		const r = savedReviewedRow();
		change(r);
		assert.throws(() => problemsAfterReviewedImages({ ...r, problems: "图：详情图 30 张，须明确选择最多 12 张" }), /失效|规格图|不合要求/);
	}
});

test("无水印已审图片复用原生上传，PNG字节、格式与审阅来源保持原样", async () => {
	const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=", "base64");
	const base = inspect(bytes);
	for (const provider of ["clean-original", "openai-image"] as const) {
		const saved: unknown[] = [],
			calls: { base64: string; mime: string }[][] = [];
		const sql = ((query: unknown, ...values: unknown[]) => {
			if (!Array.isArray(query)) return query;
			const statement = query.join("");
			if (statement.includes("select image_id")) return Promise.resolve([]);
			if (statement.includes("insert into shop_images")) {
				saved.push(values[0]);
				return Promise.resolve([]);
			}
			throw new Error(`unexpected SQL: ${statement}`);
		}) as unknown as Sql;
		const pic: Pic = {
			from: url(provider),
			sha: provider === "clean-original" ? base.sha256 : sourceSha,
			review: {
				provider,
				evidence: "合成测试的已审记录",
				sourceSha256: provider === "clean-original" ? base.sha256 : sourceSha,
				processedSha256: base.sha256,
				path: "/tmp/reviewed.png",
				scope: finalSha,
				skuIds: ["blue-small", "blue-large"],
				at: "2026-11-17T00:00:00.000Z",
			},
		};
		const before = structuredClone(pic);
		let browserCalls = 0;
		await finish(
			sql,
			"cheeroutdoor",
			null,
			pic,
			base,
			async (fn) => {
				browserCalls++;
				return fn();
			},
			0,
			async (files) => {
				calls.push(structuredClone(files));
				return [`uploaded-${provider}`];
			},
		);
		assert.equal(browserCalls, 1);
		assert.deepEqual(calls, [[{ base64: bytes.toString("base64"), mime: "image/png" }]]);
		assert.deepEqual(saved, [{ shop: "cheeroutdoor", sha256: base.sha256, image_id: `uploaded-${provider}`, width: base.width, height: base.height }]);
		assert.deepEqual(pic, { ...before, final: base.sha256, imageId: `uploaded-${provider}`, width: base.width, height: base.height });
		assert.deepEqual(base.bytes, bytes);
	}
});

test("普通processed图片仍须配置水印，不因已审图片允许无水印而放行", async () => {
	const sql = (() => {
		throw new Error("不应读写数据库");
	}) as unknown as Sql;
	await assert.rejects(
		makeImages(sql, { shop: "cheeroutdoor", mark: null, main: [], detail: [], options: [], browser: async (fn) => fn(), imageMode: "processed" }),
		/处理图片模式缺少水印设置/,
	);
});

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
	assert.equal(reviewedImagesManifest.safeParse({ ...m, main: [{ ...m.main[0], unexpectedField: true }] }).success, false);
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
