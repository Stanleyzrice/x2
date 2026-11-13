// 窄详情图只在正式processed水印画布等比放大；原图、坏比例、缓存与大像素边界。
import assert from "node:assert/strict";
import { test } from "node:test";
import { detailImagePlan } from "./images.ts";
import type { Mark } from "./pics.ts";
import { detailFits } from "./product.ts";
import { markKey, watermarkCanvas } from "./watermark.ts";

const mark: Mark = { text: "本店", size: 64, opacity: 0.35, position: "center" };

/** 只替换DOM以观察画布尺寸和drawImage参数；不访问浏览器、服务或实际商品图。 */
async function canvasAt(width: number, height: number, minWidth = 0) {
	const previous = ["Image", "document"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
	const draw: unknown[][] = [];
	let created = 0;
	const canvas = {
		width: 0,
		height: 0,
		getContext: () => ({
			fillRect: () => {},
			drawImage: (...args: unknown[]) => draw.push(args),
			strokeText: () => {},
			fillText: () => {},
		}),
		toDataURL: (mime: string, quality: number) => {
			assert.equal(mime, "image/jpeg");
			assert.equal(quality, 0.92);
			return "data:image/jpeg;base64,YWJj";
		},
	};
	class SourceImage {
		naturalWidth = width;
		naturalHeight = height;
		onload: (() => void) | null = null;
		set src(value: string) {
			assert.equal(value, "data:source");
			queueMicrotask(() => this.onload?.());
		}
	}
	Object.defineProperty(globalThis, "Image", { configurable: true, value: SourceImage });
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			createElement: (tag: string) => {
				assert.equal(tag, "canvas");
				created++;
				return canvas;
			},
		},
	});
	try {
		const result = await watermarkCanvas("data:source", mark, minWidth);
		return { result, canvas, draw, created };
	} finally {
		for (const [name, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	}
}

test("600×800真详情在processed画布变700×933，全画面等比绘制，预筛与画布一致", async () => {
	const plan = detailImagePlan(600, 800, "processed");
	assert.deepEqual(plan, { minWidth: 700, width: 700, height: 933 });
	const actual = await canvasAt(600, 800, plan!.minWidth);
	assert.deepEqual([actual.canvas.width, actual.canvas.height], [plan!.width, plan!.height]);
	assert.equal(detailFits(actual.canvas.width, actual.canvas.height), true);
	assert.equal(actual.draw.length, 1);
	assert.equal(actual.draw[0]!.length, 5, "drawImage只用完整原图＋目标画布，无裁切坐标");
	assert.deepEqual(actual.draw[0]!.slice(1), [0, 0, 700, 933]);
	assert.deepEqual(actual.result, { base64: "YWJj" });
});

test("original仍拒600详情；主图默认不放大，已合规详情尺寸和旧缓存key保持", async () => {
	assert.equal(detailImagePlan(600, 800, "original"), null);
	assert.deepEqual(detailImagePlan(700, 933, "original"), { minWidth: 0, width: 700, height: 933 });
	assert.deepEqual(detailImagePlan(1200, 1600, "processed"), { minWidth: 0, width: 1200, height: 1600 });
	const main = await canvasAt(600, 800);
	assert.deepEqual([main.canvas.width, main.canvas.height], [600, 800]);
	assert.equal(markKey(mark), markKey(mark, 0));
	assert.equal(markKey(mark), '水印:1:["本店",64,0.35,"center"]');
	assert.notEqual(markKey(mark, 700), markKey(mark));
	assert.match(markKey(mark, 700), /minWidth=700$/);
});

test("占位图、原始坏比例和放大后仍过矮的详情不救；比例边界照实际整数尺寸判断", () => {
	for (const [width, height] of [
		[10, 20],
		[20, 10],
		[600, 1201],
		[600, 18],
		[600, 20],
	]) {
		assert.equal(detailImagePlan(width!, height!, "processed"), null, `${width}×${height}`);
	}
	assert.deepEqual(detailImagePlan(600, 1200, "processed"), { minWidth: 700, width: 700, height: 1400 });
	assert.deepEqual(detailImagePlan(640, 32, "processed"), { minWidth: 700, width: 700, height: 35 });
	assert.equal(detailImagePlan(1024, 32, "processed")?.minWidth, 0);
});

test("水印既有40百万像素上限同时约束原尺寸和放大成品，创建画布前拒绝", async () => {
	assert.equal(detailImagePlan(8000, 6000, "processed"), null);
	for (const [width, height, minWidth] of [
		[8000, 6000, 0],
		[600, 800, 10000],
	]) {
		const actual = await canvasAt(width!, height!, minWidth!);
		assert.equal("error" in actual.result, true);
		assert.equal(actual.created, 0);
		assert.equal(actual.draw.length, 0);
	}
});
