import assert from "node:assert/strict";
import { test } from "node:test";
import { photoUrl, publishedDate } from "./api.ts";

test("笔记日期按台湾日期解析，跨年、午夜和编辑日期保持真实", () => {
	const now = new Date("2026-01-02T16:30:00Z");
	assert.equal(publishedDate("刚刚", now), "2026-01-03");
	assert.equal(publishedDate("2小时前 广东", now), "2026-01-02");
	assert.equal(publishedDate("昨天 12:18", now), "2026-01-02");
	assert.equal(publishedDate("12-29", now), "2025-12-29");
	assert.equal(publishedDate("2025-12-29 浙江", now), "2025-12-29");
	assert.equal(publishedDate("2026-02-30", now), null);
	assert.equal(publishedDate("编辑于 2025-12-29", now), null);
});

test("图片读取仅接受小红书图片域名和 HTTPS", () => {
	assert.equal(photoUrl("https://sns-webpic-qc.xhscdn.com/pic.jpg"), true);
	for (const url of ["http://www.xhscdn.com/a", "https://xhscdn.com.example.test/a", "https://user@xhscdn.com/a", "https://localhost/a"])
		assert.equal(photoUrl(url), false);
});
