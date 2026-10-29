// 取图：认格式、量宽高
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect, mimeOf, sizeOf } from "./api.ts";

const png = (w: number, h: number) => {
	const b = new Uint8Array(33);
	b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
	new DataView(b.buffer).setUint32(16, w);
	new DataView(b.buffer).setUint32(20, h);
	return b;
};
// 最小的 JPEG 头：SOI、APP0（16 字节）、SOF0（高 300、宽 800）
const jpeg = new Uint8Array([
	0xff,
	0xd8,
	0xff,
	0xe0,
	0x00,
	0x10,
	...new Array(14).fill(0),
	0xff,
	0xc0,
	0x00,
	0x11,
	0x08,
	0x01,
	0x2c,
	0x03,
	0x20,
	0x03,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
	0,
]);
const webp = (w: number, h: number) => {
	const b = new Uint8Array(30);
	b.set(
		[..."RIFF"].map((c) => c.charCodeAt(0)),
		0,
	);
	b.set(
		[..."WEBPVP8X"].map((c) => c.charCodeAt(0)),
		8,
	);
	b.set([(w - 1) & 0xff, ((w - 1) >> 8) & 0xff, (w - 1) >> 16, (h - 1) & 0xff, ((h - 1) >> 8) & 0xff, (h - 1) >> 16], 24);
	return b;
};

test("认图：看文件头，不看扩展名；量宽高（PNG、JPEG、WebP）", () => {
	assert.equal(mimeOf(png(1, 1)), "image/png");
	assert.deepEqual(sizeOf(png(800, 600)), { width: 800, height: 600 });
	assert.equal(mimeOf(jpeg), "image/jpeg");
	assert.deepEqual(sizeOf(jpeg), { width: 800, height: 300 });
	assert.deepEqual(sizeOf(webp(1200, 700)), { width: 1200, height: 700 });
	assert.equal(mimeOf(new TextEncoder().encode("<html>")), null);
	assert.throws(() => inspect(new TextEncoder().encode("<html>"), "这张"), /不是 JPEG、PNG、WebP/);
	assert.equal(inspect(png(1, 1)).sha256.length, 64);
});
