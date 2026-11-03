// 已付款采购记录的查询与刷新入口：网页只读取保存事实，手动与定时刷新都经过账号锁和完整分页发布。
import { z } from "zod";
import { db, type Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { flag, get, type Toolkit } from "../../platform/tool.ts";
import { paymentRange, present, type StoredPurchase, summarizeOriginalAmounts } from "./facts.ts";
import { refreshAccount, refreshAll, runLockPresent } from "./sync.ts";

export { refreshAll } from "./sync.ts";

const scope = z.object({ accounts: z.array(z.string().min(1)).min(1).optional(), account: z.string().min(1).optional() });
type Scope = z.infer<typeof scope>;
function checkScope(p: Scope): void {
	if (p.account && p.accounts && !p.accounts.includes(p.account)) throw new Usage("采购账号不在当前页面允许范围内");
}

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

export async function listRecords(sql: Sql, p: Scope & { search: string; offset: number; paidFrom?: string; paidTo?: string }) {
	checkScope(p);
	const range = paymentRange(p.paidFrom, p.paidTo);
	const filter = sql`where o.paid_at is not null
 ${p.accounts ? sql`and o.account_id in ${sql(p.accounts)}` : sql``}
 ${p.account ? sql`and o.account_id = ${p.account}` : sql``}
 ${range.from ? sql`and o.paid_at >= ${range.from}` : sql``}
 ${range.toExclusive ? sql`and o.paid_at < ${range.toExclusive}` : sql``}
 ${p.search ? sql`and (o.order_id ilike ${`%${p.search}%`} or o.fact->>'supplier' ilike ${`%${p.search}%`} or (o.fact->'items')::text ilike ${`%${p.search}%`})` : sql``}`;
	const rows = await sql<
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
 order by o.paid_at desc, o.account_id, o.order_id limit 50 offset ${p.offset}`;
	const amounts = await sql<
		{ minor: string | null; reported: boolean }[]
	>`select o.fact->'receipt'->>'originalMinor' as minor, coalesce(m.reported, false) as reported
 from reimbursement_orders o left join reimbursement_marks m on m.account_id = o.account_id and m.order_id = o.order_id ${filter}`;
	const summary = summarizeOriginalAmounts(amounts.map((a) => a.minor));
	const pendingSummary = summarizeOriginalAmounts(amounts.filter((a) => !a.reported).map((a) => a.minor));
	const live = runLockPresent(sql);
	const [latest] = await sql<
		{ status: string; error: string | null; startedAt: Date; finishedAt: Date | null }[]
	>`select case when r.status = 'running' and not ${live} then 'interrupted' else r.status end as status,
 case when r.status = 'running' and not ${live} then '上次同步进程已中断；保留最后成功记录' else r.error end as error,
 r.started_at as "startedAt", r.finished_at as "finishedAt" from reimbursement_runs r where r.account_id is null order by r.started_at desc limit 1`;
	return {
		query: { account: p.account ?? null, accounts: p.accounts ?? null, search: p.search, paidFrom: p.paidFrom ?? "", paidTo: p.paidTo ?? "", offset: p.offset },
		accounts: await accountStates(sql, p.accounts),
		global: p.accounts ? null : (latest ?? null),
		total: summary.orderCount,
		summary,
		pendingSummary,
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
			scope.extend({
				search: z.string().default(""),
				paidFrom: z.string().optional().describe("付款起始日 YYYY-MM-DD，包含当天；不给是全部历史"),
				paidTo: z.string().optional().describe("付款截止日 YYYY-MM-DD，包含当天"),
				offset: z.coerce.number().int().nonnegative().default(0),
			}),
			async (p) => listRecords(await db(), p),
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
