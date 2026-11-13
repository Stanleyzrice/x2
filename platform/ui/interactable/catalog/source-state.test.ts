// 发布恢复只接受本次请求；备选删除和可上架选择独立，不把已发布商品再次上架。
import assert from "node:assert/strict";
import { test } from "node:test";
import { currentPublishResult, publishReceiptOf, publishUnresolved, sourceCanPublish, sourceCanSelect } from "./source-state.ts";
import type { SourceItem, SourceReceipt } from "./source-types.ts";

const requestId = "b824a5d1-6faa-41d0-8b7f-0761f50dec77";
const otherId = "53c95a7d-cce0-43c2-97d9-fbd81dd956fb";
const result = (id: string, state: SourceReceipt["state"]): SourceReceipt => ({ requestId: id, state, items: [] });

test("旧请求完成不能解除当前未知或正在执行的保护", () => {
	const unknown = { requestId, state: "unknown" as const };
	assert.equal(currentPublishResult(unknown, result(otherId, "completed")), null);
	assert.equal(publishUnresolved(unknown, result(otherId, "completed")), true);
	assert.equal(publishUnresolved({ requestId, state: "running" }, null), true);
	assert.equal(publishUnresolved(unknown, result(requestId, "completed")), false);
});

test("刷新恢复保留未知请求，损坏的本地内容不进入界面", () => {
	assert.deepEqual(publishReceiptOf(JSON.stringify({ requestId, state: "unknown", error: "读取失败" })), { requestId, state: "unknown", error: "读取失败" });
	assert.equal(publishReceiptOf("not-json"), null);
	assert.equal(publishReceiptOf(JSON.stringify({ requestId: "-".repeat(36), state: "unknown" })), null);
	assert.deepEqual(publishReceiptOf(JSON.stringify({ requestId, state: "completed", error: { invalid: true } })), { requestId, state: "completed" });
});

test("已上架商品可选择删除备选，发布选择仍独立排除它和未知商品", () => {
	const source = (id: string, status: SourceItem["status"], deletable: boolean): SourceItem => ({
		id,
		platform: "1688",
		sourceId: id,
		url: `https://detail.1688.com/offer/${id}.html`,
		title: `商品${id}`,
		image: null,
		skuCount: 1,
		capturedAt: "2026-11-13T12:00:00Z",
		errors: [],
		status,
		problems: [],
		listingId: null,
		productId: null,
		deletable,
		deleteProblem: deletable ? null : "正在发布",
	});
	const rows = [source("1", "listed", true), source("2", "ready", false), source("3", "unknown", false)];
	const selected = rows.filter(sourceCanSelect);
	assert.deepEqual(
		selected.map((row) => row.id),
		["1", "2"],
	);
	assert.deepEqual(
		selected.filter(sourceCanPublish).map((row) => row.id),
		["2"],
	);
	assert.deepEqual(
		selected.filter((row) => row.deletable).map((row) => row.id),
		["1"],
	);
});
