// 策略定义测试覆盖用户停用老品延伸、文档参数与详细步骤的唯一来源，避免旧方法悄悄恢复。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
	loadStrategyDefinitions,
	parsePolicyJson,
	parseWorkbenchPolicy,
	researchPolicyText,
	selectionStrategyId,
	strategyInstructions,
	withWorkflow,
	workflowStepsSchema,
} from "./definitions.ts";

test("模型规则输入保留完整现行限制和执行边界，不重复四种方法及上架长手册", async () => {
	const [workbench, rules, pricing] = await Promise.all([
		readFile(new URL("../../skills/selection/references/workbench.md", import.meta.url), "utf8"),
		readFile(new URL("../../skills/selection/references/rules.md", import.meta.url), "utf8"),
		readFile(new URL("../../skills/listing/references/pricing.md", import.meta.url), "utf8"),
	]);
	const template = { fx: 4.8, feeRate: 0.16, freightPerKgRmb: 10, labelFeeRmb: 1.5, minMargin: 0.2, maxMargin: 0.3 };
	const compact = researchPolicyText(workbench, rules, template);
	assert.ok(compact.includes(rules));
	assert.ok(compact.includes(strategyInstructions(workbench, "执行、停止与交付")));
	assert.ok(!compact.includes('"strategies"'));
	assert.ok(!compact.includes("## 竞品对标"));
	assert.ok(compact.includes(JSON.stringify(template)));
	assert.ok(compact.length < (workbench.length + rules.length + pricing.length) * 0.6);
});

test("工作台只提供现有四条与新增近期趋势流程并有完整执行步骤", async () => {
	const markdown = await readFile(new URL("../../skills/selection/references/workbench.md", import.meta.url), "utf8");
	const policy = parseWorkbenchPolicy(markdown);
	assert.deepEqual(
		policy.strategies.map((s) => s.name),
		["竞品对标", "爆款周边", "细分需求", "组合销售", "近期趋势攀升"],
	);
	assert.equal(policy.targetShop, "cheeroutdoor");
	assert.equal(policy.marketSiteId, 1);
	for (const strategy of policy.strategies) assert.ok(strategyInstructions(markdown, strategy.name).length > 100);
	assert.equal(selectionStrategyId.safeParse("old-product-extension").success, false);
	assert.equal(selectionStrategyId.safeParse("地垫近亲").success, false);
});

test("缺少方法或重复策略不能创建研究任务", async () => {
	const markdown = await readFile(new URL("../../skills/selection/references/workbench.md", import.meta.url), "utf8");
	const policy = parseWorkbenchPolicy(markdown);
	policy.strategies[1] = policy.strategies[0]!;
	assert.throws(() => parseWorkbenchPolicy(`\x60\x60\x60json\n${JSON.stringify(policy)}\n\x60\x60\x60`), /不能重复/);
	assert.throws(() => strategyInstructions("## 其他\n内容", "竞品对标"), /缺少详细/);
	assert.throws(() => parsePolicyJson("无参数"), /缺少运行参数/);
});

test("用户研究步骤只覆盖运行配置并保留规则；拒绝空步骤、过长或超量输入", async () => {
	const definition = (await loadStrategyDefinitions())[0]!;
	const previous = structuredClone(definition);
	const customized = withWorkflow(definition, ["  先研究长柄工具的实际收纳场景  ", "核对规格后记录未知"]);
	assert.deepEqual(customized.steps, ["先研究长柄工具的实际收纳场景", "核对规格后记录未知"]);
	assert.equal(customized.isCustomized, true);
	assert.equal(customized.instructions, definition.instructions);
	assert.equal(customized.policyPath, definition.policyPath);
	assert.deepEqual(definition, previous);
	assert.equal(withWorkflow(definition, undefined).isCustomized, false);
	for (const steps of [[], [" "], ["x".repeat(1001)], Array.from({ length: 13 }, () => "读取需求")])
		assert.equal(workflowStepsSchema.safeParse(steps).success, false);
});

test("方法区分四条商品发现与一条销售单位设计，具备购买理由、证据及停止条件", async () => {
	const markdown = await readFile(new URL("../../skills/selection/references/workbench.md", import.meta.url), "utf8");
	const policy = parseWorkbenchPolicy(markdown);
	assert.equal(policy.strategies.filter((strategy) => strategy.kind === "discovery").length, 4);
	assert.equal(policy.strategies.filter((strategy) => strategy.kind === "sales-unit").length, 1);
	assert.ok(policy.methodology.deferred.some((method) => method.name.includes("成交") && method.reason.includes("归因")));
	for (const strategy of policy.strategies) {
		assert.equal(strategy.researchVersion, 1);
		assert.ok(strategy.purchaseReason.length > 20);
		assert.ok(strategy.evidenceNeeded.length >= 3);
		assert.ok(strategy.rejectWhen.length >= 3);
		assert.ok(workflowStepsSchema.safeParse(strategy.steps).success);
	}
});

test("模型接收当前方法的购买理由和证据边界，自定义步骤不能删掉这些条件", async () => {
	for (const definition of await loadStrategyDefinitions()) {
		assert.ok(definition.instructions.includes(definition.purchaseReason));
		for (const requirement of [...definition.evidenceNeeded, ...definition.rejectWhen]) assert.ok(definition.instructions.includes(requirement));
		const custom = withWorkflow(definition, ["只研究一款有明确规格的来源"]);
		assert.equal(custom.instructions, definition.instructions);
		assert.equal(custom.researchVersion, 1);
		assert.deepEqual(custom.evidenceNeeded, definition.evidenceNeeded);
	}
});

test("缺少购买理由、所需证据或淘汰条件不能发布为完整研究方法", async () => {
	const markdown = await readFile(new URL("../../skills/selection/references/workbench.md", import.meta.url), "utf8");
	for (const patch of [{ purchaseReason: " " }, { evidenceNeeded: [] }, { rejectWhen: [] }]) {
		const policy = parseWorkbenchPolicy(markdown);
		Object.assign(policy.strategies[0]!, patch);
		assert.throws(() => parseWorkbenchPolicy(`\x60\x60\x60json\n${JSON.stringify(policy)}\n\x60\x60\x60`));
	}
});

test("趋势流程必须保存技能中的试行参数且自定义步骤不能去掉数据门槛", async () => {
	const definition = (await loadStrategyDefinitions()).find((s) => s.id === "rising-demand")!;
	assert.ok(definition);
	assert.deepEqual(definition.trend, {
		windowDays: 7,
		minPoints: 7,
		maxLagDays: 3,
		minGrowthRate: 0.2,
		minPreviousGrowthRate: 0.05,
		minRobustGrowthRate: 0.1,
		minBaselineMean: 10,
	});
	assert.deepEqual(withWorkflow(definition, ["先查毛帽"]).trend, definition.trend);
	const markdown = await readFile(new URL("../../skills/selection/references/workbench.md", import.meta.url), "utf8");
	const policy = parseWorkbenchPolicy(markdown);
	delete policy.strategies.find((s) => s.id === "rising-demand")!.trend;
	assert.throws(() => parseWorkbenchPolicy(`\x60\x60\x60json\n${JSON.stringify(policy)}\n\x60\x60\x60`));
});
