// 单稿原图模式的参数、持久化选择和上传输入：不译图、不加水印，保留源图与规格映射。
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "../../connectors/services/image/api.ts";
import { SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import { originalImageUpload } from "./images.ts";
import { listing } from "./index.ts";
import { imageModeOf, type Pics } from "./pics.ts";
import { imageNames } from "./product.ts";
import type { Specs } from "./variants.ts";

test("listing make 显式接受original图片模式，不要求改店铺水印", () => {
	const params = listing.tools.make!.params;
	const parsed = params.safeParse({ ids: "1", imageMode: "original" });
	assert.equal(parsed.success, true);
	if (parsed.success) assert.equal(parsed.data.imageMode, "original");
	assert.equal(params.safeParse({ ids: "1", imageMode: "processed" }).success, true);
	assert.equal(params.safeParse({ ids: "1", imageMode: "unknown" }).success, false);
});

test("图片模式属于单稿：旧稿默认processed，重做沿用original，显式选择只覆盖本次输入", () => {
	const pics: Pics = { imageMode: "original", main: [], detail: [], options: [] };
	const before = structuredClone(pics);
	assert.equal(imageModeOf(undefined, undefined), "processed");
	assert.equal(imageModeOf(undefined, {}), "processed");
	assert.equal(imageModeOf(undefined, pics), "original");
	assert.equal(imageModeOf("processed", pics), "processed");
	assert.equal(imageModeOf("original", {}), "original");
	assert.deepEqual(pics, before);
});

test("原图上传输入逐字节保留PNG，不经过JPEG重编码或改变尺寸与SHA", () => {
	const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=", "base64");
	const base = inspect(bytes);
	const upload = originalImageUpload(base);
	assert.deepEqual(Buffer.from(upload.file.base64, "base64"), bytes);
	assert.equal(upload.file.mime, "image/png");
	assert.equal(upload.final, base.sha256);
	assert.deepEqual([upload.width, upload.height], [base.width, base.height]);
	assert.deepEqual(base.bytes, bytes);
});

test("原图规格按source URL对应，图片数组换序仍匹配原款式", () => {
	const red = "https://cbu01.alicdn.com/red.jpg";
	const blue = "https://cbu01.alicdn.com/blue.jpg";
	const pics: Pics = {
		imageMode: "original",
		main: [],
		detail: [],
		options: [
			{ from: blue, imageId: "blue-image" },
			{ from: red, imageId: "red-image" },
		],
	};
	const specs: Specs = {
		tiers: [
			{
				source: "颜色",
				name: "顏色",
				options: [
					{ source: "红色", name: "紅色", image: red },
					{ source: "蓝色", name: "藍色", image: blue },
				],
			},
		],
		variants: ["red", "blue"].map((id, i) => ({
			sku: id,
			skuId: SkuId.parse(id),
			specId: SpecId.parse(id),
			options: [i],
			costRmb: 10,
			stock: 1,
			weightKg: 1,
			priceTwd: 199,
		})),
	};
	const before = structuredClone(pics);
	assert.deepEqual(
		[...imageNames(pics, specs)],
		[
			["red-image", "规格图：紅色"],
			["blue-image", "规格图：藍色"],
		],
	);
	assert.deepEqual(pics, before);
});
