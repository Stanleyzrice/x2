// 象寄：签名、结果对图
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { form, parse, sign } from "./api.ts";

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

test("象寄（样本，照文档和 lilto 的记录写的）：编码过的原图地址对得上；没字的图是失败；结果样子变了报回包变了（可能扣了钱）", () => {
	const a = "https://cbu01.alicdn.com/img/a.jpg",
		b = "https://cbu01.alicdn.com/img/b.jpg";
	const raw: unknown = JSON.parse(readFileSync(new URL("./fixtures/translate.json", import.meta.url), "utf8"));
	const r = parse([a, b], raw);
	assert.equal(r.kind, "done");
	if (r.kind !== "done") return;
	assert.deepEqual(r.results, [{ origin: a, url: "https://i.tosoiot.com/a.jpg" }]);
	assert.deepEqual(r.failed, [{ origin: b, why: "Code=1002 图片无文字" }]);
	assert.throws(
		() => parse([a], { Code: 200, Data: { Content: [{ OriginUrl: 1 }] } }),
		/象寄 GetImageTranslateBatch 的回包变了：Data\.Content\[0\]\.OriginUrl/,
	);
});
