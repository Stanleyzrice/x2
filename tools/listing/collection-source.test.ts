// 策略只采集到既有备选：真实读取、复用日期、删除保护及研究记录均独立于商品稿。
import assert from "node:assert/strict";
import { test } from "node:test";
import { collectedSourceDecision, collectSource } from "./collection.ts";
import {
	type CollectedSourceResult,
	type CollectSourceInput,
	collectSourceParams,
	mergeSourceResearch,
	type SourceResearch,
	sourceProductSchema,
	sourceResearchPick,
} from "./source-data.ts";

const product = (overrides: Record<string, unknown> = {}) =>
	sourceProductSchema.parse({
		platform: "1688",
		sourceId: "123",
		url: "https://detail.1688.com/offer/123.html",
		title: "真实来源标题",
		images: ["https://example.com/original.jpg"],
		props: [],
		skus: [{ id: "s1", specId: "p1", name: "黑色", attrs: ["黑色"], price: 7, stock: 11, image: null, weightKg: 0.2 }],
		description: { text: "原始详情", images: [], blocks: [{ type: "text", text: "原始详情" }] },
		minQty: 1,
		freightRmb: 3,
		freeShipping: false,
		errors: [],
		...overrides,
	});
const research = (overrides: Partial<SourceResearch> = {}): SourceResearch => ({
	kind: "strategy-run",
	shop: "cheeroutdoor",
	runId: "run-1",
	strategyId: "peer",
	strategyName: "竞品对标",
	reason: "同用途存在近期需求",
	evidence: "https://shopee.tw/product/1/2；规格待补",
	recordedAt: "2026-11-17T08:00:00.000Z",
	...overrides,
});
const input = (): CollectSourceInput =>
	collectSourceParams.parse({
		shop: "cheeroutdoor",
		link: "https://detail.1688.com/offer/123.html?tracking=discarded",
		provenance: { runId: "run-1", strategyId: "peer", strategyName: "竞品对标", reason: "同用途存在近期需求", evidence: "竞品记录" },
	});
const result = (overrides: Partial<CollectedSourceResult> = {}): CollectedSourceResult => ({
	sourceId: "88",
	offerId: "123",
	title: "真实来源标题",
	status: "added",
	problems: [],
	sourceCapturedAt: "2026-11-17T08:00:00.000Z",
	reusedSnapshot: false,
	...overrides,
});

test("新候选逐件读取规范链接后才保存，研究依据不混进原始来源", async () => {
	const calls: string[] = [];
	const request = input();
	const original = product();
	const receipt = await collectSource(request, {
		existing: async () => null,
		read: async (url) => {
			calls.push(`read:${url}`);
			return original;
		},
		save: async (savedInput, source) => {
			calls.push("save");
			assert.deepEqual(savedInput.provenance, request.provenance);
			assert.deepEqual(source, original);
			assert.equal("provenance" in source, false);
			return result();
		},
	});
	assert.deepEqual(calls, ["read:https://detail.1688.com/offer/123.html", "save"]);
	assert.equal(receipt.sourceId, "88");
	assert.equal(receipt.offerId, "123");
});

test("已有成功来源不重读、不覆盖原文，返回原采集日期和复用标记", async () => {
	const cached = product();
	const capturedAt = "2026-11-10T08:00:00.000Z";
	const receipt = await collectSource(input(), {
		existing: async () => ({ snapshot: cached, deleted: false }),
		read: async () => {
			throw new Error("成功快照不应重读");
		},
		save: async (_request, source) => {
			assert.deepEqual(source, cached);
			return result({ status: "existing", sourceCapturedAt: capturedAt, reusedSnapshot: true });
		},
	});
	assert.equal(receipt.status, "existing");
	assert.equal(receipt.sourceCapturedAt, capturedAt);
	assert.equal(receipt.reusedSnapshot, true);
});

test("已删除来源拒绝自动恢复，既不重新读网站也不调用保存", async () => {
	assert.throws(() => collectedSourceDecision({ snapshot: product(), deleted: true }), /未自动恢复/);
	await assert.rejects(
		collectSource(input(), {
			existing: async () => ({ snapshot: product(), deleted: true }),
			read: async () => {
				throw new Error("不应读取");
			},
			save: async () => {
				throw new Error("不应保存");
			},
		}),
		/未自动恢复/,
	);
});

test("失败快照允许重新读取，但读取失败或编号不符时不保存假结果", async () => {
	const failed = product({ errors: ["详情读取失败"] });
	assert.equal(collectedSourceDecision({ snapshot: failed, deleted: false }), "read");
	for (const read of [
		async () => {
			throw new Error("需要人工验证");
		},
		async () => product({ sourceId: "456", url: "https://detail.1688.com/offer/456.html" }),
	]) {
		let saved = false;
		await assert.rejects(
			collectSource(input(), {
				existing: async () => ({ snapshot: failed, deleted: false }),
				read,
				save: async () => {
					saved = true;
					return result();
				},
			}),
			/需要人工验证|编号与本次来源不一致/,
		);
		assert.equal(saved, false);
	}
});

test("同运行同策略重复命中不覆盖已有研究，不同运行保留独立理由", () => {
	const original = research();
	assert.deepEqual(mergeSourceResearch([original], research({ reason: "重复请求不得改写第一条", recordedAt: "2026-11-17T09:00:00.000Z" })), [original]);
	const another = research({ runId: "run-2", reason: "另一轮研究" });
	assert.deepEqual(mergeSourceResearch([original], another), [original, another]);
});

test("新稿沿用本店最新研究归属，另一店研究不替换人工选择", () => {
	const records = [research(), research({ shop: "ni1206", strategyName: "细分需求", reason: "另店" })];
	assert.deepEqual(sourceResearchPick(records, "cheeroutdoor"), { strategy: "竞品对标", why: "同用途存在近期需求", evidence: records[0]!.evidence });
	assert.deepEqual(sourceResearchPick(records, "other"), { why: "人工采集选用", evidence: "" });
	assert.deepEqual(sourceResearchPick([...records, research({ runId: "run-2", strategyName: "组合销售" })], "cheeroutdoor").strategy, "组合销售");
});
