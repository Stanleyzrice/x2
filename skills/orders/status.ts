// 订单的检查（x2 status 问它）：拿这一轮现读的站点数据（read.ts）和库里人定的东西拼成一份快照，跑 check.ts 的检查，
// 算出要提醒人的、agent 要做的，把订单上算出来的列写回库；规格定了货源以后删掉它剩下的候选

import type { Sql } from "../../platform/db/index.ts";
import { NeedsHuman } from "../../platform/errors.ts";
import type { Checked, Reminder } from "../../platform/tool.ts";
import { checkOrders, planned, type Result, type Snapshot } from "./check.ts";
import { type Reads, read1688 } from "./read.ts";

export async function snapshot(sql: Sql, reads: Reads): Promise<Snapshot> {
	const [settings] = await sql`select * from order_settings where id = 1`;
	const orders = await sql`select * from orders where created_at > now() - interval '60 days' or platform_status = '待出货' order by ship_by nulls last`;
	const sources = await sql`select item_id, offer_id, title, skus, chosen, sure, broken, sku_exceptions from sources`;
	const writes = await sql`select id, batch, op, status, params, finished_at from writes where op in ('加购', '预报', '取消预报')`;
	const issues = await sql`select id::text, sn, item, kind, qty, note, resolution from arrival_issues where not done order by id`;
	return {
		now: new Date(),
		settings: {
			lateDays: Number(settings!.late_days),
			channel: settings!.channel,
			buyAccount: reads.buyAccount,
			shipWaitHours: Number(settings!.ship_wait_hours),
		},
		orders: orders.map((o) => ({
			sn: o.sn,
			shop: o.shop,
			createdAt: o.created_at,
			shipBy: o.ship_by,
			platformStatus: o.platform_status ?? "",
			chanbossStatus: o.chanboss_status ?? "",
			chanbossId: o.chanboss_id,
			chanbossTime: Number(o.chanboss_time),
			items: o.items,
			problem: o.problem,
			cancelledAt: o.cancelled_at,
		})),
		sources: sources.map((r) => ({
			itemId: r.item_id,
			offerId: r.offer_id,
			title: r.title,
			skus: r.skus,
			chosen: r.chosen,
			sure: r.sure,
			broken: r.broken,
			exceptions: r.sku_exceptions,
		})),
		writes: writes.map((w) => ({ id: String(w.id), batch: String(w.batch), op: w.op, status: w.status, params: w.params, finishedAt: w.finished_at })),
		purchases: reads.purchases,
		cart: reads.cart,
		accounts: reads.accounts,
		issues: issues.map((x) => ({ id: x.id, sn: String(x.sn).trim(), item: x.item, kind: x.kind, qty: x.qty, note: x.note, resolution: x.resolution })),
	};
}

/** 现在该做的（不写库）：加购、预报的写工具记进库前、加购前用它确认一项写入现在还该做。
 * 只现读 1688 的购物车、采购单（同一个进程 2 分钟内读过的复用）；订单、货源用库里的（上一次 x2 status 读的，要做的那几张订单预报前另外现读 chanboss）。
 * 1688 读不全就停：拿漏读的采购单去对，会把买过的当成没买、买重 */
export async function current(sql: Sql): Promise<Result & { planned: ReturnType<typeof planned> }> {
	const reads = await read1688(sql);
	const bad = reads.results.find((r) => !r.ok);
	if (bad) {
		const why = `1688 ${reads.accounts.get(bad.who) ?? ""} ${bad.what}读不了，先不往下做（免得买重）：${bad.error}`.replace(/\s+/, " ");
		throw bad.blocked ? new NeedsHuman(why) : new Error(why);
	}
	const r = checkOrders(await snapshot(sql, reads));
	return { ...r, planned: planned(r) };
}

/** 读不了要人处理的（没登录、浏览器没连上）：也提醒人 */
function loginReminders(reads: Reads): Reminder[] {
	return reads.results
		.filter((r) => !r.ok && r.blocked)
		.map(
			(r): Reminder => ({
				key: `login:${r.what}:${r.who}`,
				kind: "登录",
				shop: null,
				due: null,
				link: null,
				title:
					`登录：${r.what === "订单" ? "chanboss" : "1688"} ${reads.accounts.get(r.who) ?? (r.who === "chanboss" || r.who === "1688" ? "" : r.who)} 无法读取`.replace(
						/\s+无法读取/,
						" 无法读取",
					),
				detail: r.error ?? "",
			}),
		);
}

/** 订单的检查：reads 是这一轮现读的（测试给假的） */
export async function ordersCheck(sql: Sql, reads: Reads): Promise<Checked> {
	const r = checkOrders(await snapshot(sql, reads));
	await sql.begin(async (tx) => {
		// 商品定了货源（人勾了「选用」、随加购定下）：它剩下的候选用完了，删掉（「货源」里一组没有勾「选用」的就是还没选）
		await tx`delete from sources o where not o.chosen and exists (select 1 from sources c where c.item_id = o.item_id and c.chosen)`;
		await tx`update sources set chosen_at = now() where chosen and chosen_at is null`;
		await tx`update arrival_issues set done_at = now() where done and done_at is null`;
		for (const [sn, c] of r.orders) {
			await tx`update orders set days_left = ${c.daysLeft}, destination = ${c.destination}, step = ${c.step}, step_detail = ${c.stepDetail}, checked_at = now() where sn = ${sn}`;
		}
	});
	const who = (w: string) => reads.accounts.get(w) ?? w;
	return {
		read: reads.results.map((x) => ({ ...x, who: who(x.who) })),
		human: [...r.reminders, ...loginReminders(reads)],
		todo: r.todo,
	};
}
