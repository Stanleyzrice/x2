// 覆盖停用方法、研究提交重入、未知提交结果重试和轮询旧响应，避免自动开启额外研究。
import assert from "node:assert/strict";
import { test } from "node:test";
import { actions, inputs, props } from "./schema.ts";
import {
	canCancelRun,
	candidateLabel,
	candidateQueryEvidence,
	canRequestStart,
	createStartGate,
	currentStrategies,
	discardWorkflowDraft,
	initialStrategy,
	isTerminalRun,
	latestDetail,
	mergeRuns,
	moveWorkflowStep,
	pricingFacts,
	researchInput,
	restoredResearch,
	retryConditions,
	runOutcome,
	strategyCounts,
	workbenchStrategies,
	workflowChanged,
	workflowInput,
} from "./state.ts";
import type { RunDetail, RunStatus, Strategy, Workbench } from "./types.ts";

const run = (status: RunStatus = "running", updatedAt = "2026-11-17T10:00:00Z"): RunDetail => ({
	id: "run-1",
	shop: "cheeroutdoor",
	strategyId: "peer-benchmark",
	strategyName: "竞品对标",
	limit: 3,
	brief: "浴室收纳",
	status,
	step: "读取近期需求",
	found: 0,
	createdAt: "2026-11-17T09:59:00Z",
	updatedAt,
	error: null,
	cancelRequested: false,
	events: [],
	candidates: [],
});

test("策略组件固定当前新增店铺，不能从输入替换身份或调用发布", () => {
	assert.deepEqual(props.parse({ shop: "cheeroutdoor" }), { shop: "cheeroutdoor" });
	assert.equal(props.safeParse({ shop: "ni1206" }).success, false);
	assert.equal(props.safeParse({ shop: "cheeroutdoor", strategyId: "peer-benchmark" }).success, false);
	assert.deepEqual(Object.values(actions), [
		"selection.workbench",
		"selection.run-start",
		"selection.run-detail",
		"selection.run-cancel",
		"selection.run-delete",
		"selection.workflow-save",
		"selection.workflow-reset",
	]);
	assert.deepEqual(inputs, ["strategyId", "limit", "brief", "requestId", "runId", "steps"]);
});

test("五种当前方法可选，历史老品近亲不能再次启动", () => {
	const strategy = (id: string): Strategy => ({ id, name: id, description: "", steps: [], policyPath: "" });
	const values = ["peer-benchmark", "bestseller-accessories", "unmet-needs", "rising-demand", "bundle-sales"];
	assert.deepEqual(
		currentStrategies([strategy("old-product-extension"), strategy("地垫近亲"), ...values.map(strategy)]).map((value) => value.id),
		values,
	);
	assert.equal(researchInput("old-product-extension", "3", "").input, null);
	assert.equal(researchInput("爆品近亲", "3", "").input, null);
});

test("直达参数仅选择允许的方法，未知或缺少参数时恢复旧选择", () => {
	assert.equal(initialStrategy("?selectionStrategy=rising-demand", "peer-benchmark"), "rising-demand");
	assert.equal(initialStrategy("?selectionStrategy=unknown", "bundle-sales"), "bundle-sales");
	assert.equal(initialStrategy("?selectionStrategy=old-product-extension", "unmet-needs"), "unmet-needs");
	assert.equal(initialStrategy("", "bestseller-accessories"), "bestseller-accessories");
	assert.equal(initialStrategy("?selectionStrategy=", "bundle-sales"), "bundle-sales");
	assert.equal(initialStrategy("", "old-product-extension"), "peer-benchmark");
});

test("方法分类按接口返回计数，旧数据不根据策略名称猜测分类", () => {
	const strategy: Strategy = { id: "peer-benchmark", name: "竞品对标", description: "", steps: ["保留我的步骤"], policyPath: "" };
	assert.deepEqual(strategyCounts([strategy]), { discovery: 0, salesUnit: 0, uncategorized: 1, total: 1 });
	assert.deepEqual(
		strategyCounts([
			{ ...strategy, kind: "discovery" },
			{ ...strategy, id: "unmet-needs", kind: "discovery" },
			{ ...strategy, id: "bestseller-accessories", kind: "discovery" },
			{ ...strategy, id: "rising-demand", kind: "discovery" },
			{ ...strategy, id: "bundle-sales", kind: "sales-unit" },
			{ ...strategy, id: "old-product-extension", kind: "discovery" },
		]),
		{ discovery: 4, salesUnit: 1, uncategorized: 0, total: 5 },
	);
	assert.deepEqual(strategy.steps, ["保留我的步骤"]);
});

test("近期趋势攀升可提交、恢复待核对请求并保留历史研究选择", () => {
	const input = { strategyId: "rising-demand" as const, limit: 2, brief: "保暖需求", requestId: "7d6a1c9e-79d3-4f23-a4ab-3eeef6912301" };
	assert.deepEqual(researchInput(input.strategyId, "2", input.brief).input, { strategyId: input.strategyId, limit: 2, brief: input.brief });
	const restored = restoredResearch(JSON.stringify({ selectedRunId: "old-run", pendingStart: input }));
	assert.equal(restored.strategyId, "rising-demand");
	assert.equal(restored.selectedRunId, "old-run");
	assert.deepEqual(restored.pendingStart, input);
	assert.deepEqual(
		createStartGate(restored.pendingStart).begin(input, () => "unexpected-new-request"),
		input,
	);
	assert.deepEqual(retryConditions({ ...run("failed"), strategyId: "rising-demand" }), { strategyId: "rising-demand", limit: 3, brief: "浴室收纳" });
});

test("候选只能关联实际保存的查询事实，缺失引用继续标待补", () => {
	const candidate = {
		offerId: "1",
		url: "",
		title: "候选",
		sourceId: null,
		status: "rejected" as const,
		reason: "",
		evidence: "",
		problems: [],
		research: {
			purchaseTask: "整理",
			demandLevel: "purchase" as const,
			queryFactIndexes: [0, 2],
			comparableGroup: "同件数",
			deliverableDifference: "尺寸合适",
			differenceStatus: "hypothesis" as const,
			failureConditions: [],
			missing: ["适配尺寸"],
		},
	};
	const fact = {
		query: { keyword: "整理盒", sourceKeyword: "整理盒", categoryPath: [], role: "product" as const },
		observedAt: "2026-11-17T10:00:00Z",
		updateTime: null,
		words: [],
		items: [],
		competition: null,
		needs: null,
		errors: [],
		searchSignal: true,
		purchaseSignal: false,
		demandScope: "keyword-category-or-whole-listing" as const,
	};
	const events: RunDetail["events"] = [
		{ id: "query-1", step: "查询", message: "", at: fact.observedAt, data: { kind: "query", round: 1, queryFactIndex: 0, fact } },
	];
	assert.deepEqual(candidateQueryEvidence(candidate, events), { facts: [{ index: 0, fact }], missingIndexes: [2] });
	assert.deepEqual(candidate.research.missing, ["适配尺寸"]);
	assert.deepEqual(candidateQueryEvidence({ ...candidate, research: undefined }, events), { facts: [], missingIndexes: [] });
});

test("候选数量拒绝空值、小数和超界，研究方向以原文去首尾空白提交", () => {
	for (const limit of ["", "0", "11", "2.5", "Infinity", "abc"]) assert.equal(researchInput("unmet-needs", limit, "").input, null);
	assert.deepEqual(researchInput("unmet-needs", "3", "  窄缝收纳  ").input, { strategyId: "unmet-needs", limit: 3, brief: "窄缝收纳" });
	assert.equal(researchInput("unmet-needs", "3", "字".repeat(2001)).input, null);
});

test("连续点击只提交一次，结果未知时重试同一请求而不是新建研究", () => {
	const gate = createStartGate();
	const input = { strategyId: "bundle-sales" as const, limit: 3, brief: "出游整理" };
	let created = 0;
	const makeId = () => `request-${++created}`;
	const first = gate.begin(input, makeId);
	assert.equal(first?.requestId, "request-1");
	assert.equal(gate.begin(input, makeId), null);
	gate.settle(false);
	assert.equal(gate.begin({ ...input, brief: "另一个方向" }, makeId), null);
	assert.deepEqual(gate.begin(input, makeId), first);
	assert.equal(created, 1);
	gate.settle(true);
	assert.equal(gate.begin(input, makeId)?.requestId, "request-2");
});

test("历史列表只显示本店，较旧轮询不能覆盖已完成研究", () => {
	const completed = run("completed", "2026-11-17T10:05:00Z");
	const stale = run("running");
	assert.equal(mergeRuns([completed, { ...run(), id: "other", shop: "ni1206" }], stale, "cheeroutdoor")[0]?.status, "completed");
	assert.equal(mergeRuns([completed], stale, "cheeroutdoor").length, 1);
	assert.equal(latestDetail("run-1", stale, completed)?.status, "completed");
	assert.equal(latestDetail("new-run", completed), null);
	assert.equal(mergeRuns([completed], run("running", completed.updatedAt), "cheeroutdoor")[0]?.status, "completed");
	assert.equal(latestDetail("run-1", run("running", completed.updatedAt), completed)?.status, "completed");
});

test("重新打开页面恢复所选记录和未知启动请求，不自动发起新的研究", () => {
	const original = { strategyId: "bundle-sales", limit: 3, brief: "桌面整理", requestId: "7d6a1c9e-79d3-4f23-a4ab-3eeef6912301" };
	const saved = restoredResearch(
		JSON.stringify({ strategyId: "unmet-needs", limit: "8", brief: "修改中的草稿", selectedRunId: "run-1", pendingStart: original }),
	);
	assert.equal(saved.strategyId, "bundle-sales");
	assert.equal(saved.limit, "3");
	assert.equal(saved.brief, "桌面整理");
	assert.equal(saved.selectedRunId, "run-1");
	assert.deepEqual(saved.pendingStart, original);
	const gate = createStartGate(saved.pendingStart);
	assert.equal(gate.begin({ strategyId: "bundle-sales", limit: 3, brief: "桌面整理" }, () => "unexpected-new-request")?.requestId, original.requestId);
	assert.equal(restoredResearch('{"strategyId":"old-product-extension"}').strategyId, "peer-benchmark");
	assert.equal(restoredResearch("broken").pendingStart, null);
	assert.equal(restoredResearch(JSON.stringify({ pendingStart: { ...original, requestId: "invalid" } })).pendingStart, null);
});

test("仅未结束任务可停止，候选缺保存引用时不声称加入成功", () => {
	for (const status of ["queued", "running"] as const) assert.equal(canCancelRun(status), true);
	for (const status of ["needs-human", "completed", "failed", "cancelled", "interrupted"] as const) assert.equal(isTerminalRun(status), true);
	const candidate = {
		offerId: "1",
		url: "https://detail.1688.com/offer/1.html",
		title: "收纳袋",
		sourceId: null,
		status: "added" as const,
		reason: "",
		evidence: "",
		problems: [],
	};
	assert.equal(candidateLabel(candidate), "保存结果待核对");
	assert.equal(candidateLabel({ ...candidate, sourceId: "9" }), "已加入备选区");
});

test("已有活跃研究不创建新任务，未决请求即使暂时离线仍可核对", () => {
	assert.equal(canRequestStart(true, false, false, [run("running")]), false);
	assert.equal(canRequestStart(false, true, false, [run("running")]), true);
	assert.equal(canRequestStart(true, true, true, []), false);
	assert.equal(canRequestStart(true, false, false, [run("needs-human")]), true);
	assert.equal(canRequestStart(false, false, false, []), false);
});

test("仅显示明确的有限金额，不把未知核价内容作为原始数据展示", () => {
	assert.deepEqual(pricingFacts(null), []);
	assert.deepEqual(pricingFacts({ priceTwd: 169, profitRmb: null, totalCostRmb: Number.NaN, raw: "unknown" }), [{ label: "试算售价", value: "NT$169" }]);
});

test("自定义流程保留顺序，空步骤和超长步骤不能保存", () => {
	assert.deepEqual(workflowInput(["  查需求  ", "核对货源"]).steps, ["查需求", "核对货源"]);
	for (const steps of [[], [" "], ["字".repeat(1001)], Array.from({ length: 13 }, () => "步骤")]) assert.equal(workflowInput(steps).steps, null);
	assert.equal(workflowChanged(["查需求"], ["  查需求 "]), false);
	assert.equal(workflowChanged(["查需求", "找货源"], ["找货源", "查需求"]), true);
	assert.deepEqual(moveWorkflowStep(["甲", "乙", "丙"], 1, -1), ["乙", "甲", "丙"]);
	assert.deepEqual(moveWorkflowStep(["甲", "乙", "丙"], 1, 1), ["甲", "丙", "乙"]);
	assert.deepEqual(moveWorkflowStep(["甲", "乙"], 0, -1), ["甲", "乙"]);
});

test("研究结束区分零新增、数量不足和达到目标", () => {
	assert.equal(runOutcome(run("completed")), "未新增备选");
	assert.equal(runOutcome({ ...run("completed"), found: 2 }), "研究结束 · 数量不足");
	assert.equal(runOutcome({ ...run("completed"), found: 3 }), "已达新增目标");
	assert.equal(runOutcome(run("running")), "研究中");
});

test("失败条件载入不复用旧请求，仅允许当前方法且不启动运行中的研究", () => {
	const failed = { ...run("failed"), brief: "找一些睡衣方向的" };
	assert.deepEqual(retryConditions(failed), { strategyId: "peer-benchmark", limit: 3, brief: "找一些睡衣方向的" });
	assert.equal(retryConditions(run("running")), null);
	assert.equal(retryConditions(run("completed")), null);
	assert.equal(retryConditions({ ...failed, strategyId: "old-product-extension" }), null);
	assert.equal(retryConditions({ ...failed, limit: 20 }), null);
	assert.ok(!Object.hasOwn(retryConditions(failed)!, "requestId"));
});

test("保存回执只覆盖当前旧轮询，下一次服务端流程更新生效且不覆盖编辑草稿", () => {
	const strategy: Strategy = { id: "peer-benchmark", name: "竞品对标", description: "", steps: ["原步骤"], policyPath: "" };
	const previous: Workbench = { shop: "cheeroutdoor", strategies: [strategy], agent: { available: true, version: null, error: null }, runs: [] };
	const saved = { ...strategy, steps: ["本窗口保存的步骤"], isCustomized: true };
	const receipt = { basis: previous, values: { [strategy.id]: saved } };
	assert.deepEqual(workbenchStrategies(previous, receipt)[0]?.steps, saved.steps);
	const refreshed = { ...previous, strategies: [{ ...strategy, steps: ["另一窗口最新保存的步骤"] }] };
	const current = workbenchStrategies(refreshed, receipt)[0]!;
	assert.deepEqual(current.steps, ["另一窗口最新保存的步骤"]);
	const draft = ["尚未保存的研究重点"];
	assert.equal(workflowChanged(current.steps, draft), true);
	assert.deepEqual(draft, ["尚未保存的研究重点"]);
});

test("取消流程编辑只丢弃当前本地草稿，重新显示服务端保存步骤", () => {
	const savedSteps = ["已保存的步骤"];
	const drafts = { "peer-benchmark": ["尚未保存的改动"], "unmet-needs": ["另一个策略的草稿"] };
	const next = discardWorkflowDraft(drafts, "peer-benchmark");
	assert.deepEqual(next["peer-benchmark"] ?? savedSteps, ["已保存的步骤"]);
	assert.deepEqual(next["unmet-needs"], ["另一个策略的草稿"]);
	assert.deepEqual(drafts["peer-benchmark"], ["尚未保存的改动"]);
	assert.deepEqual(savedSteps, ["已保存的步骤"]);
});
