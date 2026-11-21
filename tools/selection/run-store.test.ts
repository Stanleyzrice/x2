// 运行请求与结果的边界：同请求不重做、失去租约即停止、旧备选不冒充新增。
import assert from "node:assert/strict";
import { test } from "node:test";
import { runEventDataSchema } from "../../platform/ui/interactable/selection/contract.ts";
import { appendRunCandidate, type RunCandidate, runShouldStop, runSnapshot, sameRunInput } from "./run-store.ts";

const candidate = (overrides: Partial<RunCandidate> = {}): RunCandidate => ({
	offerId: "123",
	url: "https://detail.1688.com/offer/123.html",
	title: "原始来源标题",
	sourceId: "88",
	status: "added",
	reason: "近期存在同用途需求",
	evidence: "真实市场与货源记录",
	problems: [],
	...overrides,
});

test("同请求相同输入可复用，输入变化必须换请求编号", () => {
	assert.doesNotThrow(() => sameRunInput("shop/peer/2/窄台面", "shop/peer/2/窄台面"));
	assert.throws(() => sameRunInput("shop/peer/2/窄台面", "shop/niche/2/窄台面"), /requestId已用于另一组研究输入/);
});

test("仅持有活动租约且未取消的排队或运行任务可以继续", () => {
	for (const status of ["queued", "running"]) {
		assert.equal(runShouldStop({ status, cancel_requested: false, lease_active: true }), false);
		assert.equal(runShouldStop({ status, cancel_requested: true, lease_active: true }), true);
		assert.equal(runShouldStop({ status, cancel_requested: false, lease_active: false }), true);
	}
	for (const status of ["needs-human", "completed", "failed", "cancelled", "interrupted"]) {
		assert.equal(runShouldStop({ status, cancel_requested: false, lease_active: true }), true);
	}
	assert.equal(runShouldStop(null), true);
});

test("新增数仅统计本轮 added，已有和拒绝结果仍保留供核查", () => {
	const old = candidate({ offerId: "old", sourceId: "9", status: "existing" });
	const rejected = candidate({ offerId: "no", sourceId: null, status: "rejected", problems: ["一件代发未确认"] });
	const first = appendRunCandidate([old, rejected], candidate());
	assert.equal(first.found, 1);
	assert.deepEqual(
		first.candidates.map((item) => item.status),
		["existing", "rejected", "added"],
	);
	assert.deepEqual(first.candidates[1]?.problems, ["一件代发未确认"]);
});

test("重复回执不重复计数或改写首次理由，也不把 existing 升格为 added", () => {
	const original = candidate({ status: "existing", reason: "首次研究依据", evidence: "首次证据" });
	const retry = appendRunCandidate([original], candidate({ reason: "重试结果" }));
	assert.equal(retry.found, 0);
	assert.deepEqual(retry.candidates, [original]);
	assert.deepEqual(appendRunCandidate([candidate()], candidate()), { candidates: [candidate()], found: 1 });
});

test("未取得 offerId 的独立失败不互相吞掉，来源原始对象不被修改", () => {
	const previous = [candidate({ offerId: "", sourceId: null, status: "rejected", problems: ["第一条链接读取失败"] })];
	const copy = structuredClone(previous);
	const next = candidate({ offerId: "", sourceId: null, status: "rejected", problems: ["第二条链接读取失败"] });
	const result = appendRunCandidate(previous, next);
	assert.equal(result.candidates.length, 2);
	assert.equal(result.found, 0);
	assert.deepEqual(previous, copy);
	assert.notEqual(result.candidates, previous);
});

test("历史运行保留当次步骤和模型配置，缺少旧字段仍可读取", () => {
	assert.deepEqual(runSnapshot({}), {});
	assert.deepEqual(runSnapshot(null), {});
	assert.deepEqual(runSnapshot({ strategy: { steps: ["原步骤"] }, agent: { model: "gpt-6.1-sol", reasoningEffort: "medium" } }), {
		workflow: ["原步骤"],
		agent: { model: "gpt-6.1-sol", reasoningEffort: "medium" },
	});
	const split = appendRunCandidate([], candidate({ hardProblems: [], warnings: ["优惠待核，不可上架"] }));
	assert.deepEqual(split.candidates[0]?.warnings, ["优惠待核，不可上架"]);
	assert.deepEqual(split.candidates[0]?.hardProblems, []);
});

test("候选保留结构化研究与独立保存回执，历史候选不补造新版研究证据", () => {
	const research = {
		purchaseTask: "露营灯携带收纳",
		demandLevel: "unknown" as const,
		queryFactIndexes: [1],
		comparableGroup: "同尺寸、同件数的收纳袋，市场样本待补",
		deliverableDifference: "供应商标示尺寸，灯具实际适配仍待验证",
		differenceStatus: "hypothesis" as const,
		failureConditions: ["尺寸不兼容即排除"],
		missing: ["周边购买证据与适配实测"],
	};
	const receipt = { sourceId: "88", offerId: "123", status: "added" as const, sourceCapturedAt: "2026-11-17T02:00:00Z", reusedSnapshot: true };
	const saved = appendRunCandidate([], candidate({ research, receipt }));
	assert.deepEqual(saved.candidates[0]?.research, research);
	assert.deepEqual(saved.candidates[0]?.receipt, receipt);
	assert.equal(appendRunCandidate([], candidate()).candidates[0]?.research, undefined);
	assert.equal(appendRunCandidate([], candidate()).candidates[0]?.receipt, undefined);
});

test("结构化步骤核对与真实查询事实完整保存，不受事件短说明长度影响", () => {
	const data = {
		kind: "analysis",
		round: 1,
		batch: 1,
		summary: "短说明",
		audit: {
			steps: Array.from({ length: 10 }, (_, index) => ({
				stepIndex: index + 1,
				status: "partial",
				conclusion: `第${index + 1}步${"待补证据".repeat(20)}`,
				queryFactIndexes: [0],
				offerIds: ["123"],
				missing: ["保留未知"],
			})),
			stopReason: "后续无合理补查方向",
		},
		research: [],
	};
	const parsed = runEventDataSchema.parse(data);
	assert.deepEqual(parsed, data);
	assert.ok(JSON.stringify(parsed).length > 600);
	assert.equal(
		runEventDataSchema.safeParse({ ...data, audit: { ...data.audit, steps: [{ ...data.audit.steps[0], conclusion: "x".repeat(201) }] } }).success,
		false,
	);
});

test("趋势统计与原生词绑定保存，旧查询事实不补造时间序列", () => {
	const fact = {
		query: { keyword: "睡衣", sourceKeyword: "睡衣", categoryPath: [1], role: "product" },
		observedAt: "2026-11-18T00:00:00Z",
		updateTime: null,
		words: [],
		items: [],
		competition: null,
		needs: null,
		errors: [],
		searchSignal: null,
		purchaseSignal: null,
		demandScope: "keyword-category-or-whole-listing",
	};
	const old = runEventDataSchema.parse({ kind: "query", round: 1, queryFactIndex: 0, fact });
	assert.deepEqual(old, { kind: "query", round: 1, queryFactIndex: 0, fact });
	const trend = {
		wordId: 13192,
		word: "睡衣",
		metric: "sales",
		basis: "unknown",
		qualified: false,
		reasons: ["日值口径待核"],
		summary: { quality: { inputPoints: 30 }, limitations: ["未知不补零"] },
	};
	const current = runEventDataSchema.parse({ kind: "query", round: 1, queryFactIndex: 0, fact: { ...fact, trend } });
	if (current.kind !== "query") throw new Error("缺查询事实");
	assert.deepEqual(current.fact.trend, trend);
});
