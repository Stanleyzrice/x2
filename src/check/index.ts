// 检查：从库里读一份快照，跑 orders.ts 的检查，把结果写回库：收件箱（只更新不重复，条件不成立就关）、订单上算出来的列、购物车的「该不该买」、人勾的货源候选写进规格。
// 只有这一域这一轮同步完整了，才关它的那几行：漏读不算做完
import type { Sql } from "../db/index.ts";
import { checkOrders, type InboxItem, type Snapshot, type Todo } from "./orders.ts";

/** 每一类收件箱靠哪几个域的同步：这几个域都读全了，这一类没再算出来的才关 */
const DEPENDS: Record<string, string[]> = {
	付款: ["cart", "purchases", "orders"], 打包: ["orders", "purchases"], 快到期: ["orders"], 取消: ["orders", "cart", "purchases"],
	问题单: ["orders"], 选货源: ["orders"], 设置: [], 登录: [], 结果未知: [],
};

const SITE: Record<string, string> = { orders: "仓老板", skus: "Shopee", cart: "1688", purchases: "1688" };

export async function snapshot(sql: Sql): Promise<Snapshot> {
	const [settings] = await sql`select * from order_settings where id = 1`;
	const orders = await sql`select * from orders where created_at > now() - interval '60 days' or platform_status = '待出货' order by ship_by nulls last`;
	const skus = await sql`select model_id, item_id, offer_id, offer_sku_id from skus`;
	const offers = await sql`select offer_id, title, live, skus from offers`;
	const options = await sql`select model_id, offer_id, offer_sku_id, sure, chosen from source_options`;
	const writes = await sql`select id, batch, op, status, params, finished_at from writes where op in ('加购', '预报', '取消预报') and include`;
	const purchases = await sql`select * from purchases`;
	const cart = await sql`select account, offer_id, offer_sku_id, qty from cart`;
	return {
		now: new Date(),
		settings: { lateDays: Number(settings!.late_days), chanbossAddress: settings!.chanboss_address, channel: settings!.channel },
		orders: orders.map((o) => ({
			sn: o.sn, shop: o.shop, shipBy: o.ship_by, platformStatus: o.platform_status ?? "", chanbossStatus: o.chanboss_status ?? "", chanbossId: o.chanboss_id,
			chanbossTime: Number(o.chanboss_time), items: o.items, problem: o.problem, cancelledAt: o.cancelled_at,
		})),
		skus: new Map(skus.map((r) => [r.model_id, { modelId: r.model_id, itemId: r.item_id, offerId: r.offer_id, skuId: r.offer_sku_id }])),
		offers: new Map(offers.map((r) => [r.offer_id, { offerId: r.offer_id, title: r.title, live: r.live, skus: r.skus }])),
		options: options.map((r) => ({ modelId: r.model_id, offerId: r.offer_id, skuId: r.offer_sku_id, sure: r.sure, chosen: r.chosen })),
		writes: writes.map((w) => ({ id: String(w.id), batch: String(w.batch), op: w.op, status: w.status, params: w.params, finishedAt: w.finished_at })),
		purchases: purchases.map((p) => ({
			account: p.account, orderId: p.order_id, offerId: p.offer_id, offerSkuId: p.offer_sku_id, qty: Number(p.qty), createdAt: p.created_at, status: `${p.status ?? ""} ${p.status_label ?? ""}`,
			toChanboss: p.to_chanboss, trackingNo: p.tracking_no, signed: p.signed,
		})),
		cart: cart.map((c) => ({ account: c.account, offerId: c.offer_id, skuId: c.offer_sku_id, qty: Number(c.qty) })),
	};
}

/** 同步失败要人处理的（没登录、浏览器没连上），结果未知、不一致的写入：也进收件箱 */
async function loopItems(sql: Sql): Promise<InboxItem[]> {
	const failed = await sql`select s.name, s.scope, s.error, coalesce(sh.account, s.scope) as who from syncs s left join shops sh on sh.shop_id = s.scope where s.result = '失败' and s.blocked`;
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
	const snap = await snapshot(sql);
	const r = checkOrders(snap);
	const items = [...r.inbox, ...await loopItems(sql)];
	const syncs = await sql`select name, result from syncs`;
	const complete = (name: string) => syncs.filter((x) => x.name === name).every((x) => x.result === "成功") && syncs.some((x) => x.name === name);
	const closable = Object.entries(DEPENDS).filter(([, ds]) => ds.every(complete)).map(([kind]) => kind);

	let opened = 0, closed = 0;
	await sql.begin(async (tx) => {
		// 人勾的货源候选写进规格
		for (const o of r.chosenSources) await tx`update skus set offer_id = ${o.offerId}, offer_sku_id = ${o.skuId}, sourced_at = now() where model_id = ${o.modelId}`;
		for (const [sn, c] of r.orders) {
			await tx`update orders set days_left = ${c.daysLeft}, sourced = ${c.sourced}, carted = ${c.carted}, paid = ${c.paid}, arrived = ${c.arrived},
				destination = ${c.destination}, step = ${c.step}, checked_at = now() where sn = ${sn}`;
		}
		await tx`update cart set orders = null, should_buy = null`;
		for (const [k, c] of r.cart) {
			const [account, offerId, skuId] = k.split("|");
			await tx`update cart set orders = ${c.orders}, should_buy = ${c.shouldBuy} where account = ${account!} and offer_id = ${offerId!} and offer_sku_id = ${skuId!}`;
		}
		for (const i of items) {
			const [row] = await tx`
				insert into inbox (key, kind, title, detail, shop, due, link) values (${i.key}, ${i.kind}, ${i.title}, ${i.detail}, ${i.shop}, ${i.due}, ${i.link})
				on conflict (key) do update set kind = excluded.kind, title = excluded.title, detail = excluded.detail, shop = excluded.shop, due = excluded.due, link = excluded.link,
					updated_at = now(), open = true, closed_at = null, opened_at = case when inbox.open then inbox.opened_at else now() end
				returning (xmax = 0) as inserted`;
			if (row!.inserted) opened++;
		}
		const keys = items.map((i) => i.key);
		const gone = await tx`
			update inbox set open = false, closed_at = now(), updated_at = now()
			where open and kind in ${tx(closable.length ? closable : [""])} and not (key in ${tx(keys.length ? keys : [""])})
			returning key`;
		// 「批准」：这一批没有待批准的写入了（批准了、取消了）就关
		const approved = await tx`
			update inbox set open = false, closed_at = now(), updated_at = now()
			where open and kind = '批准' and not exists (select 1 from writes w where w.batch::text = split_part(inbox.key, ':', 2) and w.status = '待批准' and w.include)
			returning key`;
		closed = gone.length + approved.length;
	});
	return { todo: r.todo, opened, closed };
}
