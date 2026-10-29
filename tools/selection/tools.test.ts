// 选品的工具（连库，test/db.ts）：策略的版本号和变更记录、选品规矩、添加货源时记下的选品理由和快照
import assert from "node:assert/strict";
import { test } from "node:test";
import { Usage } from "../../platform/errors.ts";
import { skip, sql, tool } from "../../test/db.ts";
import { listing as listingKit } from "../listing/index.ts";
import { selection } from "./index.ts";

const listing = (args: string[]) => tool(listingKit, args);
const strategy = ([sub, ...args]: string[]) => tool(selection, [`strategy-${sub}`, ...args]);
const rule = ([sub, ...args]: string[]) => tool(selection, [`rule-${sub}`, ...args]);

test("x2 selection strategy-*：add 是第 1 版；set 要 --why，每次改版本号加 1、变更记录记改之前和改之后；没变的不加", {
	skip,
}, async () => {
	const db = sql!;
	assert.deepEqual(await strategy(["add", "--name", "搜索缺口", "--bet", "搜得多、卖的少", "--how", "知虾热搜词", "--why", "先试"]), {
		name: "搜索缺口",
		version: 1,
		bet: "搜得多、卖的少",
		how: "知虾热搜词",
		status: "试验中",
	});
	await assert.rejects(strategy(["set", "--name", "搜索缺口", "--how", "换个选法"]), (e: Error) => e instanceof Usage && /--why/.test(e.message));
	await assert.rejects(strategy(["set", "--name", "搜索缺口", "--why", "没说改什么"]), Usage);
	const set = await strategy(["set", "--name", "搜索缺口", "--how", "热搜词，剔掉 NT$1 的", "--status", "使用中", "--why", "NT$1 的是客製化链接"]);
	assert.deepEqual([set.version, set.before, set.after], [2, { status: "试验中", how: "知虾热搜词" }, { status: "使用中", how: "热搜词，剔掉 NT$1 的" }]);
	assert.deepEqual(await strategy(["set", "--name", "搜索缺口", "--status", "使用中", "--why", "再说一遍"]), { name: "搜索缺口", version: 2, changed: false });
	const log = await strategy(["log", "--name", "搜索缺口"]);
	assert.deepEqual(
		log.changes.map((c: any) => [c.version, c.before, c.after, c.why]),
		[
			[1, null, { status: "试验中", bet: "搜得多、卖的少", how: "知虾热搜词" }, "先试"],
			[2, { status: "试验中", how: "知虾热搜词" }, { status: "使用中", how: "热搜词，剔掉 NT$1 的" }, "NT$1 的是客製化链接"],
		],
	);
	const list = await strategy(["list"]);
	assert.equal(list.find((r: any) => r.name === "搜索缺口").version, 2);
	const [row] = await db`select version, how, status from strategies where name = '搜索缺口'`;
	assert.deepEqual({ ...row }, { version: 2, how: "热搜词，剔掉 NT$1 的", status: "使用中" });
});

test("x2 selection rule-*：add、retire 要 --why；停用的不删，写结束时间和停用原因；list 默认只列在用的", { skip }, async () => {
	const db = sql!;
	await assert.rejects(rule(["add", "--rule", "起订量 1"]), Usage);
	const a = await rule(["add", "--rule", "1688 一件代发、48 小时发货、起订量 1", "--why", "不压货"]);
	const b = await rule(["add", "--rule", "售价不超过 NT$500", "--why", "先做低价"]);
	await assert.rejects(rule(["retire", "--id", b.id]), Usage);
	const retired = await rule(["retire", "--id", b.id, "--why", "限制太死"]);
	assert.deepEqual([retired.retire_why, Boolean(retired.ended_at)], ["限制太死", true]);
	await assert.rejects(rule(["retire", "--id", b.id, "--why", "再停一次"]), (e: Error) => e instanceof Usage && /已经停用/.test(e.message));
	assert.deepEqual(
		(await rule(["list"])).map((r: any) => r.id),
		[a.id],
	);
	assert.deepEqual(
		(await rule(["list", "--all"])).map((r: any) => [r.id, r.ended_at === null]),
		[
			[a.id, true],
			[b.id, false],
		],
	);
	const [kept] = await db`select rule, why, retire_why from selection_rules where id = ${b.id}`;
	assert.deepEqual({ ...kept }, { rule: "售价不超过 NT$500", why: "先做低价", retire_why: "限制太死" });
});

test("x2 listing add：按策略选的要 --why；记下选品理由、依据和当时的策略、在用的选品规矩；x2 listing why 补记", {
	skip,
}, async () => {
	const db = sql!;
	await strategy(["add", "--name", "季节", "--bet", "换季", "--how", "看月份"]);
	await strategy(["set", "--name", "季节", "--bet", "换季前一个月", "--why", "要提前"]);
	await db`update selection_rules set ended_at = now() where ended_at is null`;
	const [r1] = await db`insert into selection_rules (rule, why) values ('起订量 1', '不压货') returning id::text`;
	await db`insert into selection_rules (rule, why, ended_at) values ('停了的', '试试', now())`;
	await assert.rejects(
		listing(["add", "--shop", "cheeroutdoor", "--links", "901", "--strategy", "季节"]),
		(e: Error) => e instanceof Usage && /--why 必填/.test(e.message),
	);
	const added = await listing([
		"add",
		"--shop",
		"cheeroutdoor",
		"--links",
		"901,902",
		"--strategy",
		"季节",
		"--why",
		"冬天到了",
		"--evidence",
		"暖桌搜索量 2 万",
	]);
	assert.deepEqual(
		added.map((a: any) => [a.offerId, a.isNew, a.why, a.evidence]),
		[
			["901", true, "冬天到了", "暖桌搜索量 2 万"],
			["902", true, "冬天到了", "暖桌搜索量 2 万"],
		],
	);
	const [l] = await db`select strategy, pick_why, pick_evidence, pick_snapshot from listings where id = ${added[0].id}`;
	const { at, ...snap } = l!.pick_snapshot;
	assert.ok(Math.abs(Date.parse(at) - Date.now()) < 60_000);
	assert.deepEqual(snap, {
		backfilled: false,
		strategy: { name: "季节", version: 2, bet: "换季前一个月", how: "看月份", status: "试验中" },
		rules: [{ id: r1!.id, rule: "起订量 1" }],
	});
	await strategy(["set", "--name", "季节", "--how", "看节气", "--why", "更准"]);
	const [same] = await db`select pick_snapshot from listings where id = ${added[0].id}`;
	assert.equal(same!.pick_snapshot.strategy.version, 2);
	const again = await listing(["add", "--shop", "cheeroutdoor", "--links", "901", "--strategy", "季节", "--why", "另一个理由"]);
	assert.deepEqual([again[0].isNew, again[0].why], [false, "冬天到了"]);
	const human = await listing(["add", "--shop", "cheeroutdoor", "--links", "903"]);
	assert.deepEqual([human[0].why, human[0].snapshot.strategy.name], [null, "人选"]);

	const [old] = await db`insert into listings (shop, offer_id, strategy) values ('cheeroutdoor', '904', '季节') returning id::text`;
	await assert.rejects(listing(["why", "--id", old!.id]), Usage);
	const w = await listing(["why", "--id", old!.id, "--why", "补的理由", "--evidence", "当时的数据"]);
	assert.deepEqual(
		[w.why, w.evidence, w.backfilled, w.replaced, w.snapshot.backfilled, w.snapshot.strategy.version],
		["补的理由", "当时的数据", true, false, true, 3],
	);
	await assert.rejects(listing(["why", "--id", old!.id, "--why", "改一下"]), (e: Error) => e instanceof Usage && /--force/.test(e.message));
	const forced = await listing(["why", "--id", old!.id, "--why", "改一下", "--force"]);
	assert.deepEqual([forced.why, forced.evidence, forced.replaced, forced.backfilled, forced.snapshot.at], ["改一下", "当时的数据", true, false, w.snapshot.at]);
	const h = await listing(["why", "--id", human[0].id, "--why", "运营贴的"]);
	assert.deepEqual([h.backfilled, h.snapshot.backfilled, h.snapshot.at], [false, false, human[0].snapshot.at]);
});
