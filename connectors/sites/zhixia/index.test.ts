// 知虾读工具的站点参数与分页作用域：离线校验，不连接浏览器或外部站点。
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { NeedsHuman } from "../../../platform/errors.ts";
import { get, list } from "../../../platform/tool.ts";
import { siteContextOf } from "./api.ts";
import { withSiteInput, zhixia } from "./index.ts";

test("知虾所有读工具可要求站点，旧参数和不传站点的调用仍有效", async () => {
	for (const tool of Object.values(zhixia.tools)) {
		assert.equal(tool.kind, "read");
		assert.ok("expectedSiteId" in tool.params.shape);
	}
	assert.ok(zhixia.tools["hot-words"]!.params.safeParse({ path: [100] }).success);
	assert.ok(zhixia.tools["hot-words"]!.params.safeParse({ path: [100], expectedSiteId: 2 }).success);
	assert.equal(zhixia.tools.categories!.params.safeParse({ expectedSiteId: 0 }).success, false);
	assert.equal(zhixia.tools.context!.kind, "read");
	const tool = withSiteInput(get("只读测试", z.object({ siteId: z.number() }), async ({ siteId }) => siteContextOf({ siteId })));
	assert.ok("run" in tool);
	assert.deepEqual(await tool.run(tool.params.parse({ siteId: 7 }) as never), { siteId: 7, siteName: null });
	await assert.rejects(tool.run(tool.params.parse({ siteId: 7, expectedSiteId: 1 }) as never), NeedsHuman);
});

test("分页读取也受期望站点约束，技术输入不泄漏进原参数", async () => {
	const tool = withSiteInput(
		list("分页测试", z.object({ siteId: z.number() }), async (input, cursor) => {
			assert.equal("expectedSiteId" in input, false);
			return { rows: [siteContextOf({ siteId: input.siteId }), cursor], next: null };
		}),
	);
	assert.ok("page" in tool);
	assert.deepEqual(await tool.page(tool.params.parse({ siteId: 2, expectedSiteId: "2" }) as never, "next-page"), {
		rows: [{ siteId: 2, siteName: null }, "next-page"],
		next: null,
	});
	await assert.rejects(tool.page(tool.params.parse({ siteId: 2, expectedSiteId: 3 }) as never, null), NeedsHuman);
});
