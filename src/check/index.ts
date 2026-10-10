// 检查：拿这一轮现读的站点数据（read.ts）和库里人定的东西拼成一份快照，跑 orders.ts 的检查，把结果写回库：
// 收件箱（只更新不重复，条件不成立就关）、订单上算出来的列、规格定了货源以后删掉它剩下的候选。
// 只有这一行靠的那几样这一轮都读成功了，才关它：漏读不算做完。人勾了「处理好了」的（x2 看不到结果的事），关掉以后不再开
import type { Sql } from "../db/index.ts";
import { NeedsHuman } from "../errors.ts";
import { read1688, type Read, type Reads } from "../read.ts";
import { settingsOf, type Settings } from "../listing/make.ts";
import { checkListings } from "./listings.ts";
import { checkOrders, type InboxItem, planned, type Result, type Snapshot, type Todo } from "./orders.ts";

/** 一行收件箱靠哪几样现读：订单（chanboss）、购物车、采购单（1688 账号 userId；null 是每个账号） */
function depends(kind: string, key: string): [string, string | null][] {
	const [, target] = key.split(":");
	switch (kind) {
		case "付款": return [["订单", null], ["购物车", target!], ["采购单", target!]];
		case "打包": return [["订单", null], ["采购单", null]];
		case "取消": return key.startsWith("cancel-goods:") ? [["订单", null], ["采购单", null]] : [["订单", null], ["购物车", null]];
		case "没发货": return [["采购单", null]];
		case "快到期": case "问题单": case "选货源": case "规格对不上": return [["订单", null]];
		default: return [];
	}
}

const complete = (results: Read[]) => ([what, who]: [string, string | null]) => {
	const rows = results.filter((r) => r.what === what && (who === null || r.who === who));
	return rows.length > 0 && rows.every((r) => r.ok);
};

export async function snapshot(sql: Sql, reads: Reads): Promise<Snapshot> {
	const [settings] = await sql`select * from order_settings where id = 1`;
	const orders = await sql`select * from orders where created_at > now() - interval '60 days' or platform_status = '待出货' order by ship_by nulls last`;
	const sources = await sql`select item_id, offer_id, title, skus, chosen, sure, broken, sku_exceptions from sources`;
	const writes = await sql`select id, batch, op, status, params, finished_at from writes where op in ('加购', '预报', '取消预报') and include`;
	const issues = await sql`select id::text, sn, item, kind, qty, note, resolution from arrival_issues where not done order by id`;
	return {
		now: new Date(),
		settings: { lateDays: Number(settings!.late_days), channel: settings!.channel, buyAccount: reads.buyAccount, shipWaitHours: Number(settings!.ship_wait_hours) },
		orders: orders.map((o) => ({
			sn: o.sn, shop: o.shop, createdAt: o.created_at, shipBy: o.ship_by, platformStatus: o.platform_status ?? "", chanbossStatus: o.chanboss_status ?? "", chanbossId: o.chanboss_id,
			chanbossTime: Number(o.chanboss_time), items: o.items, problem: o.problem, cancelledAt: o.cancelled_at,
		})),
		sources: sources.map((r) => ({ itemId: r.item_id, offerId: r.offer_id, title: r.title, skus: r.skus, chosen: r.chosen, sure: r.sure, broken: r.broken, exceptions: r.sku_exceptions })),
		writes: writes.map((w) => ({ id: String(w.id), batch: String(w.batch), op: w.op, status: w.status, params: w.params, finishedAt: w.finished_at })),
		purchases: reads.purchases,
		cart: reads.cart,
		accounts: reads.accounts,
		issues: issues.map((x) => ({ id: x.id, sn: String(x.sn).trim(), item: x.item, kind: x.kind, qty: x.qty, note: x.note, resolution: x.resolution })),
	};
}

/** 现在该做的（不写库）：x2 propose、x2 run 加购前用它确认一项写入现在还该做。
 * 只现读 1688 的购物车、采购单（同一个进程 2 分钟内读过的复用）；订单、货源用库里的（上一次 x2 status 读的，要做的那几张订单 x2 run 另外现读 chanboss）。
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

/** 读不了要人处理的（没登录、浏览器没连上），结果未知、不一致的写入：也进收件箱 */
async function loopItems(sql: Sql, reads: Reads): Promise<InboxItem[]> {
	const writes = await sql`select id, op, display, status, error from writes where status in ('结果未知', '不一致') and include`;
	return [
		...reads.results.filter((r) => !r.ok && r.blocked).map((r): InboxItem => ({
			key: `login:${r.what}:${r.who}`, kind: "登录", shop: null, due: null, link: null,
			title: `登录：${r.what === "订单" ? "chanboss" : "1688"} ${reads.accounts.get(r.who) ?? (r.who === "chanboss" || r.who === "1688" ? "" : r.who)} 读不了`.replace(/\s+读/, " 读"),
			detail: r.error ?? "",
		})),
		...writes.map((w): InboxItem => ({
			key: `unknown:${w.id}`, kind: "结果未知", shop: null, due: null, link: w.op === "加购" ? "https://cart.1688.com/cart.htm" : null,
			title: `${w.status}：${w.op} ${w.display ?? ""}`,
			detail: `${w.error ?? ""}\n到站点上看一眼做了没有，在「写入」里把这一行的状态改成「已核对」（做了）或「被拒」（没做）。不要重做`,
		})),
	];
}

export type Checked = { todo: Todo[]; opened: number; closed: number };

/** 商品稿（docs/listing.md）：只看库里的（商品稿、店铺设置、建商品和上架的写入），不读站点 */
async function listingsCheck(sql: Sql) {
	const rows = await sql`select * from listings where not cancelled or updated_at > now() - interval '7 days' order by id`;
	const settings = new Map<string, Settings>();
	for (const s of await sql`select * from shop_settings`) { try { settings.set(s.shop, settingsOf(s)); } catch { /* 店铺设置填得不对：这家店的商品稿停在「暂停上品」 */ } }
	const writes = await sql`select id, batch, op, status, params, finished_at from writes where op in ('建商品', '上架') and include`;
	return checkListings(rows, settings, writes.map((w) => ({ id: String(w.id), batch: String(w.batch), op: w.op, status: w.status, params: w.params, finishedAt: w.finished_at })));
}

export async function check(sql: Sql, reads: Reads): Promise<Checked> {
	const r = checkOrders(await snapshot(sql, reads));
	const lr = await listingsCheck(sql);
	const items = [...r.inbox, ...lr.inbox, ...await loopItems(sql, reads)];
	const ok = complete(reads.results);

	let opened = 0, closed = 0;
	await sql.begin(async (tx) => {
		// 商品定了货源（人勾了「用这个」、随加购批准了）：它剩下的候选用完了，删掉（「选货源」空了就是选完了）
		await tx`delete from sources o where not o.chosen and exists (select 1 from sources c where c.item_id = o.item_id and c.chosen)`;
		await tx`update sources set chosen_at = now() where chosen and chosen_at is null`;
		await tx`update arrival_issues set done_at = now() where done and done_at is null`;
		for (const [sn, c] of r.orders) {
			await tx`update orders set days_left = ${c.daysLeft}, destination = ${c.destination}, step = ${c.step}, step_detail = ${c.stepDetail}, checked_at = now() where sn = ${sn}`;
		}
		for (const [id, c] of lr.steps) await tx`update listings set step = ${c.step}, step_detail = ${c.detail} where id = ${id} and (step is distinct from ${c.step} or step_detail is distinct from ${c.detail})`;
		// 人勾了「处理好了」的：关掉，不再开
		const done = await tx`update inbox set open = false, closed_at = now(), updated_at = now() where open and done returning key`;
		const doneKeys = new Set((await tx`select key from inbox where done`).map((x) => x.key as string));
		for (const i of items) {
			if (doneKeys.has(i.key)) continue;
			const [row] = await tx`
				insert into inbox (key, kind, title, detail, shop, due, link) values (${i.key}, ${i.kind}, ${i.title}, ${i.detail}, ${i.shop}, ${i.due}, ${i.link})
				on conflict (key) do update set kind = excluded.kind, title = excluded.title, detail = excluded.detail, shop = excluded.shop, due = excluded.due, link = excluded.link,
					updated_at = now(), open = true, closed_at = null, opened_at = case when inbox.open then inbox.opened_at else now() end
				returning (xmax = 0) as inserted`;
			if (row!.inserted) opened++;
		}
		// 没再算出来的：这一行靠的那几样这一轮都读成功了才关
		const keys = new Set(items.map((i) => i.key));
		const stale = (await tx`select key, kind from inbox where open and kind <> '批准'`).filter((x) => !keys.has(x.key) && depends(x.kind, x.key).every(ok));
		if (stale.length) await tx`update inbox set open = false, closed_at = now(), updated_at = now() where key in ${tx(stale.map((x) => x.key as string))}`;
		// 「批准」：这一批没有待批准的写入了（批准了、取消了）就关
		const approved = await tx`
			update inbox set open = false, closed_at = now(), updated_at = now()
			where open and kind = '批准' and not exists (select 1 from writes w where w.batch::text = split_part(inbox.key, ':', 2) and w.status = '待批准' and w.include)
			returning key`;
		closed = done.length + stale.length + approved.length;
	});
	return { todo: [...r.todo, ...lr.todo], opened, closed };
}
