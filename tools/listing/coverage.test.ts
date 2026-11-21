import assert from "node:assert/strict";
import test from "node:test";
import { coverageBlock, coverageScope, saveCoverage } from "./coverage.ts";
import type { ListingRow } from "./row.ts";

const detail = ["https://img.example/overview.jpg", "https://img.example/size.jpg", "https://img.example/ad.jpg"];
const row = {
	offer: {
		offerId: "200",
		detail,
		skus: [
			{ skuId: "1", specId: "red", name: "紅色", stock: 12 },
			{ skuId: "2", specId: "blue", name: "藍色", stock: 10 },
			{ skuId: "3", specId: "green", name: "綠色", stock: 0 },
		],
	},
	images: {
		detail: [
			{ from: detail[0], imageId: "main-panel", width: 900, height: 900 },
			{ from: detail[1], imageId: "spec-panel", width: 900, height: 900 },
		],
	},
} as unknown as ListingRow;
const product = {
	variants: [{ skuId: "1", specId: "red", options: [0] }],
	tiers: [{ name: "款式", options: [{ name: "紅色", image: null }] }],
} as Parameters<typeof coverageScope>[1];
const manifest = {
	expectedScope: "",
	excludedSkus: [{ skuId: "2", reason: "仅红色为本批已经确认的款式" }],
	detail: [
		{ sourceUrl: detail[0]!, imageId: "main-panel" },
		{ sourceUrl: detail[1]!, imageId: "spec-panel" },
		{ sourceUrl: detail[2]!, reason: "供应商引流二维码，与货品无关" },
	],
	layoutEvidence: "逐张检查顺序、统一版面、手机端字号及尺寸信息。",
};

test("只审阅已提交内容时，仍会遗漏源在库SKU和有用的详情图", () => {
	assert.match(coverageBlock(row, product)!, /覆盖审阅/);
	const input = { ...manifest, expectedScope: coverageScope(row, product).expectedScope };
	assert.throws(() => saveCoverage(row, product, { ...input, excludedSkus: [] }), /藍色/);
	assert.throws(() => saveCoverage(row, product, { ...input, detail: [input.detail[0]!, input.detail[2]!] }), /size.jpg/);
	assert.throws(
		() => saveCoverage(row, product, { ...input, detail: [input.detail[0]!, { sourceUrl: detail[1]!, imageId: "missing" }, input.detail[2]!] }),
		/不存在的详情图/,
	);
	const reviewed = { ...row, coverage: saveCoverage(row, product, input) };
	assert.equal(coverageBlock(reviewed, product), null);
	assert.match(coverageBlock({ ...reviewed, removed_images: ["spec-panel"] }, product)!, /已变化/);
	assert.match(coverageBlock(reviewed, { ...product, variants: [] })!, /已变化/);
});
