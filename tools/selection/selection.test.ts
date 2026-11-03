// 选品：策略改了才加版本号、记改之前和改之后；改策略、记规矩、停规矩都要写为什么
import assert from "node:assert/strict";
import { test } from "node:test";
import { invoke, register } from "../../platform/tool.ts";
import { selection, strategyDiff } from "./index.ts";

const ok = (tool: string, p: object) => selection.tools[tool]!.params.safeParse(p).success;

test("x2 selection strategy-set：和现在一样的不算改；改了的记改之前、改之后；空的是清掉", () => {
	const old = { status: "试验中", bet: "搜得多、卖的少", how: "知虾热搜词", note: null };
	assert.deepEqual(strategyDiff(old, { status: "试验中" }), { before: {}, after: {} });
	assert.deepEqual(strategyDiff(old, { how: "热搜词，剔掉 NT$1 的", status: "使用中" }), {
		before: { status: "试验中", how: "知虾热搜词" },
		after: { status: "使用中", how: "热搜词，剔掉 NT$1 的" },
	});
	assert.deepEqual(strategyDiff({ ...old, note: "先试两周" }, { note: "" }), { before: { note: "先试两周" }, after: { note: null } });
	assert.deepEqual(strategyDiff(old, { note: "" }), { before: {}, after: {} });
});

test("x2 selection：改策略要 --why、至少改一样；记规矩、停规矩要 --why", () => {
	assert.equal(ok("strategy-set", { name: "搜索缺口", how: "换个选法" }), false);
	assert.equal(ok("strategy-set", { name: "搜索缺口", why: "没说改什么" }), false);
	assert.equal(ok("strategy-set", { name: "搜索缺口", how: "skills/selection/references/strategies.md", why: "方法引用" }), true);
	assert.equal(ok("rule-add", { rule: "起订量 1" }), false);
	assert.equal(ok("rule-add", { rule: "起订量 1", why: "不压货" }), true);
	assert.equal(ok("rule-retire", { id: "1" }), false);
});

test("策略记录只接受 skills 方法引用，不接受流程正文", () => {
	assert.equal(ok("strategy-set", { name: "搜索缺口", how: "先搜词再按价格筛选", why: "测试" }), false);
});

test("现行规则入口位于 skills，默认查询不读数据库规则", async () => {
	register(selection);
	assert.deepEqual(await invoke("selection.rule-list", {}), { source: "skills/selection/references/rules.md", history: [] });
});

test("旧规则写接口不能重新建立数据库中的现行规则", async () => {
	register(selection);
	await assert.rejects(invoke("selection.rule-add", { rule: "示例", why: "测试" }), /skills\/selection\/references\/rules\.md/);
	await assert.rejects(invoke("selection.rule-retire", { id: "1", why: "测试" }), /skills\/selection\/references\/rules\.md/);
});
