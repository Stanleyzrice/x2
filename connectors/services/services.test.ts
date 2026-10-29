// 外部服务：认图、象寄的签名和结果对图
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect, mimeOf, sizeOf } from "./image/api.ts";
import { form, parse, sign } from "./xiangji/api.ts";

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

test("象寄：签名是 md5(时间_UserKey_ImgTransKey)；图片地址编码两次（带 & 的地址不散）", () => {
	assert.equal(sign("1700000000", "user", "trans"), "19d11f5e7c25b8e7d513fc82bc66c9b6");
	const urls = ["https://cbu01.alicdn.com/img/a.jpg?x=1&y=2", "https://cbu01.alicdn.com/img/b.jpg"];
	const body = form(urls, { userKey: "user", imgTransKey: "trans" }, 1_700_000_000_000);
	assert.equal(body.get("Sign"), "19d11f5e7c25b8e7d513fc82bc66c9b6");
	assert.equal(body.get("Urls"), urls.map(encodeURIComponent).join(","));
	assert.match(body.toString(), /Urls=https%253A%252F%252Fcbu01/);
	assert.equal(body.get("TargetLanguage"), "CHT");
});

test("象寄：结果按原图地址对（原样或解码后），不按位置；没回的、回了两次的不知道扣没扣钱", () => {
	const a = "https://cbu01.alicdn.com/img/a.jpg?x=1&y=2",
		b = "https://cbu01.alicdn.com/img/b.jpg",
		c = "https://cbu01.alicdn.com/img/c.jpg",
		d = "https://cbu01.alicdn.com/img/d.jpg";
	const r = parse([a, b, c, d], {
		Code: 200,
		Data: {
			Content: [
				{ Code: 200, OriginUrl: b, SslUrl: "https://i.tosoiot.com/b.jpg" },
				{ Code: 200, OriginUrl: encodeURIComponent(a), Url: "https://i.tosoiot.com/a.jpg" },
				{ Code: 500, OriginUrl: c, Message: "识别失败" },
			],
		},
	});
	assert.ok(r.kind === "done");
	assert.deepEqual(r.results, [
		{ origin: a, url: "https://i.tosoiot.com/a.jpg" },
		{ origin: b, url: "https://i.tosoiot.com/b.jpg" },
	]);
	assert.deepEqual(r.failed, [{ origin: c, why: "Code=500 识别失败" }]);
	assert.deepEqual(r.missing, [d]);
	const twice = parse([b], {
		Code: 200,
		Data: {
			Content: [
				{ Code: 200, OriginUrl: b, Url: "x" },
				{ Code: 200, OriginUrl: b, Url: "y" },
			],
		},
	});
	assert.ok(twice.kind === "done" && twice.missing.length === 1);
	assert.equal(parse([b], { Code: 401, Message: "签名错误" }).kind, "refused");
});
