import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Sql } from "../platform/db/index.ts";
import { localToolset, type ToolTraceStep, withLocalTools, withToolTrace } from "../platform/mcp.ts";
import { register } from "../platform/tool.ts";
import { strategyIds } from "../platform/ui/interactable/selection/types.ts";
import { listingHermesTools, sourceHermesTool } from "../tools/listing/hermes.ts";
import { chatSelectionTools } from "../tools/listing/hermes-selection.ts";
import { TOOLKITS } from "../x2.ts";

test("Hermes 启动须明确授权并限定单件试单", () => {
	const selected = { shop: "shop-a", sourceIds: "12,13" };
	assert.equal(sourceHermesTool.params.safeParse(selected).success, false);
	assert.equal(sourceHermesTool.params.safeParse({ ...selected, publish: false }).success, false);
	assert.equal(sourceHermesTool.params.safeParse({ ...selected, publish: true, trial: true }).success, false);
	assert.equal(sourceHermesTool.params.safeParse({ ...selected, sourceIds: "12", publish: "true", trial: "true" }).success, true);
});

test("本机 Hermes 工具口可实际调用 X2 并拒绝越权和重发未决写入", async () => {
	register(...TOOLKITS);
	const sql = Object.assign(async () => [{ id: "42", sourceId: "12", pending: ["99"] }], { array: () => [] }) as unknown as Sql;
	const { call, specifications } = listingHermesTools(sql, { shop: "shop-a", shopId: "111", sourceIds: ["12"], trial: false, batch: "test-batch" }, "fixture");
	const trace: ToolTraceStep[] = [];
	await withToolTrace(
		(step) => trace.push(step),
		() =>
			withLocalTools(specifications, call, async ({ url, token }) => {
				assert.equal((await fetch(url)).status, 403);
				const client = new Client({ name: "test-hermes", version: "1" });
				await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
				try {
					const { tools } = await client.listTools();
					assert.ok(tools.some((tool) => tool.name === "publish"));
					assert.ok(!tools.some((tool) => /shell|unlist|cart/.test(tool.name)));
					const rules = await client.callTool({ name: "read_rules", arguments: { document: "skills/listing/SKILL.md" } });
					assert.match(JSON.stringify(rules.content), /上架/);
					const escaped = await client.callTool({ name: "source_update", arguments: { sourceId: "13" } });
					assert.equal(escaped.isError, true);
					assert.match(JSON.stringify(escaped.content), /不在本次勾选范围/);
					const replay = await client.callTool({ name: "publish", arguments: { id: "42" } });
					assert.equal(replay.isError, true);
					assert.match(JSON.stringify(replay.content), /原写入待核对 99/);
					const otherShop = await client.callTool({ name: "publish", arguments: { id: "42", shop: "shop-b" } });
					assert.equal(otherShop.isError, true);
				} finally {
					await client.close();
				}
			}),
	);
	assert.deepEqual(
		trace.map(({ name, state }) => [name, state]),
		[
			["read_rules", "running"],
			["read_rules", "completed"],
			["source_update", "running"],
			["source_update", "failed"],
			["publish", "running"],
			["publish", "failed"],
			["publish", "running"],
			["publish", "failed"],
		],
	);
	assert.equal(trace[0]?.id, trace[1]?.id);
	assert.ok(trace.every((step) => Object.keys(step).length === 3));
});

test("x2bot 六种策略复用工作台工具，绑定店铺、模型和本轮请求，只回传结果摘要", async () => {
	const id = randomUUID();
	const turn = randomUUID();
	const calls: { tool: string; args: Record<string, unknown>; source?: string }[] = [];
	const record = {
		id,
		strategyName: "测试策略",
		status: "needs-human",
		step: "需要人工处理",
		stoppedAtStep: "寻找货源",
		error: "1688 需要人工验证",
		found: 1,
		limit: 2,
		candidates: [
			{
				title: "雨套",
				url: "https://example.test/item",
				sourceId: "7",
				offerId: "123",
				status: "added",
				reason: "已核对规格",
				evidence: "较长事实",
				problems: [],
			},
		],
		events: [
			{ step: "购买证据不足", message: "近30天缺少成交样本" },
			{ step: "工具事实", message: "完整的内部步骤" },
		],
	};
	const { call } = localToolset(
		chatSelectionTools("当前店", "deepseek-v4-pro", turn, "web", async (tool, args, source) => {
			calls.push({ tool, args, source });
			return tool === "selection.workbench" ? { strategies: strategyIds.map((id) => ({ id, name: id })), runs: [record] } : record;
		}),
	);
	await call("selection_workbench", {});
	assert.deepEqual(calls[0], { tool: "selection.workbench", args: { shop: "当前店" }, source: "web" });
	for (const strategyId of strategyIds) {
		await call("selection_start", { strategyId, limit: 2 });
		assert.deepEqual(calls.at(-1), {
			tool: "selection.run-start",
			args: { shop: "当前店", model: "deepseek-v4-pro", requestId: turn, strategyId, limit: 2 },
			source: "web",
		});
	}
	const result = await call("selection_result", { runId: id });
	assert.deepEqual(calls.at(-1), { tool: "selection.run-detail", args: { shop: "当前店", runId: id }, source: "web" });
	const content = JSON.stringify(result.content);
	for (const text of ["寻找货源", "1688 需要人工验证", "近30天缺少成交样本", "雨套", "sourceId", "需要处理", "停在「寻找货源」"])
		assert.ok(content.includes(text));
	assert.ok(!content.includes("完整的内部步骤"));
	const before = calls.length;
	await assert.rejects(() => call("selection_start", { shop: "其他店", strategyId: "unmet-needs" }));
	await assert.rejects(() => call("selection_start", { strategyId: "unmet-needs", requestId: randomUUID() }));
	await assert.rejects(() => call("selection_result", { shop: "其他店", runId: id }));
	assert.equal(calls.length, before);
});
