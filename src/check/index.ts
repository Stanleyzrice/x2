// 检查：从库里读一份快照，跑 orders.ts 的检查，把结果写回库：收件箱（只更新不重复，条件不成立就关）、订单上算出来的列、购物车的「该不该买」、人勾的货源候选写进规格。
// 只有这一行靠的同步这一轮读全了，才关它：漏读不算做完。人勾了「处理好了」的（x2 看不到结果的事），关掉以后不再开
import type { Sql } from "../db/index.ts";
import { checkOrders, type InboxItem, planned, type Result, type Snapshot, type Todo } from "./orders.ts";

/** 一行收件箱靠哪些同步：[域, 范围]，范围是 null 时这个域的每一份都要读全 */
function depends(kind: string, key: string): [string, string | null][] {
	const [, target] = key.split(":");
	switch (kind) {
		case "付款": return [["orders", null], ["cart", target!], ["purchases", target!]];
		case "打包": return [["orders", null], ["purchases", null]];
		case "取消": return key.startsWith("cancel-goods:") ? [["orders", null], ["purchases", null]] : [["orders", null], ["cart", null]];
		case "快到期": case "问题单": case "选货源": return [["orders", null]];
		default: return [];
	}
}

const SITE: Record<string, string> = { orders: "chanboss", skus: "Shopee", cart: "1688", purchases: "1688" };

export async function snapshot(sql: Sql): Promise<Snapshot> {
	const [settings] = await sql`select * from order_settings where id = 1`;
	const orders = await sql`select * from orders where created_at > now() - interval '60 days' or platform_status = '待出货' order by ship_by nulls last`;
	const skus = await sql`select model_id, item_id, offer_id, offer_sku_id from skus`;
	const offers = await sql`select offer_id, title, live, skus from offers`;
	const options = await sql`select model_id, offer_id, offer_sku_id, sure, chosen from source_options`;
	const writes = await sql`select id, batch, op, status, params, finished_at from writes where op in ('加购', '预报', '取消预报') and include`;
	const purchases = await sql`select * from purchases`;
	const cart = await sql`select account, offer_id, offer_sku_id, qty from cart`;
	const accounts = await sql`select user_id, login_id from accounts_1688`;
	return {
		now: new Date(),
		settings: { lateDays: Number(settings!.late_days), channel: settings!.channel, buyAccount: settings!.buy_account },
		orders: orders.map((o) => ({
			sn: o.sn, shop: o.shop, createdAt: o.created_at, shipBy: o.ship_by, platformStatus: o.platform_status ?? "", chanbossStatus: o.chanboss_status ?? "", chanbossId: o.chanboss_id,
			chanbossTime: Number(o.chanboss_time), items: o.items, problem: o.problem, cancelledAt: o.cancelled_at,
		})),
		skus: new Map(skus.map((r) => [r.model_id, { modelId: r.model_id, itemId: r.item_id, offerId: r.offer_id, skuId: r.offer_sku_id }])),
		offers: new Map(offers.map((r) => [r.offer_id, { offerId: r.offer_id, title: r.title, live: r.live, skus: r.skus }])),
		options: options.map((r) => ({ modelId: r.model_id, offerId: r.offer_id, skuId: r.offer_sku_id, sure: r.sure, chosen: r.chosen })),
		writes: writes.map((w) => ({ id: String(w.id), batch: String(w.batch), op: w.op, status: w.status, params: w.params, finishedAt: w.finished_at })),
		purchases: purchases.map((p) => ({
			account: p.account, orderId: p.order_id, offerId: p.offer_id, offerSkuId: p.offer_sku_id, qty: Number(p.qty), createdAt: p.created_at, status: p.status ?? "",
			toChanboss: p.to_chanboss, trackingNo: p.tracking_no, signed: p.signed,
		})),
		cart: cart.map((c) => ({ account: c.account, offerId: c.offer_id, skuId: c.offer_sku_id, qty: Number(c.qty) })),
		accounts: new Map(accounts.map((a) => [a.user_id, a.login_id ?? a.user_id])),
	};
}

/** 现在检查出来的结果（不写库）：x2 propose、x2 run 用它确认一项写入现在还该做 */
export async function current(sql: Sql): Promise<Result & { planned: ReturnType<typeof planned> }> {
	const r = checkOrders(await snapshot(sql));
	return { ...r, planned: planned(r) };
}

/** 同步失败要人处理的（没登录、浏览器没连上），结果未知、不一致的写入：也进收件箱 */
async function loopItems(sql: Sql): Promise<InboxItem[]> {
	const failed = await sql`
		select s.name, s.scope, s.error, coalesce(sh.account, a.login_id, s.scope) as who from syncs s
		left join shops sh on sh.shop_id = s.scope left join accounts_1688 a on a.user_id = s.scope
		where s.result = '失败' and s.blocked`;
	const writes = await sql`select id, op, display, status, error from writes where status in ('结果未知', '不一致') and include`;
	return [
		...failed.map((f): InboxItem => ({
			key: `login:${f.name}${f.scope ? `:${f.scope}` : ""}`, kind: "登录", shop: null, due: null, link: null,
			title: `登录：${SITE[f.name] ?? f.name}${f.who ? ` ${f.who}` : ""} 读不了`, detail: f.error ?? "",
		})),
		...writes.map((w): InboxItem => ({
			key: `unknown:${w.id}`, kind: "结果未知", shop: null, due: null, link: w.op === "加购" ? "https://cart.1688.com/cart.htm" : null,
			title: `${w.status}：${w.op} ${w.display ?? ""}`,
			detail: `${w.error ?? ""}\n到站点上看一眼做了没有，在「写入」里把这一行的状态改成「已核对」（做了）或「被拒」（没做）。不要重做`,
		})),
	];
}

export type Checked = { todo: Todo[]; opened: number; closed: number };

export async function check(sql: Sql): Promise<Checked> {
	const r = checkOrders(await snapshot(sql));
	const items = [...r.inbox, ...await loopItems(sql)];
	const syncs = await sql`select name, scope, result from syncs`;
	const complete = ([name, scope]: [string, string | null]) => {
		const rows = syncs.filter((x) => x.name === name && (scope === null || x.scope === scope));
		return rows.length > 0 && rows.every((x) => x.result === "成功");
	};

	let opened = 0, closed = 0;
	await sql.begin(async (tx) => {
		// 人勾的货源候选写进规格
		for (const o of r.chosenSources) await tx`update skus set offer_id = ${o.offerId}, offer_sku_id = ${o.skuId}, sourced_at = now() where model_id = ${o.modelId}`;
		// 规格的货源已经是候选里的某一个（人勾了、随加购批准了）：这个规格的候选用完了，删掉（「选货源」视图空了就是选完了）
		await tx`delete from source_options o where exists (
			select 1 from source_options x join skus s on s.model_id = x.model_id and s.offer_id = x.offer_id and s.offer_sku_id = x.offer_sku_id where x.model_id = o.model_id)`;
		for (const [sn, c] of r.orders) {
			await tx`update orders set days_left = ${c.daysLeft}, sourced = ${c.sourced}, carted = ${c.carted}, paid = ${c.paid}, arrived = ${c.arrived},
				destination = ${c.destination}, step = ${c.step}, step_detail = ${c.stepDetail}, checked_at = now() where sn = ${sn}`;
		}
		await tx`update cart set orders = null, should_buy = null`;
		for (const [k, c] of r.cart) {
			const [account, offerId, skuId] = k.split("|");
			await tx`update cart set orders = ${c.orders}, should_buy = ${c.shouldBuy} where account = ${account!} and offer_id = ${offerId!} and offer_sku_id = ${skuId!}`;
		}
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
		// 没再算出来的：这一行靠的同步这一轮都读全了才关
		const keys = new Set(items.map((i) => i.key));
		const stale = (await tx`select key, kind from inbox where open and kind <> '批准'`).filter((x) => !keys.has(x.key) && depends(x.kind, x.key).every(complete));
		if (stale.length) await tx`update inbox set open = false, closed_at = now(), updated_at = now() where key in ${tx(stale.map((x) => x.key as string))}`;
		// 「批准」：这一批没有待批准的写入了（批准了、取消了）就关
		const approved = await tx`
			update inbox set open = false, closed_at = now(), updated_at = now()
			where open and kind = '批准' and not exists (select 1 from writes w where w.batch::text = split_part(inbox.key, ':', 2) and w.status = '待批准' and w.include)
			returning key`;
		// 谁做：照 inbox_roles 填，没写的归运营
		await tx`update inbox set role = coalesce((select role from inbox_roles r where r.kind = inbox.kind), '运营') where open and role is distinct from coalesce((select role from inbox_roles r where r.kind = inbox.kind), '运营')`;
		closed = done.length + stale.length + approved.length;
	});
	return { todo: r.todo, opened, closed };
}
