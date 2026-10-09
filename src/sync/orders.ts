// 同步订单：用仓老板的订单列表（两家店的订单都在，带商品、出货期限、平台状态、仓老板状态）。
// 读最近 60 天下单的，读全了才整批写进 orders；读到一半出错就不写，这一域这一轮算失败。
// 订单里的规格顺手补进 skus（没有的才加）：那家店的浏览器没连着，也知道卖出了哪些规格
import { orders as chanbossOrders } from "../site/chanboss.ts";
import type { Sql } from "../db/index.ts";

/** 仓老板状态：站上的代码 → 仓老板的词。paid、arrive 是推断的（2026-10-09 没有这两种状态的订单可核对） */
export const CHANBOSS_STATUS: Record<string, string> = { paid: "待处理", pre_report: "已预报", arrive: "已到齐", packaged: "已打包", delivery: "已出库", other: "其他" };

/** 平台状态：仓老板转来的 Shopee 订单状态 → Shopee 的词 */
export const PLATFORM_STATUS: Record<string, string> = {
	UNPAID: "待付款", READY_TO_SHIP: "待出货", PROCESSED: "待出货", RETRY_SHIP: "待出货",
	SHIPPED: "已出货", TO_CONFIRM_RECEIVE: "已出货", COMPLETED: "已完成", IN_CANCEL: "取消中", CANCELLED: "不成立", TO_RETURN: "退货退款",
};

export type Item = { itemId: string; modelId: string; chanbossModelId: string; name: string; spec: string; qty: number; image: string };

const time = (seconds: unknown) => (Number(seconds) > 0 ? new Date(Number(seconds) * 1000) : null);

/** 仓老板订单列表的一行 → orders 的一行。只有一个规格的商品，仓老板的 platform_model_id 是商品 id */
export function orderRow(r: any) {
	const items: Item[] = ((r.item_detail_new ?? []) as any[]).map((i) => ({
		itemId: String(i.platform_item_id ?? ""), modelId: String(i.platform_model_id ?? ""), chanbossModelId: String(i.model_id ?? ""),
		name: String(i.item_name ?? ""), spec: String(i.model_name ?? ""), qty: Number(i.count ?? 0), image: String(i.image ?? ""),
	}));
	const platform = String(r.platform_status ?? "");
	return {
		sn: String(r.sn),
		shop_id: String(r.platform_shop_id ?? ""),
		created_at: time(r.platform_create_time),
		ship_by: time(r.ship_deadline_time),
		platform_status: PLATFORM_STATUS[platform] ?? platform,
		chanboss_status: CHANBOSS_STATUS[String(r.status)] ?? String(r.status ?? ""),
		chanboss_id: String(r.id),
		chanboss_time: Number(r.platform_create_time ?? 0),
		items,
		items_text: items.map((i) => `${i.name} / ${i.spec || "（单规格）"} × ${i.qty}`).join("\n"),
		problem: Number(r.problem) ? String(r.problem_note || `问题（${r.problem_type}）`) : null,
		cancelled_at: platform === "CANCELLED" ? time(r.cancel_time) : null,
		shop_name: String(r.shop_name ?? ""),
	};
}

export async function syncOrders(sql: Sql): Promise<number> {
	const to = Math.floor(Date.now() / 1000), from = to - 60 * 86400;
	const raw: any[] = [];
	for (let n = 1; ; n++) {
		const page = await chanbossOrders(from, to, n);
		raw.push(...page.rows);
		if (n >= page.pageCount || page.rows.length === 0) break;
	}
	const rows = raw.map(orderRow);
	await sql.begin(async (tx) => {
		for (const r of rows) {
			const { shop_name, items, ...o } = r;
			await tx`insert into shops (shop_id, name) values (${o.shop_id}, ${shop_name}) on conflict (shop_id) do nothing`;
			await tx`
				insert into orders ${tx({ ...o, items: tx.json(items), synced_at: new Date() })}
				on conflict (sn) do update set
					shop_id = excluded.shop_id, created_at = excluded.created_at, ship_by = excluded.ship_by, platform_status = excluded.platform_status,
					chanboss_status = excluded.chanboss_status, chanboss_id = excluded.chanboss_id, chanboss_time = excluded.chanboss_time,
					items = excluded.items, items_text = excluded.items_text, problem = excluded.problem, cancelled_at = excluded.cancelled_at, synced_at = excluded.synced_at`;
			for (const i of items) {
				await tx`
					insert into skus (model_id, shop_id, item_id, item_name, name, image) values (${i.modelId}, ${o.shop_id}, ${i.itemId}, ${i.name}, ${i.spec}, ${i.image})
					on conflict (model_id) do nothing`;
			}
		}
		await tx`update orders o set shop = s.account from shops s where s.shop_id = o.shop_id and o.shop is distinct from s.account`;
	});
	return rows.length;
}
