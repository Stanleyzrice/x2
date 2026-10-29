// 命令行照注册表跑工具：翻页、参数、日期、用法不对、出错分类
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { needsHuman } from "../connectors/sites/shopee/seller.ts";
import { bySales30Day } from "../connectors/sites/zhixia/api.ts";
import { runTool } from "../platform/cli.ts";
import { Usage } from "../platform/errors.ts";
import { byPage, day, flag, get, ints, parseJson, str, type Toolkit } from "../platform/tool.ts";

// 一个假的站点：items 一页 2 行，共 5 行
const seen: unknown[] = [];
const fake: Toolkit = {
	name: "fake",
	title: "假的",
	kind: "site",
	tools: {
		items: byPage("一列东西", z.object({ shopId: str("店"), path: ints("路径").default([]) }), async (p, n) => {
			seen.push(p);
			const all = [1, 2, 3, 4, 5];
			return { rows: all.slice((n - 1) * 2, n * 2), more: n * 2 < all.length };
		}),
		when: get("时间", z.object({ start: day("开始"), end: day("结束", true) }), async (p) => p),
		note: get("开关和字", z.object({ why: str("理由"), force: flag("覆盖").default(false) }), async (p) => p),
		raw: get("JSON 参数", z.object({ query: z.preprocess(parseJson, z.record(z.string(), z.unknown())).default({}) }), async (p) => p),
	},
};

const value = async (args: string[]) => {
	const r = await runTool(fake, args);
	assert.ok("value" in r);
	return r.value;
};

test("list 默认翻到底，输出 { rows, next }", async () => {
	assert.deepEqual(await value(["items", "--shop-id", "7"]), { rows: [1, 2, 3, 4, 5], next: null });
});

test("--pages 只翻几页，next 能接着翻", async () => {
	const first = (await value(["items", "--shop-id", "7", "--pages", "1"])) as { next: string };
	assert.deepEqual(first, { rows: [1, 2], next: "2" });
	assert.deepEqual(await value(["items", "--shop-id", "7", "--cursor", first.next]), { rows: [3, 4, 5], next: null });
});

test("参数：--kebab-case 对上 camelCase，逗号分隔的转成数组", async () => {
	seen.length = 0;
	await value(["items", "--shop-id=7", "--path", "100629,100630", "--pages", "1"]);
	assert.deepEqual(seen, [{ shopId: "7", path: [100629, 100630] }]);
});

test("日期是台湾时间：开始是零点，结束是 23:59:59；秒数原样用", async () => {
	assert.deepEqual(await value(["when", "--start", "2026-09-01", "--end", "2026-09-01"]), { start: 1788192000, end: 1788278399 });
	assert.deepEqual(await value(["when", "--start", "1788192000", "--end", "1788278399"]), { start: 1788192000, end: 1788278399 });
});

test("用法不对是 Usage：没有的操作、没有的参数、缺必填、get 带 --pages", async () => {
	await assert.rejects(runTool(fake, ["nope"]), Usage);
	await assert.rejects(runTool(fake, ["items", "--shop-id", "7", "--color", "red"]), Usage);
	await assert.rejects(runTool(fake, ["items"]), Usage);
	await assert.rejects(runTool(fake, ["when", "--start", "2026-09-01", "--end", "2026-09-01", "--pages", "1"]), Usage);
	await assert.rejects(runTool(fake, ["items", "--shop-id", "7", "--pages", "0"]), Usage);
});

test("单独的 --名字 只算开关：字的参数没给值是 Usage，不当成字的 true", async () => {
	await assert.rejects(runTool(fake, ["note", "--why"]), (e: Error) => e instanceof Usage && /--why 后面要写值/.test(e.message));
	await assert.rejects(runTool(fake, ["note", "--why", "--force"]), (e: Error) => e instanceof Usage && /--why 后面要写值/.test(e.message));
	assert.deepEqual(await value(["note", "--why", "撞货", "--force"]), { why: "撞货", force: true });
	assert.deepEqual(await value(["note", "--why", "撞货"]), { why: "撞货", force: false });
});

test("--help 回帮助文本，列出参数", async () => {
	const r = await runTool(fake, ["items", "--help"]);
	assert.ok("help" in r);
	assert.match(r.help, /--shop-id <string>\s+必填/);
	assert.match(r.help, /--path <1,2,…>\s+默认 \[\]/);
});

test("Shopee 的 401、403、要验证算要人处理，别的出错不算", () => {
	assert.equal(needsHuman(403, { code: 1, message: "token not found" }), true);
	assert.equal(needsHuman(401, null), true);
	assert.equal(needsHuman(200, { error: 1, error_msg: "請輸入密碼" }), true);
	assert.equal(needsHuman(500, { code: 1, message: "server error" }), false);
	assert.equal(needsHuman(200, { code: 2, message: "invalid param" }), false);
});

test("知虾热词商品按 30 天销量从高到低排，没有销量的排最后", () => {
	const rows = [
		{ itemId: "1", itemDataList: [{ sales30Day: "7" }] },
		{ itemId: "2", itemDataList: [] },
		{ itemId: "3", itemDataList: [{ sales30Day: "99" }] },
	];
	assert.deepEqual(
		bySales30Day(rows).map((r) => r.itemId),
		["3", "1", "2"],
	);
});

test("JSON 参数：合法的转成对象，不合法的是 Usage（不是一般错误）", async () => {
	assert.deepEqual(await value(["raw", "--query", '{"a":1}']), { query: { a: 1 } });
	await assert.rejects(runTool(fake, ["raw", "--query", "{bad"]), Usage);
});
