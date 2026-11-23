// 策略选品入口的装配契约：固定侧栏、四方法、明确请求及受限操作，不退化成临时提示词页面。
import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredWorkspaces, register } from "../platform/tool.ts";
import { actions, inputs, props } from "../platform/ui/interactable/selection/schema.ts";
import { defaultSelectionLimit, socialDiscoveryStrategy } from "../platform/ui/interactable/selection/types.ts";
import { actParams } from "../platform/web/pages.ts";
import { TOOLKITS } from "../x2.ts";

test("策略选品是位于人工采集前的固定工作区", () => {
	const workspace = TOOLKITS.find((kit) => kit.name === "selection")?.workspaces?.find((item) => item.key === "strategy-selection");
	assert.ok(workspace);
	assert.equal(workspace.title, "策略选品");
	assert.equal(workspace.component, "selection");
	assert.deepEqual(props.parse(workspace.props).shop, "cheeroutdoor");
	assert.ok(workspace.order! < TOOLKITS.find((kit) => kit.name === "listing")!.workspaces!.find((item) => item.key === "manual-collection")!.order!);
	assert.equal(props.safeParse({ shop: "" }).success, false);
});

test("首次设置把固定工作区绑定到新店，网页动作保留服务端绑定", (t) => {
	register(...TOOLKITS);
	const previous = process.env.X2_DEFAULT_SHOP;
	t.after(() => {
		if (previous === undefined) delete process.env.X2_DEFAULT_SHOP;
		else process.env.X2_DEFAULT_SHOP = previous;
	});
	process.env.X2_DEFAULT_SHOP = "new-shop";
	const workspaces = configuredWorkspaces();
	const selection = workspaces.find((workspace) => workspace.component === "selection")!;
	assert.equal(props.parse(selection.props).shop, "new-shop");
	assert.ok(workspaces.some((workspace) => workspace.key === "catalog-new-shop"));
	assert.deepEqual(actParams(selection.props, { shop: "old-shop", limit: 3 }, inputs).shop, "new-shop");
	assert.deepEqual(workspaces.find((workspace) => workspace.component === "procurement")?.props.shops, ["new-shop"]);
});

test("页面只调用选品运行工具，旧方法、缺请求编号和超量输入被拒", () => {
	const tools = TOOLKITS.find((kit) => kit.name === "selection")!.tools;
	for (const target of Object.values(actions)) assert.ok(tools[target.split(".")[1]!]);
	assert.ok(!Object.values(actions).some((value) => /publish|prepare|cart/.test(value)));
	assert.ok(!inputs.includes("shop"));
	const base = { shop: "cheeroutdoor", strategyId: "peer-benchmark", limit: 3, brief: "台面沥水垫", requestId: "d8c75f9d-13ef-4071-8dd4-5e8625cef514" };
	assert.equal(tools["run-start"]!.params.safeParse(base).success, true);
	assert.equal(tools["run-start"]!.params.safeParse({ ...base, strategyId: "old-product-extension" }).success, false);
	assert.equal(tools["run-start"]!.params.safeParse({ ...base, limit: 11 }).success, false);
	assert.equal(tools["run-start"]!.params.safeParse({ ...base, requestId: undefined }).success, false);
});

test("网页研究历史只读，旧的命令行删除仍绑定店铺和运行编号", () => {
	const tools = TOOLKITS.find((kit) => kit.name === "selection")!.tools;
	assert.ok(!Object.values(actions).includes("selection.run-delete"));
	const params = tools["run-delete"]!.params;
	const input = { shop: "cheeroutdoor", runId: "d8c75f9d-13ef-4071-8dd4-5e8625cef514" };
	assert.equal(params.safeParse(input).success, true);
	assert.equal(params.safeParse({ runId: input.runId }).success, false);
	assert.equal(params.safeParse({ ...input, runId: "invalid" }).success, false);
});

test("小红书策略可由工作台正常启动，默认十个，名额仍有上限", () => {
	const params = TOOLKITS.find((kit) => kit.name === "selection")!.tools["run-start"]!.params;
	const input = { shop: "cheeroutdoor", strategyId: socialDiscoveryStrategy, requestId: "d8c75f9d-13ef-4071-8dd4-5e8625cef514" };
	assert.equal(params.safeParse(input).success, true);
	assert.equal(params.safeParse({ ...input, limit: 11 }).success, false);
	assert.equal(defaultSelectionLimit(input.strategyId), 10);
	assert.equal(defaultSelectionLimit("peer-benchmark"), 3);
});
