// 显式运行 node test/selection-listing.integration.ts：仅在独立空白临时库验证真实事务，不进入默认无数据库测试。
import "../platform/env.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { setTimeout } from "node:timers/promises";
import { client, type Sql } from "../platform/db/index.ts";
import { saveCollectedSource } from "../tools/listing/source.ts";
import { type CollectSourceInput, sourceProductSchema } from "../tools/listing/source-data.ts";
import { translate, translationState } from "../tools/listing/translations.ts";
import { postgresRunStore, type RunCreation, type RunLease, type RunStore } from "../tools/selection/run-store.ts";

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
		for (const file of ["../platform/db/schema.sql", "../tools/selection/schema.sql", "../tools/listing/schema.sql"]) {
			await sql.unsafe(await readFile(new URL(file, import.meta.url), "utf8"));
		}
		await sql`insert into strategies(name) values('集成测试策略')`;
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
			await abandoned.release();
			assert.equal(await second.shouldStop(abandoned.run.id), true);
			assert.equal(await second.recover(), 1);
			const repeated = await second.open(abandonedRequest);
			assert.equal(repeated.created, false);
			assert.equal(repeated.run.status, "interrupted");
			const fresh = await second.open(creation());
			leases.push(fresh);
			assert.equal(fresh.created, true);
			await second.finish(fresh.run.id, "completed");
			await fresh.release();
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
	} finally {
		for (const lease of leases) await lease.release().catch(() => {});
		for (const sql of clients) await sql.end({ timeout: 5 });
		if (created) await admin.unsafe(`drop database if exists "${name}" with (force)`);
		await admin.end({ timeout: 5 });
	}
});
