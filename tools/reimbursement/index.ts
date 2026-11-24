// 已付款采购记录的查询与刷新入口：网页只读取保存事实，手动与定时刷新都经过账号锁和完整分页发布。
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import { db, type Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { flag, get, type Toolkit } from "../../platform/tool.ts";
import { exportRecords } from "./export.ts";
import { present, type StoredPurchase, summarizeOriginalAmounts } from "./facts.ts";
import { checkScope, type RecordQuery, recordFilter, recordQuery, type Scope, scope } from "./query.ts";
import { refreshAccount, refreshAll, runLockPresent } from "./sync.ts";

export { refreshAccount, refreshAll } from "./sync.ts";

export async function accountStates(sql: Sql, allowed?: string[]) {
	const live = runLockPresent(sql);
	return sql<
		{
			id: string;
			name: string;
			lastSuccessAt: Date | null;
			revision: string | null;
			status: string | null;
			startedAt: Date | null;
			finishedAt: Date | null;
			page: number | null;
			pages: number | null;
			observed: number | null;
			total: number | null;
			error: string | null;
			paidCount: number | null;
			unknownCount: number | null;
		}[]
	>`select a.account_id as id, a.name, a.last_success_at as "lastSuccessAt", a.revision,
 case when r.status = 'running' and not ${live} then 'interrupted' else r.status end as status,
 r.started_at as "startedAt", r.finished_at as "finishedAt", r.page, r.pages, r.observed, r.total,
 case when r.status = 'running' and not ${live} then '上次同步进程已中断；保留最后成功记录' else r.error end as error,
 r.paid_count as "paidCount", r.unknown_count as "unknownCount"
 from reimbursement_accounts a left join lateral (select * from reimbursement_runs where account_id = a.account_id order by started_at desc limit 1) r on true
 ${allowed ? sql`where a.account_id in ${sql(allowed)}` : sql``} order by a.name, a.account_id`;
}

type ReportAmount = { account: string; orderId: string; revision: number; minor: string | null; reported: boolean };

function reportAmounts(sql: Sql | postgres.TransactionSql, p: RecordQuery) {
	return sql<ReportAmount[]>`select o.fact->'receipt'->>'originalMinor' as minor, coalesce(m.reported, false) as reported,
 o.account_id as account, o.order_id as "orderId", coalesce(m.revision, 0) as revision
 from reimbursement_orders o left join reimbursement_marks m on m.account_id = o.account_id and m.order_id = o.order_id ${recordFilter(sql, p)}
 order by o.account_id, o.order_id`;
}

const pendingVersion = (rows: ReportAmount[]) =>
	createHash("sha256")
		.update(JSON.stringify(rows.map((r) => [r.account, r.orderId, r.revision, r.minor])))
		.digest("hex");

export async function listRecords(sql: Sql, p: Scope & { search: string; offset: number; paidFrom?: string; paidTo?: string }) {
	const filter = recordFilter(sql, p);
	const live = runLockPresent(sql);
	// 订单页、完整匹配金额和同步状态互不依赖，并行读取避免远端库往返累加。
	const [rows, amounts, [latest], accounts] = await Promise.all([
		sql<
			{
				account: string;
				accountName: string;
				fact: StoredPurchase;
				capturedAt: Date;
				revision: string;
				absentFromLatest: boolean;
				reported: boolean;
				reportRevision: number;
				reportedAt: Date | null;
			}[]
		>`select o.account_id as account, a.name as "accountName", o.fact, o.captured_at as "capturedAt", o.revision, o.revision <> a.revision as "absentFromLatest",
 coalesce(m.reported, false) as reported, coalesce(m.revision, 0) as "reportRevision", case when m.reported then m.updated_at end as "reportedAt"
 from reimbursement_orders o join reimbursement_accounts a on a.account_id = o.account_id
 left join reimbursement_marks m on m.account_id = o.account_id and m.order_id = o.order_id ${filter}
 order by o.paid_at desc, o.account_id, o.order_id limit 50 offset ${p.offset}`,
		reportAmounts(sql, p),
		p.accounts
			? Promise.resolve([])
			: sql<
					{ status: string; error: string | null; startedAt: Date; finishedAt: Date | null }[]
				>`select case when r.status = 'running' and not ${live} then 'interrupted' else r.status end as status,
 case when r.status = 'running' and not ${live} then '上次同步进程已中断；保留最后成功记录' else r.error end as error,
 r.started_at as "startedAt", r.finished_at as "finishedAt" from reimbursement_runs r where r.account_id is null order by r.started_at desc limit 1`,
		accountStates(sql, p.accounts),
	]);
	const summary = summarizeOriginalAmounts(amounts.map((a) => a.minor));
	const pending = amounts.filter((a) => !a.reported);
	const pendingSummary = summarizeOriginalAmounts(pending.map((a) => a.minor));
	return {
		query: { account: p.account ?? null, accounts: p.accounts ?? null, search: p.search, paidFrom: p.paidFrom ?? "", paidTo: p.paidTo ?? "", offset: p.offset },
		accounts,
		global: p.accounts ? null : (latest ?? null),
		total: summary.orderCount,
		summary,
		pendingSummary,
		pendingVersion: pendingVersion(pending),
		offset: p.offset,
		limit: 50,
		rows: rows.map(({ fact, ...r }) => ({
			...r,
			reportedAt: r.reportedAt?.toISOString() ?? null,
			...present({ ...fact, paidAt: fact.receipt.paidAt, paidMinor: fact.receipt.originalMinor }),
			paymentSourceRevision: fact.receipt.revision,
			currentSourcePaidMinor: fact.paidMinor,
		})),
	};
}

export async function markReported(sql: Sql, p: Scope & { account: string; orderId: string; reported: boolean; revision: number }) {
	checkScope(p);
	const [order] = await sql<{ orderId: string }[]>`select order_id as "orderId" from reimbursement_orders
 where account_id = ${p.account} and order_id = ${p.orderId} and paid_at is not null`;
	if (!order) throw new Usage("该账号下没有此已付款采购订单，不能修改报帐标记");
	type Mark = { reported: boolean; revision: number; updatedAt: Date };
	const [mark] =
		p.revision === 0
			? await sql<Mark[]>`insert into reimbursement_marks (account_id, order_id, reported, revision)
 values (${p.account}, ${p.orderId}, ${p.reported}, 1) on conflict (account_id, order_id) do nothing
 returning reported, revision, updated_at as "updatedAt"`
			: await sql<Mark[]>`update reimbursement_marks set reported = ${p.reported}, revision = revision + 1, updated_at = now()
 where account_id = ${p.account} and order_id = ${p.orderId} and revision = ${p.revision}
 returning reported, revision, updated_at as "updatedAt"`;
	if (!mark) throw new Usage("报帐标记版本已更新，未覆盖另一处的修改；请重新读取后再选择");
	return { account: p.account, orderId: p.orderId, reported: mark.reported, revision: mark.revision, updatedAt: mark.updatedAt.toISOString() };
}

export async function markAllReported(sql: Sql, p: RecordQuery & { pendingVersion: string }) {
	const changed = "待报账订单或标记已变化，请核对最新数量后再确认";
	try {
		return await sql.begin("isolation level repeatable read", async (tx) => {
			const pending = (await reportAmounts(tx, p)).filter((r) => !r.reported);
			if (pendingVersion(pending) !== p.pendingVersion) throw new Usage(changed);
			const result = await tx`insert into reimbursement_marks (account_id, order_id, reported, revision)
 select o.account_id, o.order_id, true, 1 from reimbursement_orders o
 left join reimbursement_marks m using (account_id, order_id) ${recordFilter(tx, p)} and not coalesce(m.reported, false)
 order by o.account_id, o.order_id
 on conflict (account_id, order_id) do update set reported = true, revision = reimbursement_marks.revision + 1, updated_at = now()
 where not reimbursement_marks.reported`;
			return { marked: result.count };
		});
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "40001") throw new Usage(changed);
		throw error;
	}
}

export async function refreshRecords(sql: Sql, p: Scope, run = { all: refreshAll, account: refreshAccount }) {
	checkScope(p);
	if (!p.account && !p.accounts) return { results: await run.all(sql) };
	const results = [];
	for (const id of p.account ? [p.account] : p.accounts!) {
		const [saved] = await sql<{ name: string }[]>`select name from reimbursement_accounts where account_id = ${id}`;
		results.push(await run.account(sql, { id, name: saved?.name ?? id }));
	}
	return { results };
}

export const reimbursement: Toolkit = {
	name: "reimbursement",
	title: "采购报账：1688 已付款订单记录",
	kind: "tool",
	tools: {
		accounts: get("保存的采购账号及最后同步状态（不触发网站读取）", z.object({ accounts: scope.shape.accounts }), async (p) =>
			accountStates(await db(), p.accounts),
		),
		list: get(
			"按账号、搜索和付款日期查询采购单，汇总全部匹配原实付及未报帐原实付；日期按Asia/Shanghai包含起止日，不扣退款，未知金额单独计数",
			recordQuery.extend({
				offset: z.coerce.number().int().nonnegative().default(0),
			}),
			async (p) => listRecords(await db(), p),
		),
		export: get(
			"仅导出未勾选已报帐的订单：订单截图、总价、产品成本单价、购买数量、实际付款、订单号、报账金额总计；总计按每单原实付加总仅展示一次，不修改报帐标记",
			recordQuery,
			async (p) => exportRecords(await db(), p),
		),
		"mark-all-reported": get(
			"将当前筛选内所有分页的待报账采购单标记为已报账",
			recordQuery.extend({
				pendingVersion: z
					.string()
					.regex(/^[a-f0-9]{64}$/)
					.describe("本次列表的 pendingVersion"),
			}),
			async (p) => markAllReported(await db(), p),
		),
		"mark-reported": get(
			"人工设置本地是否已报帐标记，可撤销；不是外部报帐提交或批准，需传当前reportRevision防止覆盖并发修改",
			scope.extend({
				account: z.string().min(1),
				orderId: z.string().min(1),
				reported: flag("是否已报帐：true或false，仅保存本地人工跟踪"),
				revision: z.coerce.number().int().nonnegative().describe("列表当前reportRevision；未标记为0"),
			}),
			async (p) => markReported(await db(), p),
		),
		refresh: get("完整刷新指定账号并等待结果；不给账号发现已登录账号并刷新全部，期间可通过 list 查看进度", scope, async (p) => refreshRecords(await db(), p), {
			exit: (r) => (r.results.some((v) => v.status === "failed") ? "error" : undefined),
		}),
	},
	schema: new URL("./schema.sql", import.meta.url),
};
