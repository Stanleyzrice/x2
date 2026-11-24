import assert from "node:assert/strict";
import { test } from "node:test";
import { createStartGate, initialStrategy, mergeRuns, restoredResearch, runOutcome, runOutcomeDetail } from "./state.ts";
import type { RunStatus, RunSummary, StartInput } from "./types.ts";

const run = (status: RunStatus, overrides: Partial<RunSummary> = {}): RunSummary => ({
	id: "run-1",
	shop: "demo",
	strategyId: "peer-benchmark",
	strategyName: "竞品对标",
	limit: 3,
	brief: "",
	status,
	step: "",
	found: 0,
	createdAt: "2026-11-17T09:59:00Z",
	updatedAt: "2026-11-17T10:00:00Z",
	error: null,
	...overrides,
});
const input: StartInput = {
	strategyId: "rising-demand",
	limit: 3,
	brief: "",
	model: "deepseek-v4-pro",
	requestId: "7d6a1c9e-79d3-4f23-a4ab-3eeef6912301",
};

test("允许当前策略的直达链接，首次打开需要手动选择", () => {
	assert.equal(initialStrategy("?selectionStrategy=rising-demand", "peer-benchmark"), "rising-demand");
	assert.equal(initialStrategy("?selectionStrategy=old-product-extension", "unmet-needs"), "unmet-needs");
	assert.equal(initialStrategy("", null), null);
});

test("恢复未决提交时锁定原策略、模型和请求编号，也兼容升级前的记录", () => {
	const state = restoredResearch(JSON.stringify({ strategyId: "unmet-needs", pendingStart: input }));
	assert.deepEqual(state, { strategyId: input.strategyId, model: input.model, pendingStart: input });
	const { model: _model, ...old } = input;
	assert.deepEqual(restoredResearch(JSON.stringify({ pendingStart: old })).pendingStart, old);
	assert.equal(restoredResearch(JSON.stringify({ pendingStart: { ...input, model: "unsupported" } })).pendingStart, null);
	assert.equal(restoredResearch("broken").pendingStart, null);
});

test("重复点击及模型变更不能重发未决请求，确认拒绝后可以用新模型新建", () => {
	const gate = createStartGate(input);
	const makeId = () => "new-request";
	assert.deepEqual(gate.begin(input, makeId), input);
	assert.equal(gate.begin(input, makeId), null);
	gate.settle(false);
	assert.equal(gate.begin({ ...input, model: "deepseek-flash" }, makeId), null);
	assert.deepEqual(gate.begin(input, makeId), input);
	gate.settle(true);
	assert.equal(gate.begin({ ...input, model: "deepseek-flash" }, makeId)?.requestId, "new-request");
});

test("研究记录按达成名额、失败和待人工处理分类，执行中无需终态标签", () => {
	assert.equal(runOutcome(run("running")), null);
	assert.equal(runOutcome(run("completed", { found: 3 })), "成功");
	assert.equal(runOutcome(run("completed", { found: 2 })), "需要处理");
	assert.equal(runOutcome(run("completed", { found: 0, selected: 3 })), "成功");
	assert.equal(runOutcome(run("failed")), "失败");
	assert.equal(runOutcome(run("cancelled")), "失败");
	assert.equal(runOutcome(run("interrupted")), "需要处理");
	assert.equal(runOutcome(run("needs-human")), "需要处理");
});

test("历史列表只显示当前店铺，较旧的启动回执不会覆盖完成结果", () => {
	const completed = run("completed", { updatedAt: "2026-11-17T10:02:00Z" });
	assert.deepEqual(mergeRuns([completed, run("running", { id: "other", shop: "other" })], run("running"), "demo"), [completed]);
	assert.deepEqual(mergeRuns([completed], run("running", { updatedAt: completed.updatedAt }), "demo"), [completed]);
});

test("研究记录区分中途卡住和已结束但不足额，并展示原记录的原因", () => {
	assert.deepEqual(runOutcomeDetail(run("needs-human", { stoppedAtStep: "读取类目", error: "知虾的工作台没有类目树" })), {
		summary: "停在「读取类目」",
		reason: "知虾的工作台没有类目树",
		nextStep: "在已连接的浏览器打开知虾工作台，确认台湾站类目已加载，再开始选品。",
	});
	assert.deepEqual(runOutcomeDetail(run("completed", { found: 1, stopReason: "缺少购买线索" })), {
		summary: "已结束 · 新增备选 1／3 件",
		reason: "缺少购买线索",
		nextStep: "按记录补齐市场或货源证据后再开始选品。",
	});
	assert.equal(runOutcomeDetail(run("completed", { found: 0, selected: 2 }))?.summary, "已结束 · 已选 2／3 件");
	assert.equal(runOutcomeDetail(run("interrupted"))?.summary, "未记录停止步骤");
	assert.equal(
		runOutcomeDetail(run("needs-human", { stoppedAtStep: "寻找货源", error: "1688 要过滑块验证：在 cheeroutdoor 的浏览器里拉一下再重试" }))?.nextStep,
		"在该店铺连接的浏览器完成 1688 滑块验证，再重新开始选品。",
	);
	assert.equal(runOutcomeDetail(run("completed", { found: 3 })), null);
});
