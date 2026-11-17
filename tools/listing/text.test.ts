// 正式文案保存只重算其负责的校验，不能让 prepare-only 旧告警卡住续做，也不能清掉其他硬问题。
import assert from "node:assert/strict";
import { test } from "node:test";
import { SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import { problemsAfterTextSave, textProblems } from "./text.ts";
import { renameSpecs, type Specs, structureProblems } from "./variants.ts";

const clean = { title: "半封閉造型寵物貓窩 居家休息使用", description: "商品介紹\n半封閉貓窩，依所選款式出貨。" };
const specs = (): Specs => ({
	tiers: [{ source: "颜色", name: "款式", options: [{ source: "猫窝", name: "一二三四五六七八九十一二三四五六七八九十多" }] }],
	variants: [{ sku: "LT1-a", skuId: SkuId.parse("a"), specId: SpecId.parse("a"), options: [0], costRmb: 12, stock: 50, weightKg: 0.3, priceTwd: 149 }],
});

test("文案保存清除原文的采购话术及长度旧告警；已保存新文案后补存也能恢复", () => {
	const stale = [...textProblems("猫窝批发", ""), "标题 0 字，要 10–60 字"].join("\n");
	assert.equal(problemsAfterTextSave(stale, clean), null);
	assert.equal(problemsAfterTextSave(problemsAfterTextSave(stale, clean), clean), null);
});

test("显式修正过长规格名只替换重新验证过的结构问题，保留供货、图片、核价、类目及规格上限", () => {
	const before = specs();
	const renamed = renameSpecs(before, [{ name: "款式", options: ["灰色貓窩"] }]);
	assert.deepEqual(renamed.problems, []);
	const hard = [
		"货源：起订量 2，单件代发采购条件待核",
		"图：缺可用的主图（仅准备货源，待图片处理和审阅）",
		"核价：缺国内运费",
		"类目：不在本店允许的类目里",
		"规格：有货的规格 51 个，最多 50 个",
		"规格：款式来源对应待人工确认",
	];
	const stale = [...structureProblems(before), ...textProblems("猫窝批发", ""), ...hard].join("\n");
	assert.equal(problemsAfterTextSave(stale, clean, { before, after: renamed.specs! }), hard.join("\n"));
	assert.equal(problemsAfterTextSave(stale, clean), [...structureProblems(before), ...hard].join("\n"), "没改规格名时不清除规格告警");
});

test("仍然存在的文字和结构问题会重新加入，含人工补充的相似问题不当成自动告警删除", () => {
	const before = specs();
	const note = "有采购端、卖家话术：批发；人工说明不可删除";
	const invalid = { title: "批发", description: "" };
	const result = problemsAfterTextSave(note, invalid, { before, after: before });
	assert.equal(result, [note, ...textProblems(invalid.title, invalid.description), ...structureProblems(before)].join("\n"));
});
