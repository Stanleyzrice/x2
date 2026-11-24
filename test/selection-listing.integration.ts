// 显式运行 node test/selection-listing.integration.ts：仅在独立空白临时库验证真实事务，不进入默认无数据库测试。
import "../platform/env.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { inspect } from "../connectors/services/image/api.ts";
import { OfferId, SkuId, SpecId } from "../connectors/sites/1688/api.ts";
import { ModelId } from "../connectors/sites/shopee/seller.ts";
import { client, type Sql } from "../platform/db/index.ts";
import { register } from "../platform/tool.ts";
import { deleteConversation, listConversations, readConversation, saveImportedConversation } from "../platform/web/hermes-history.ts";
import { makeContext } from "../tools/chat/context.ts";
import { inboxSnapshot, saveContext, saveInbox, threadSnapshot } from "../tools/chat/store.ts";
import { rollingWindow } from "../tools/chat/window.ts";
import { coverageScope, saveCoverage } from "../tools/listing/coverage.ts";
import { editImageTarget, editParams } from "../tools/listing/edit.ts";
import { listingHermesTools } from "../tools/listing/hermes.ts";
import {
	IMAGE_LANGUAGE_RULE_VERSION,
	imageLanguageBlock,
	imageLanguageSnapshot,
	saveImageLanguageReviews,
	variantImageTarget,
} from "../tools/listing/image-language.ts";
import { settingsOf } from "../tools/listing/pricing.ts";
import { productOf } from "../tools/listing/ready.ts";
import { previewListingReview, setListingReview } from "../tools/listing/review.ts";
import { reviewedImagesScope } from "../tools/listing/reviewed-images.ts";
import { ListingId, type ListingRow, type ShopSettingsRow } from "../tools/listing/row.ts";
import { sizeChartScope } from "../tools/listing/size-chart.ts";
import { saveCollectedSource } from "../tools/listing/source.ts";
import { type CollectSourceInput, sourceProductSchema } from "../tools/listing/source-data.ts";
import { translate, translationState } from "../tools/listing/translations.ts";
import { LISTING_WRITES } from "../tools/listing/writes.ts";
import { shopImageFlow, xiangjiImages, xiangjiImagesParams } from "../tools/listing/xiangji-images.ts";
import { listRecords, markAllReported, markReported } from "../tools/reimbursement/index.ts";
import { deleteRun, postgresRunStore, type RunCreation, type RunLease, type RunStore } from "../tools/selection/run-store.ts";
import { TOOLKITS } from "../x2.ts";

const product = (id: string, title = "测试原始货源") =>
	sourceProductSchema.parse({
		platform: "1688",
		sourceId: id,
		url: `https://detail.1688.com/offer/${id}.html`,
		title,
		images: ["https://example.com/fixture.jpg"],
		props: [],
		skus: [{ id: "sku-1", specId: "spec-1", name: "黑色", attrs: ["黑色"], price: 7, stock: 10, image: null, weightKg: 0.2 }],
		description: { text: "fixture 原文", images: [], blocks: [{ type: "text", text: "fixture 原文" }] },
		minQty: 1,
		freightRmb: 3,
		freeShipping: false,
		errors: [],
	});

const creation = (overrides: Partial<RunCreation> = {}): RunCreation => ({
	requestId: randomUUID(),
	fingerprint: "cheeroutdoor/niche/2/窄台面",
	shop: "cheeroutdoor",
	strategyId: "niche",
	strategyName: "集成测试策略",
	limit: 2,
	brief: "窄台面",
	config: {},
	...overrides,
});

const input = (runId: string, offerId: string): CollectSourceInput => ({
	shop: "cheeroutdoor",
	link: `https://detail.1688.com/offer/${offerId}.html`,
	provenance: { runId, strategyId: "niche", strategyName: "集成测试策略", reason: "细分用途待测", evidence: "集成测试 fixture，不是市场事实" },
});

async function waitForImportLock(sql: Sql): Promise<void> {
	const until = Date.now() + 5000;
	while (Date.now() < until) {
		const [row] = await sql<{ waiting: boolean }[]>`select exists (
			select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()
			and wait_event_type='Lock' and query like '%from selection_runs where id =%'
		) as waiting`;
		if (row?.waiting) return;
		await setTimeout(20);
	}
	assert.fail("货源导入未在运行行锁上等待，未验证到预期事务边界");
}

test("独立临时库：选品运行租约、幂等与货源导入事务", { timeout: 90000 }, async (t) => {
	const source = process.env.X2_DATABASE_URL;
	assert.ok(source, "请配置现有 X2_DATABASE_URL；测试仅用于创建和删除独立临时库");
	const name = `x2_selection_integration_${randomUUID().replaceAll("-", "")}`;
	const target = new URL(source);
	assert.notEqual(decodeURIComponent(target.pathname.slice(1)), name);
	target.pathname = `/${name}`;
	const admin = client(source, 1);
	const clients: Sql[] = [];
	const leases: RunLease[] = [];
	let created = false;
	try {
		await admin.unsafe(`create database "${name}"`);
		created = true;
		const sql = client(target.toString(), 4);
		const firstSql = client(target.toString(), 1);
		const secondSql = client(target.toString(), 1);
		clients.push(sql, firstSql, secondSql);
		const [database] = await sql<{ name: string }[]>`select current_database() as name`;
		assert.equal(database?.name, name, "只允许在本次创建的临时库里运行 fixture");
		for (const file of [
			"../platform/db/schema.sql",
			"../tools/selection/schema.sql",
			"../tools/listing/schema.sql",
			"../tools/chat/schema.sql",
			"../tools/reimbursement/schema.sql",
		]) {
			await sql.unsafe(await readFile(new URL(file, import.meta.url), "utf8"));
		}
		await sql`insert into strategies(name) values('集成测试策略')`;
		await t.test("全部报账跨页只标记筛选内的已付款订单，版本冲突整批回滚", async () => {
			await sql`insert into reimbursement_accounts(account_id,name) values ('A','A'),('B','B')`;
			await sql`insert into reimbursement_runs(id,status) values ('fixture','succeeded')`;
			const fact = {
				receipt: { originalMinor: "100", paidAt: "2026-11-10T03:00:00Z", revision: "fixture" },
				goodsMinor: "100",
				freightMinor: "0",
				discountMinor: "0",
				supplier: "测试",
				items: [],
			};
			await sql`insert into reimbursement_orders(account_id,order_id,fact,paid_at,captured_at,revision)
				select a, i::text, ${sql.json(fact)}, case when i=54 then null when i=53 then '2026-11-11'::date else '2026-11-10'::date end, now(), 'fixture'
				from unnest(array['A','B']) a cross join generate_series(1,54) i`;
			const query = { accounts: ["A"], search: "测试", paidFrom: "2026-11-10", paidTo: "2026-11-10", offset: 50 };
			const before = await listRecords(sql, query);
			assert.equal(before.pendingSummary.orderCount, 52);
			assert.equal(before.rows.length, 2);
			const params = { ...query, pendingVersion: before.pendingVersion };
			await markReported(sql, { account: "A", orderId: "1", reported: true, revision: 0 });
			await markReported(sql, { account: "A", orderId: "1", reported: false, revision: 1 });
			await assert.rejects(markAllReported(sql, params), /已变化/);
			const current = await listRecords(sql, query);
			assert.equal(current.pendingSummary.orderCount, 52);
			const verified = { ...params, pendingVersion: current.pendingVersion };
			const submissions = await Promise.allSettled([markAllReported(firstSql, verified), markAllReported(secondSql, verified)]);
			assert.deepEqual(
				submissions.flatMap((r) => (r.status === "fulfilled" ? [r.value.marked] : [])),
				[52],
			);
			assert.equal((await listRecords(sql, query)).pendingSummary.orderCount, 0);
			assert.equal((await listRecords(sql, { search: "", offset: 0 })).pendingSummary.orderCount, 54);
			assert.equal((await sql`select revision from reimbursement_marks where account_id='A' and order_id='1'`)[0]?.revision, 3);
		});

		await t.test("客服首页保留最新成功快照，消息预览只返回本店当前窗口", async () => {
			const shop = "cheeroutdoor";
			const [binding] = await sql<{ shop_id: string }[]>`select shop_id from shop_settings where shop = ${shop}`;
			const window = rollingWindow(7);
			const previous = rollingWindow(7, new Date(Date.parse(window.to) - 1000));
			const inbox = { shop, shopId: binding!.shop_id, window, capturedAt: window.to, rows: [], next: null, scope: "fixture" };
			assert.equal(await inboxSnapshot(sql, shop, window), null);
			await saveInbox(sql, inbox);
			await saveInbox(sql, { ...inbox, shopId: "other", next: "other-shop" });
			await saveInbox(sql, { ...inbox, window: previous, next: "older-page" });
			assert.deepEqual(await inboxSnapshot(sql, shop, window), inbox);
			assert.equal(await inboxSnapshot(sql, shop, rollingWindow(30)), null);

			const target = { shop, shopId: inbox.shopId, userId: "seller", conversationId: "thread", buyerId: "buyer", buyerName: "fixture" };
			const recent = { id: "2", sender: "buyer" as const, at: previous.to, text: "recent" };
			const messages = [{ ...recent, id: "1", at: previous.from, text: "expired" }, recent];
			await saveContext(sql, makeContext(target, messages, null, randomUUID(), new Date(previous.to), previous));
			await saveContext(sql, makeContext({ ...target, shopId: "other" }, [], null, randomUUID(), new Date(window.to), window));
			assert.deepEqual((await threadSnapshot(sql, shop, "thread", window))?.messages, [recent]);
			assert.equal(await threadSnapshot(sql, shop, "other-thread", window), null);
			assert.equal(await threadSnapshot(sql, shop, "thread", rollingWindow(30)), null);
		});
		await t.test("旧会话迁移可重复请求并恢复指定会话的原文和任务回执", async () => {
			const id = randomUUID(),
				previous = randomUUID();
			await sql`insert into hermes_web_runs (id,owner,kind,fingerprint,state,result) values (${previous},${randomUUID()},'chat','fixture','completed',${sql.json({ text: "旧任务的回复" })})`;
			const turns = [{ id: "user-fixture", role: "user" as const, content: "之前的消息" }];
			await Promise.all([
				saveImportedConversation(firstSql, { id, turns, runIds: [previous] }),
				saveImportedConversation(secondSql, { id, turns, runIds: [previous] }),
			]);
			assert.deepEqual(
				(await listConversations(secondSql)).map(({ title }) => title),
				["之前的消息"],
			);
			const record = await readConversation(secondSql, id, (row) => row);
			assert.deepEqual(
				record?.entries.filter((entry) => entry.role !== "task").map(({ content }) => content),
				["之前的消息", "旧任务的回复"],
			);
			assert.equal(await readConversation(secondSql, randomUUID(), (row) => row), null);
		});
		await t.test("删除会话清除正文、保留上架回执，并且已删除的编号不会被旧迁移复活", async () => {
			const id = randomUUID(),
				owner = randomUUID(),
				chat = randomUUID(),
				publish = randomUUID();
			const turns = [{ id: "user-delete", role: "user" as const, content: "需要删除的原文" }];
			await saveImportedConversation(sql, { id, turns, runIds: [] });
			await sql`insert into hermes_web_runs (id,owner,kind,fingerprint,state,conversation_id,message,result) values
				(${chat},${owner},'chat','chat-fixture','running',${id},'用户消息',null),
				(${publish},${owner},'publish','publish-fixture','completed',${id},'任务消息',${sql.json({ batch: "receipt" })})`;
			await assert.rejects(deleteConversation(firstSql, id, owner), /正在执行/);
			await sql`update hermes_web_runs set state='completed', result=${sql.json({ text: "聊天回复" })} where id=${chat}`;
			await deleteConversation(firstSql, id, owner);
			await deleteConversation(secondSql, id, owner);
			await saveImportedConversation(secondSql, { id, turns, runIds: [] });
			assert.equal(await readConversation(secondSql, id, (row) => row), null);
			assert.ok(!(await listConversations(secondSql)).some((entry) => entry.id === id));
			const [retained] = await sql`select result, message from hermes_web_runs where id=${publish}`;
			const [removed] = await sql`select result, message from hermes_web_runs where id=${chat}`;
			assert.deepEqual(retained, { result: { batch: "receipt" }, message: null });
			assert.deepEqual(removed, { result: null, message: null });
		});
		const first = postgresRunStore(firstSql);
		const second = postgresRunStore(secondSql);
		const request = creation();
		let active: RunLease | undefined;
		let owner: RunStore | undefined;
		let sourceId = "";

		await t.test("独立连接并发相同请求只建一轮，不同请求不能产生第二个活动任务", async () => {
			const opened = await Promise.all([first.open(request), second.open(request)]);
			leases.push(...opened);
			assert.equal(opened.filter((lease) => lease.created).length, 1);
			assert.equal(opened[0]!.run.id, opened[1]!.run.id);
			active = opened.find((lease) => lease.created)!;
			owner = opened[0]!.created ? first : second;
			await assert.rejects(second.open({ ...request, fingerprint: "changed-input" }), /另一组研究输入/);
			await assert.rejects((owner === first ? second : first).open(creation()), /已有选品研究/);
			const [row] = await sql<{ count: number }[]>`select count(*)::int as count from selection_runs where status in ('queued','running')`;
			assert.equal(row?.count, 1);
			assert.equal(await second.recover(), 0, "持有真实会话锁的任务不得被恢复逻辑误判");
			await owner.running(active.run.id);
			assert.equal(await owner.shouldStop(active.run.id), false);
			await assert.rejects(deleteRun(sql, request.shop, active.run.id), /研究仍在进行/);
		});
		assert.ok(active && owner);
		const runId = active.run.id;

		await t.test("真实保存重复来源复用原始快照日期并保留首次研究，不创建商品稿", async () => {
			const saved = await saveCollectedSource(sql, input(runId, "1001"), product("1001"));
			assert.equal(saved.status, "added");
			sourceId = saved.sourceId;
			const changed = input(runId, "1001");
			changed.provenance!.reason = "重复导入不得覆盖首次理由";
			const reused = await saveCollectedSource(sql, changed, product("1001", "不得覆盖的新标题"));
			assert.equal(reused.status, "existing");
			assert.equal(reused.sourceId, sourceId);
			assert.equal(reused.title, "测试原始货源");
			assert.equal(reused.sourceCapturedAt, saved.sourceCapturedAt);
			assert.equal(reused.reusedSnapshot, true);
			const [row] = await sql<{ research: { reason: string }[]; draft_count: number }[]>`
				select research,(select count(*)::int from listings) as draft_count from listing_sources where id=${sourceId}`;
			assert.equal(row?.research.length, 1);
			assert.equal(row?.research[0]?.reason, "细分用途待测");
			assert.equal(row?.draft_count, 0);
		});

		await t.test("并发重复回执只计一次 added，existing 与 rejected 只保留结果", async () => {
			const added = {
				offerId: "1001",
				url: product("1001").url,
				title: "测试原始货源",
				sourceId,
				status: "added" as const,
				reason: "需求",
				evidence: "fixture",
				problems: [],
			};
			await Promise.all([owner!.candidate(runId, added), owner!.candidate(runId, added)]);
			await owner!.candidate(runId, { ...added, offerId: "1002", status: "existing" });
			await owner!.candidate(runId, { ...added, offerId: "1003", sourceId: null, status: "rejected", problems: ["未确认供货"] });
			const detail = await owner!.get(runId);
			assert.equal(detail?.found, 1);
			assert.equal(detail?.candidates.length, 3);
		});

		await t.test("取消事务先取得行锁，迟到来源保存等待提交后拒绝且没有半条来源", async () => {
			let late: Promise<{ error: unknown }> | undefined;
			await sql.begin(async (tx) => {
				await tx`update selection_runs set cancel_requested=true where id=${runId}`;
				late = saveCollectedSource(sql, input(runId, "2001"), product("2001")).then(
					() => ({ error: null }),
					(error: unknown) => ({ error }),
				);
				await waitForImportLock(sql);
			});
			const result = await late!;
			assert.ok(result.error instanceof Error);
			assert.match(result.error.message, /运行已停止或不存在/);
			const [row] = await sql<{ count: number }[]>`select count(*)::int as count from listing_sources where source_id='2001'`;
			assert.equal(row?.count, 0);
			assert.equal(await owner!.shouldStop(runId), true);
			await owner!.finish(runId, "completed");
			assert.equal((await owner!.get(runId))?.status, "cancelled");
			await active!.release();
		});

		await t.test("历史研究删除按店铺限制，可重复提交且保留备选与原启动编号", async () => {
			await assert.rejects(deleteRun(sql, "ni1206", runId), /找不到可删除的研究记录/);
			assert.ok((await first.list(request.shop)).some((run) => run.id === runId));
			assert.deepEqual(await Promise.all([deleteRun(sql, request.shop, runId), deleteRun(sql, request.shop, runId)]), [{ id: runId }, { id: runId }]);
			assert.ok(!(await first.list(request.shop)).some((run) => run.id === runId));
			const receipt = await first.open(request);
			assert.equal(receipt.created, false);
			assert.equal(receipt.run.id, runId);
			assert.equal(receipt.run.deleted, true);
			const [source] = await sql<{ deleted_at: Date | null; research: { runId: string }[] }[]>`
				select deleted_at, research from listing_sources where id=${sourceId}`;
			assert.equal(source?.deleted_at, null);
			assert.equal(source?.research[0]?.runId, runId);
		});

		await t.test("已删除来源不恢复，既有人工稿的归属与人工字段也不改", async () => {
			const lease = await first.open(creation());
			leases.push(lease);
			await first.running(lease.run.id);
			await sql`insert into listings(shop,offer_id,strategy,title,pick_why,source_product_id)
				values('cheeroutdoor','1001','人选','人工标题','人工理由',${sourceId})`;
			await sql`update listing_sources set deleted_at=now() where id=${sourceId}`;
			await assert.rejects(saveCollectedSource(sql, input(lease.run.id, "1001"), product("1001")), /采集期间已删除/);
			const [row] = await sql<{ deleted: boolean; research_count: number; title: string; strategy: string; pick_why: string }[]>`
				select s.deleted_at is not null as deleted,jsonb_array_length(s.research) as research_count,l.title,l.strategy,l.pick_why
				from listing_sources s join listings l on l.source_product_id=s.id where s.id=${sourceId}`;
			assert.deepEqual(row, { deleted: true, research_count: 1, title: "人工标题", strategy: "人选", pick_why: "人工理由" });
			await first.finish(lease.run.id, "completed");
			await lease.release();
		});

		await t.test("丢失会话租约后标为中断，同请求不自动重跑，新请求可重新启动", async () => {
			const abandonedRequest = creation();
			const abandoned = await first.open(abandonedRequest);
			leases.push(abandoned);
			await first.running(abandoned.run.id);
			await first.event(abandoned.run.id, "读取类目", "读取真实类目路径");
			await abandoned.release();
			assert.equal(await second.shouldStop(abandoned.run.id), true);
			assert.equal(await second.recover(), 1);
			const repeated = await second.open(abandonedRequest);
			assert.equal(repeated.created, false);
			assert.equal(repeated.run.status, "interrupted");
			assert.equal(repeated.run.stoppedAtStep, "读取类目");
			const fresh = await second.open(creation());
			leases.push(fresh);
			assert.equal(fresh.created, true);
			await second.finish(fresh.run.id, "completed");
			await fresh.release();
		});

		await t.test("列表从历史事件读取实际停止步骤和不足额的原因", async () => {
			const blocked = await first.open(creation());
			leases.push(blocked);
			await first.event(blocked.run.id, "读取类目", "读取真实类目路径");
			await first.event(blocked.run.id, "工具读取受限", "未取得类目树");
			await first.event(blocked.run.id, "停止原因", "未取得类目树", { kind: "stop", reason: "未取得类目树", added: 0, existing: 0 });
			await first.finish(blocked.run.id, "needs-human", "未取得类目树");
			await blocked.release();

			const short = await first.open(creation());
			leases.push(short);
			await first.event(short.run.id, "停止补充", "研究计划重复已执行的采购查询", {
				kind: "stop",
				reason: "研究计划重复已执行的采购查询",
				added: 0,
				existing: 0,
			});
			await first.event(short.run.id, "完成", "已完成有界补查，名额不足", { kind: "stop", reason: "已完成有界补查，名额不足", added: 0, existing: 0 });
			await first.finish(short.run.id, "completed");
			await short.release();

			const runs = await first.list(request.shop);
			assert.equal(runs.find((run) => run.id === blocked.run.id)?.stoppedAtStep, "读取类目");
			assert.equal(runs.find((run) => run.id === short.run.id)?.stopReason, "研究计划重复已执行的采购查询");
		});
		await t.test("收费译图先存提交意图，未知回执在另一连接重做时不再发请求", async () => {
			const item = { sha: "translation-unknown", url: "https://example.test/unknown.png" };
			await sql`insert into images(sha256,kind,source) values(${item.sha},'原图',${item.url})`;
			let calls = 0;
			const submit = async () => {
				calls++;
				const [row] = await secondSql<{ status: string | null }[]>`
					select checks->'译图'->>'status' as status from images where sha256=${item.sha}`;
				assert.equal(row?.status, "submitted", "收费请求发出前，另一连接须已经能读到提交意图");
				return { kind: "unknown" as const, why: "fixture timeout" };
			};
			await assert.rejects(translate(firstSql, [item], { submit }), /结果未知/);
			await translate(secondSql, [item], { submit });
			assert.equal(calls, 1);
			assert.match((await translationState(sql, [item.sha])).get(item.sha)?.failed ?? "", /结果未知/);
		});

		await t.test("独立连接并发译同一张图只发一次，回执取图失败也复用已返回的地址", async () => {
			const item = { sha: "translation-concurrent", url: "https://example.test/concurrent.png" };
			await sql`insert into images(sha256,kind,source) values(${item.sha},'原图',${item.url})`;
			const entered = Promise.withResolvers<void>(),
				respond = Promise.withResolvers<void>();
			let calls = 0;
			const pending = translate(firstSql, [item], {
				submit: async () => {
					calls++;
					entered.resolve();
					await respond.promise;
					return { kind: "done", data: { kind: "done", results: [{ origin: item.url, url: "https://example.test/translated.png" }], failed: [], missing: [] } };
				},
				save: async () => {
					throw new Error("fixture CDN unavailable");
				},
			});
			try {
				await entered.promise;
				await translate(secondSql, [item], { submit: async () => assert.fail("并发者不能重新收费提交") });
			} finally {
				respond.resolve();
				await pending;
			}
			await translate(secondSql, [item], { submit: async () => assert.fail("取译图失败不能重新收费提交") });
			assert.equal(calls, 1);
			const state = (await translationState(sql, [item.sha])).get(item.sha);
			assert.equal(state?.url, "https://example.test/translated.png");
			assert.equal(state?.saved, false);
			assert.equal(state?.retryable, false);
		});

		await t.test("部分回执逐张保留，明确失败可安全重试，missing不重交", async () => {
			const items = ["done", "failed", "missing"].map((kind) => ({ sha: `translation-partial-${kind}`, url: `https://example.test/partial-${kind}.png` }));
			for (const item of items) await sql`insert into images(sha256,kind,source) values(${item.sha},'原图',${item.url})`;
			const saved: string[] = [];
			await translate(firstSql, items, {
				submit: async () => ({
					kind: "done",
					data: {
						kind: "done",
						results: [{ origin: items[0]!.url, url: "https://example.test/done.png" }],
						failed: [{ origin: items[1]!.url, why: "Code=400 没有翻译且未扣费" }],
						missing: [items[2]!.url],
					},
				}),
				save: async (_db, sha) => {
					saved.push(sha);
				},
			});
			const states = await translationState(
				sql,
				items.map((item) => item.sha),
			);
			assert.equal(states.get(items[0]!.sha)?.retryable, false);
			assert.equal(states.get(items[1]!.sha)?.retryable, true);
			assert.equal(states.get(items[2]!.sha)?.retryable, false);
			assert.match(states.get(items[2]!.sha)?.failed ?? "", /结果未知/);
			await translate(secondSql, items, {
				submit: async ({ urls }) => {
					assert.deepEqual(urls, [items[1]!.url]);
					return { kind: "done", data: { kind: "done", results: [{ origin: urls[0]!, url: "https://example.test/recovered.png" }], failed: [], missing: [] } };
				},
				save: async (_db, sha) => {
					saved.push(sha);
				},
			});
			assert.deepEqual(saved, [items[0]!.sha, items[1]!.sha]);
			assert.equal((await translationState(sql, [items[1]!.sha])).get(items[1]!.sha)?.retryable, false);
		});

		await t.test("回包解析异常仍保留未知提交，整批不能通过重做再次收费", async () => {
			const item = { sha: "translation-invalid-reply", url: "https://example.test/invalid-reply.png" };
			await sql`insert into images(sha256,kind,source) values(${item.sha},'原图',${item.url})`;
			await assert.rejects(translate(firstSql, [item], { submit: async () => ({ kind: "done", data: { unexpected: true } }) }));
			await translate(secondSql, [item], { submit: async () => assert.fail("解析失败后不能重新收费提交") });
			const [row] = await sql<{ status: string }[]>`select checks->'译图'->>'status' as status from images where sha256=${item.sha}`;
			assert.equal(row?.status, "unknown");
		});

		await t.test("明确拒绝及历史明确失败仍能安全重试，历史成功地址不会重交", async () => {
			const items = ["refused", "legacy-failed", "legacy-done"].map((kind) => ({ sha: `translation-${kind}`, url: `https://example.test/${kind}.png` }));
			for (const item of items) await sql`insert into images(sha256,kind,source) values(${item.sha},'原图',${item.url})`;
			await sql`update images set checks=${sql.json({ 译图: { failed: "Code=400 没翻译", at: new Date().toISOString() } })} where sha256=${items[1]!.sha}`;
			await sql`update images set checks=${sql.json({ 译图: { url: "https://example.test/legacy-done-result.png", at: new Date().toISOString() } })} where sha256=${items[2]!.sha}`;
			await assert.rejects(translate(firstSql, [items[0]!], { submit: async () => ({ kind: "refused", why: "明确拒绝，没有翻译" }) }), /明确拒绝/);
			const states = await translationState(
				sql,
				items.map((item) => item.sha),
			);
			assert.equal(states.get(items[0]!.sha)?.retryable, true);
			assert.equal(states.get(items[1]!.sha)?.retryable, true);
			assert.equal(states.get(items[2]!.sha)?.retryable, false);
			await translate(secondSql, items, {
				submit: async ({ urls }) => {
					assert.deepEqual(
						urls,
						items.slice(0, 2).map((item) => item.url),
					);
					return {
						kind: "done",
						data: { kind: "done", results: urls.map((origin) => ({ origin, url: "https://example.test/retried.png" })), failed: [], missing: [] },
					};
				},
				save: async () => {},
			});
		});

		await t.test("真实执行进程被终止后提交中意图仍在，后续进程不能重交", { timeout: 10000 }, async () => {
			const item = { sha: "translation-interrupted", url: "https://example.test/interrupted.png" };
			await sql`insert into images(sha256,kind,source) values(${item.sha},'原图',${item.url})`;
			const child = spawn(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`import { client } from './platform/db/index.ts';
import { translate } from './tools/listing/translations.ts';
const sql = client(process.env.X2_DATABASE_URL, 1);
await translate(sql, ${JSON.stringify([item])}, { submit: async () => {
  process.stdout.write('submitted\\n');
  return await new Promise(() => {});
}});`,
				],
				{
					cwd: new URL("../", import.meta.url),
					env: { ...process.env, X2_DATABASE_URL: target.toString(), X2_DATABASE_SSH: "" },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			const closed = once(child, "close");
			try {
				const [output] = await once(child.stdout, "data", { signal: AbortSignal.timeout(5000) });
				assert.match(String(output), /submitted/);
			} finally {
				child.kill("SIGKILL");
				await closed;
			}
			const [row] = await sql<{ status: string }[]>`select checks->'译图'->>'status' as status from images where sha256=${item.sha}`;
			assert.equal(row?.status, "submitted");
			await translate(secondSql, [item], { submit: async () => assert.fail("执行进程中断后不能重新收费提交") });
			assert.equal((await translationState(sql, [item.sha])).get(item.sha)?.retryable, false);
		});

		await t.test("提交意图无法持久化时绝不调用收费接口", async () => {
			const item = { sha: "translation-no-intent", url: "https://example.test/no-intent.png" };
			await sql`insert into images(sha256,kind,source) values(${item.sha},'原图',${item.url})`;
			const readOnly = client(target.toString(), 1);
			clients.push(readOnly);
			await readOnly`set default_transaction_read_only=on`;
			await assert.rejects(translate(readOnly, [item], { submit: async () => assert.fail("意图未落库不能收费提交") }), /read-only/);
		});
		await t.test("重放 #203 尺码原图漏译：图已上传、逐图 issues 为空，普通与原图建品仍拦下", () => replayImageLanguage(sql));
		await t.test("象寄直接翻译只处理本稿选图，读回和重复选择复用译图，店铺模式可来回切换", async () => {
			const url = "https://cbu01.alicdn.com/xiangji-fixture.jpg";
			const offerId = OfferId.parse("600914");
			const skuId = SkuId.parse("test-sku"),
				specId = SpecId.parse("test-spec");
			const offer = { ...product(offerId), offerId, images: [url], skus: [{ skuId, specId, name: "標準", attrs: ["標準"], image: url }] };
			const variants = {
				tiers: [{ source: "款式", name: "款式", options: [{ source: "標準", name: "標準", image: url }] }],
				variants: [{ sku: "fixture", skuId, specId, options: [0], weightKg: 0.1, costRmb: 1, stock: 9, priceTwd: 120 }],
			};
			const [row] = await sql<ListingRow[]>`insert into listings (shop,offer_id,offer,variants) values
				('cheeroutdoor',${offerId},${sql.json(offer)},${sql.json(variants)}) returning *`;
			assert.ok(row);
			const bytes = await readFile(new URL("../tools/listing/fixtures/size-chart-simplified.jpg", import.meta.url));
			const originalImage = inspect(bytes);
			const translated = inspect(Buffer.concat([bytes, Buffer.from("test-translated")]));
			const outputUrl = "https://example.test/xiangji-fixture.jpg";
			const config = { userKey: "fixture", imgTransKey: "fixture", base: "https://example.test" };
			let calls = 0;
			const deps = {
				original: async () => {
					await sql`insert into images (sha256,kind,source) values (${originalImage.sha256},'原图',${url}) on conflict do nothing`;
					return originalImage;
				},
				checkConfig: () => config,
				translate: (db: Sql, items: { sha: string; url: string }[]) =>
					translate(db, items, {
						submit: async ({ urls }) => {
							calls++;
							assert.deepEqual(urls, [url]);
							return { kind: "done", data: { kind: "done", results: [{ origin: url, url: outputUrl }], failed: [], missing: [] } };
						},
						save: async () => {
							await sql`insert into images (sha256,kind,source,from_sha,bytes) values
								(${translated.sha256},'译图',${outputUrl},${originalImage.sha256},${Buffer.from(translated.bytes)})`;
						},
					}),
			};
			const p = xiangjiImagesParams.parse({ id: row.id, expectedScope: reviewedImagesScope(row), urls: [url] });
			await assert.rejects(xiangjiImages(sql, { ...p, urls: ["https://cbu01.alicdn.com/other.jpg"], submit: true }, deps), /不在本稿/);
			assert.equal((await xiangjiImages(sql, p, deps)).images[0]?.status, "not-submitted");
			const result = await xiangjiImages(sql, { ...p, submit: true }, deps);
			assert.deepEqual(result.images[0]?.translation, { url: outputUrl, sha256: translated.sha256 });
			assert.deepEqual(await xiangjiImages(sql, { ...p, submit: true }, deps), result);
			assert.equal(calls, 1);
			assert.deepEqual((await sql`select images from listings where id=${row.id}`)[0]?.images, {});
			assert.equal((await shopImageFlow(sql, row.shop)).mode, "xiangji");
			await shopImageFlow(sql, row.shop, "processed");
			assert.equal((await shopImageFlow(secondSql, row.shop)).mode, "processed");
			assert.equal((await shopImageFlow(secondSql, "ni1206")).mode, "xiangji");
			await shopImageFlow(sql, row.shop, "xiangji");
		});
		await t.test("Hermes 真实库工具范围锁定已勾选来源和目标店，未决写入保留原编号", async () => {
			register(...TOOLKITS);
			const fixture = product("600109");
			const [source] = await sql<{ id: string }[]>`insert into listing_sources(platform, source_id, url, snapshot)
				values ('1688', ${fixture.sourceId}, ${fixture.url}, ${sql.json(fixture)}) returning id::text`;
			const [draft, other] = await sql<{ id: string; shop: string }[]>`insert into listings (shop, offer_id)
				values ('cheeroutdoor', ${fixture.sourceId}), ('ni1206', ${fixture.sourceId}) returning id::text, shop`;
			assert.ok(source && draft && other);
			await sql`insert into listing_source_links (source_id, shop, listing_id)
				values (${source.id}, ${draft.shop}, ${draft.id}), (${source.id}, ${other.shop}, ${other.id})`;
			const [pending] = await sql<{ id: string }[]>`insert into writes (batch, op, target, params, key, status)
				values (1, '上架', ${draft.id}, ${sql.json({ listingId: draft.id })}, 'hermes-fixture', '结果未知') returning id::text`;
			assert.ok(pending);
			const { call, specifications } = listingHermesTools(
				sql,
				{ shop: draft.shop, shopId: "1554182542", sourceIds: [source.id], trial: false, batch: "fixture" },
				"fixture",
			);
			const preflight = await call("source_preflight", {});
			const [content] = preflight.content;
			assert.ok(content?.type === "text");
			const plan = JSON.parse(content.text);
			assert.deepEqual(
				plan.items.map((item: { status: string; nextTool: string }) => [item.status, item.nextTool]),
				[["needs-input", "source_detail"]],
			);
			const names = new Set(specifications.map((tool) => tool.name));
			for (const tool of [plan.items[0].nextTool, ...plan.reviewTools, ...Object.values(plan.imageSteps).flat()]) {
				assert.ok(names.has(typeof tool === "string" ? tool : tool.tool));
			}

			await assert.rejects(call("publish", { id: other.id }), /不在本次已授权/);
			await assert.rejects(call("publish", { id: draft.id }), new RegExp(`原写入待核对 ${pending.id}`));
		});
	} finally {
		for (const lease of leases) await lease.release().catch(() => {});
		for (const sql of clients) await sql.end({ timeout: 5 });
		if (created) await admin.unsafe(`drop database if exists "${name}" with (force)`);
		await admin.end({ timeout: 5 });
	}
});

async function replayImageLanguage(sql: Sql) {
	const shop = "cheeroutdoor";
	const offerId = OfferId.parse("1079918323219");
	const chartId = "fixture-simplified-chart";
	const mainId = "fixture-main";
	const stock = 50;
	const pSku = `LT${offerId}-black-m`;
	const rememberImage = async (id: string, bytes: Buffer) => {
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		await sql`insert into images (sha256, kind, bytes) values (${sha256}, 'fixture', ${bytes})`;
		await sql`insert into shop_images (shop, sha256, image_id) values (${shop}, ${sha256}, ${id})`;
		return sha256;
	};
	const sha = await rememberImage(chartId, await readFile(new URL("../tools/listing/fixtures/size-chart-simplified.jpg", import.meta.url)));
	assert.equal(sha, "96f07a70eb540b9b1abc18e6d90114a2cc420ff5c3593219f68a693e781157a9");
	await rememberImage(mainId, Buffer.from("主圖測試標記"));
	const correctedId = "fixture-traditional-chart";
	const correctedSha = await rememberImage(correctedId, Buffer.from("繁體尺碼表測試標記"));
	const skuId = SkuId.parse("black-m-sku");
	const specId = SpecId.parse("black-m");
	const offer = {
		...product(offerId),
		offerId,
		detail: [],
		skus: [{ skuId, specId, name: "黑色 M", attrs: ["黑色 M"], price: 1, stock, weightKg: 0.1 }],
		tags: { freeShipping: true },
	};
	const variants = {
		tiers: [{ source: "款式", name: "", options: [{ source: "黑色 M", name: "" }] }],
		variants: [{ sku: pSku, skuId, specId, options: [0], weightKg: 0.1, costRmb: 1, stock, priceTwd: 149 }],
	};
	const chart = {
		shop,
		offerId,
		imageId: chartId,
		source: "https://example.com/source-203.jpg",
		sha256: sha,
		width: 800,
		height: 800,
		evidence: "供货尺码表原图，覆盖黑色 M 项。",
		scope: sizeChartScope({ shop, offer_id: offerId, offer: offer as unknown as ListingRow["offer"], variants }),
		at: new Date().toISOString(),
	};
	const [row] = await sql<
		ListingRow[]
	>`insert into listings (shop, offer_id, offer, title, description, days_to_ship, category_path, variants, images, size_chart)
		values (${shop}, ${offerId}, ${sql.json(offer)}, '黑色網面包頭抽繩可摺疊旅行拖鞋', '黑色 M，尺碼請參考尺寸表。',
			15, '[100637,101324]', ${sql.json(variants)}, ${sql.json({ main: [{ from: "fixture", imageId: mainId }], imageMode: "original" })}, ${sql.json(chart)})
		returning *`;
	const [settings] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop=${shop}`;
	assert.ok(row && settings);
	const id = ListingId.parse(String(row.id));
	const s = settingsOf(settings);
	const ready = productOf(row, s);
	assert.ok(ready.info && ready.product, ready.problems.join("；"));
	const coverage = saveCoverage(row, ready.product, {
		expectedScope: coverageScope(row, ready.product).expectedScope,
		excludedSkus: [],
		detail: [],
		layoutEvidence: "單一在售黑色 M，已核對採用的主圖。",
	});
	await sql`update listings set coverage=${sql.json(coverage)} where id=${id}`;
	const preview = await previewListingReview(sql, { id });
	assert.deepEqual(
		preview.images.map((image) => [image.id, image.state]),
		[
			[mainId, "pending-check"],
			[chartId, "pending-check"],
		],
	);
	const review = {
		id,
		expectedKey: preview.expectedKey,
		provider: "human" as const,
		evidence: "重放只有完整圖片編號與空問題陣列的舊流程。",
		textIssues: [],
		images: preview.images.map((image) => ({ id: image.id, issues: [] })),
	};
	const incomplete = await setListingReview(sql, review);
	assert.equal(incomplete.languagePassed, false);
	const create = LISTING_WRITES.建商品!;
	const createInput = create.params.parse({ listingId: id, shop, shopId: s.shopId, parentSku: pSku.split("-")[0], productInfo: ready.info, hash: ready.hash });
	const blocked = await create.prepare(sql, createInput);
	assert.ok("skip" in blocked);
	assert.match(blocked.skip, new RegExp(`商品稿 #${id} .*尺码图 ${chartId}：待检查`));
	const source = await saveCollectedSource(sql, { shop, link: `https://detail.1688.com/offer/${offerId}.html` }, product(offerId));
	const sourceApproval = { kind: "original-source", sourceProductId: source.sourceId, hash: ready.hash!, at: chart.at };
	await sql`update listings set source_product_id=${source.sourceId}, source_approval=${sql.json(sourceApproval)}, audit=null where id=${id}`;
	assert.deepEqual(await create.prepare(sql, createInput), blocked, "原图批准也进入同一发布关卡");

	const snapshot = await imageLanguageSnapshot(sql, shop, ready.info);
	const main = snapshot.images.find((image) => image.id === mainId)!;
	const failed = await setListingReview(sql, {
		...review,
		images: [
			{ id: mainId, issues: [], language: { state: "no-chinese", sha256: main.sha256!, evidence: "主圖無文字。" } },
			{ id: chartId, issues: ["产品参数、适合脚长"], language: { state: "needs-correction", sha256: sha, evidence: "實際原圖含「产品参数」、「适合脚长」。" } },
		],
	});
	assert.equal(failed.languagePassed, false);
	assert.match((await imageLanguageBlock(sql, shop, "商品 #203", ready.info))!, /尺码图 fixture-simplified-chart：待修正/);

	await sql`update listings set size_chart=${sql.json({ ...chart, sha256: correctedSha, imageId: correctedId })} where id=${id}`;
	const next = await previewListingReview(sql, { id });
	await assert.rejects(setListingReview(sql, review), /已变化/);
	assert.equal(next.images.find((image) => image.id === mainId)?.state, "no-chinese");
	const passed = await setListingReview(sql, {
		...review,
		expectedKey: next.expectedKey,
		images: [
			{ id: mainId, issues: [] },
			{ id: correctedId, issues: [], language: { state: "traditional", sha256: correctedSha, evidence: "已核對測試尺碼圖的繁體標註。" } },
		],
	});
	assert.equal(passed.languagePassed, true);
	const native = {
		...ready.info,
		model_list: ready.info.model_list.map((model) => ({ ...model, id: ModelId.parse("918") })),
		size_chart_info: { size_chart: correctedId },
	};
	assert.equal(await imageLanguageBlock(sql, shop, "商品 #203", native), null, "实际商品读回复用建品前证据");
	const edit = editParams.parse({
		shop,
		id: "203",
		beforeTitle: ready.info.name,
		title: ready.info.name,
		beforeSizeChartInfo: native.size_chart_info,
		sizeChartInfo: { size_chart: chartId },
	});
	assert.match((await imageLanguageBlock(sql, shop, "商品 #203", editImageTarget(native, edit)))!, /尺码图 fixture-simplified-chart：待修正/);
	const model = native.model_list[0]!;
	const variantImage = variantImageTarget(native, {
		std_tier_variation_list: native.std_tier_variation_list,
		model_list: [{ id: model.id, tier_index: model.tier_index, sku_image: chartId }],
	});
	assert.match((await imageLanguageBlock(sql, shop, "商品 #203", variantImage))!, /SKU.*fixture-simplified-chart/);
	const changedScope = { ...native, model_list: [{ ...model, sku: "different-size" }] };
	assert.match((await imageLanguageBlock(sql, shop, "商品 #203", changedScope))!, /尺码图 fixture-traditional-chart：待检查/);

	const newId = "fixture-same-bytes-new-id";
	await sql`update shop_images set image_id=${newId} where shop=${shop} and sha256=${correctedSha}`;
	const sameFile = { ...native, size_chart_info: { size_chart: `https://down-tw.img.susercontent.com/file/${newId}` } };
	assert.equal(await imageLanguageBlock(sql, shop, "商品 #203", sameFile), null, "同店同文件同规格可以复用");
	const note = "實物標籤為原廠印字。";
	const withNote = {
		...sameFile,
		description_info: { description_type: "normal", description: note },
	};
	const printed = { state: "printed-with-note" as const, sha256: correctedSha, note, evidence: "已確認文字直接印在實物標籤上。" };
	await assert.rejects(
		saveImageLanguageReviews(sql, shop, await imageLanguageSnapshot(sql, shop, sameFile), "human", [{ id: newId, language: printed }]),
		/须出现在最终商品描述/,
	);
	await saveImageLanguageReviews(sql, shop, await imageLanguageSnapshot(sql, shop, withNote), "human", [{ id: newId, language: printed }]);
	assert.equal(await imageLanguageBlock(sql, shop, "商品 #203", withNote), null);
	assert.match((await imageLanguageBlock(sql, shop, "商品 #203", sameFile))!, /缺少对应的繁体印字说明/);
	await sql`update listing_image_language_reviews set rule_version=${IMAGE_LANGUAGE_RULE_VERSION + 1} where shop=${shop} and sha256=${correctedSha}`;
	assert.match((await imageLanguageBlock(sql, shop, "商品 #203", sameFile))!, /尺码图 fixture-same-bytes-new-id：待检查/);
}
