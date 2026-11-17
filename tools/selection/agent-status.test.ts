// 状态接口只报告执行器是否可用，不能为读取状态启动研究或调用业务工具。
import assert from "node:assert/strict";
import { test } from "node:test";
import * as runs from "./runs.ts";

test("未装配时返回不可用，装配后只委托状态查询，不调用分析或业务工具", async () => {
	assert.equal(typeof runs.selectionAgentStatus, "function");
	assert.deepEqual(await runs.selectionAgentStatus(), { available: false, version: null, error: "选品研究执行服务尚未装配" });
	const expected = { available: true, version: "test-version", error: null };
	let statusCalls = 0;
	runs.setSelectionServices({
		agentStatus: async () => {
			statusCalls++;
			return expected;
		},
		ask: async () => assert.fail("读取状态不能启动分析"),
		callTool: async () => assert.fail("读取状态不能调用业务工具"),
	});
	assert.strictEqual(await runs.selectionAgentStatus(), expected);
	assert.equal(statusCalls, 1);
});
