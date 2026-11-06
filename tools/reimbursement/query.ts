// 列表与导出共用账号、搜索和付款日期边界；限定页面的账号范围不能被前端参数扩大。
import type postgres from "postgres";
import { z } from "zod";
import { Usage } from "../../platform/errors.ts";
import { paymentRange } from "./facts.ts";

export const scope = z.object({ accounts: z.array(z.string().min(1)).min(1).optional(), account: z.string().min(1).optional() });
export type Scope = z.infer<typeof scope>;
export const recordQuery = scope.extend({
	search: z.string().default(""),
	paidFrom: z.string().optional().describe("付款起始日 YYYY-MM-DD，包含当天；不给是全部历史"),
	paidTo: z.string().optional().describe("付款截止日 YYYY-MM-DD，包含当天"),
});
export type RecordQuery = z.infer<typeof recordQuery>;

export function checkScope(p: Scope): void {
	if (p.account && p.accounts && !p.accounts.includes(p.account)) throw new Usage("采购账号不在当前页面允许范围内");
}

export function recordFilter(sql: postgres.Sql | postgres.TransactionSql, p: RecordQuery) {
	checkScope(p);
	const range = paymentRange(p.paidFrom, p.paidTo);
	return sql`where o.paid_at is not null
 ${p.accounts ? sql`and o.account_id in ${sql(p.accounts)}` : sql``}
 ${p.account ? sql`and o.account_id = ${p.account}` : sql``}
 ${range.from ? sql`and o.paid_at >= ${range.from}` : sql``}
 ${range.toExclusive ? sql`and o.paid_at < ${range.toExclusive}` : sql``}
 ${p.search ? sql`and (o.order_id ilike ${`%${p.search}%`} or o.fact->>'supplier' ilike ${`%${p.search}%`} or (o.fact->'items')::text ilike ${`%${p.search}%`})` : sql``}`;
}
