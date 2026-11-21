import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseDate, compareProducts } from "./comparison.ts";
import type { DailyReport } from "./schema.ts";

test("日期按钮支持选两天、替换对比日和取消选择", () => {
	assert.deepEqual(chooseDate([], "16"), ["16"]);
	assert.deepEqual(chooseDate(["16"], "17"), ["16", "17"]);
	assert.deepEqual(chooseDate(["16", "17"], "18"), ["16", "18"]);
	assert.deepEqual(chooseDate(["16", "17"], "16"), ["17"]);
});

test("按商品编号对比，增量较高优先，缺报表与零访客分开", () => {
	const row = (id: string, visitors: number) => ({ id, name: id, visitors, search: 0, recommendation: 0 });
	const before: DailyReport = { date: "2026-11-16", rows: [row("a", 5), row("b", 0), row("d", 0), row("e", 1)] };
	const after: DailyReport = { date: "2026-11-17", rows: [row("a", 8), row("b", 2), row("c", 9), row("d", 0), row("e", 0)] };
	assert.deepEqual(
		compareProducts(before).map((x) => x.id),
		["a", "e"],
	);
	assert.deepEqual(
		compareProducts(before, after).map((x) => [x.id, x.change]),
		[
			["a", 3],
			["b", 2],
			["e", -1],
			["c", null],
		],
	);
});
