import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { runOp, type Site } from "../src/commands/site.ts";
import { Usage } from "../src/errors.ts";
import { byPage, day, get, ints, str } from "../src/site/op.ts";

// 一个假的站点：items 一页 2 行，共 5 行
const seen: unknown[] = [];
const fake: Site = {
	describe: "假的",
	ops: {
		items: byPage("一列东西", z.object({ shopId: str("店"), path: ints("路径").default([]) }), async (p, n) => {
			seen.push(p);
			const all = [1, 2, 3, 4, 5];
			return { rows: all.slice((n - 1) * 2, n * 2), more: n * 2 < all.length };
		}),
		when: get("时间", z.object({ start: day("开始"), end: day("结束", true) }), async (p) => p),
	},
};

const value = async (args: string[]) => {
	const r = await runOp("fake", fake, args);
	assert.ok("value" in r);
	return r.value;
};

test("list 默认翻到底，输出 { rows, next }", async () => {
	assert.deepEqual(await value(["items", "--shop-id", "7"]), { rows: [1, 2, 3, 4, 5], next: null });
});

test("--pages 只翻几页，next 能接着翻", async () => {
	const first = await value(["items", "--shop-id", "7", "--pages", "1"]) as { next: string };
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
	await assert.rejects(runOp("fake", fake, ["nope"]), Usage);
	await assert.rejects(runOp("fake", fake, ["items", "--shop-id", "7", "--color", "red"]), Usage);
	await assert.rejects(runOp("fake", fake, ["items"]), Usage);
	await assert.rejects(runOp("fake", fake, ["when", "--start", "2026-09-01", "--end", "2026-09-01", "--pages", "1"]), Usage);
	await assert.rejects(runOp("fake", fake, ["items", "--shop-id", "7", "--pages", "0"]), Usage);
});

test("--help 回帮助文本，列出参数", async () => {
	const r = await runOp("fake", fake, ["items", "--help"]);
	assert.ok("help" in r);
	assert.match(r.help, /--shop-id <string>\s+必填/);
	assert.match(r.help, /--path <1,2,…>\s+默认 \[\]/);
});
