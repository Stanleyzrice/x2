import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Sql } from "../platform/db/index.ts";
import { type ToolTraceStep, withLocalTools, withToolTrace } from "../platform/mcp.ts";
import { register } from "../platform/tool.ts";
import { listingHermesTools, sourceHermesTool } from "../tools/listing/hermes.ts";
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
