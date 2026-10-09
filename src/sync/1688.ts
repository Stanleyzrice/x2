// 同步 1688：购物车、采购单（带物流），一个 1688 账号一份（在登录着那个账号的浏览器里读）。
// 货源不按时同步：x2 source、x2 run 用到哪家现读哪家，读到的存进 offers（下架的记 live = false）
import { in1688 } from "../accounts.ts";
import { type BuyerOrder, buyerOrders, cart as readCart, Gone, type Offer, offer as readOffer, traces } from "../site/1688.ts";
import type { Sql } from "../db/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** 1688 的时间：毫秒数或日期字符串；认不出是 null（采购单的字段还没有真数据核对过） */
const date = (v: unknown) => {
	if (v === null || v === undefined || v === "") return null;
	const d = new Date(/^\d+$/.test(String(v)) ? Number(v) : String(v));
	return Number.isNaN(d.getTime()) ? null : d;
};

/** 现读一家货源存进 offers；下架了回 null（也记下） */
export async function fetchOffer(sql: Sql, offerId: string): Promise<Offer | null> {
	try {
		const o = await readOffer(offerId);
		await sql`
			insert into offers ${sql({ offer_id: o.offerId, url: o.url, title: o.title, image: o.image, unit: o.unit, min_qty: o.minQty, props: sql.json(o.props), skus: sql.json(o.skus), live: true, read_at: new Date() })}
			on conflict (offer_id) do update set url = excluded.url, title = excluded.title, image = excluded.image, unit = excluded.unit, min_qty = excluded.min_qty,
				props = excluded.props, skus = excluded.skus, live = true, read_at = excluded.read_at`;
		return o;
	} catch (e) {
		if (!(e instanceof Gone)) throw e;
		await sql`insert into offers (offer_id, live, read_at) values (${offerId}, false, now()) on conflict (offer_id) do update set live = false, read_at = now()`;
		return null;
	}
}

/** 读几家货源，隔 1.5 秒一家（1688 对频率敏感）；下架的是 null */
export async function fetchOffers(sql: Sql, offerIds: Iterable<string>, what: string): Promise<Map<string, Offer | null>> {
	const got = new Map<string, Offer | null>();
	const ids = [...new Set(offerIds)];
	for (const [i, id] of ids.entries()) {
		if (i > 0) await sleep(1500);
		console.error(`${what} ${i + 1}/${ids.length}：${id}`);
		got.set(id, await fetchOffer(sql, id));
	}
	return got;
}

export async function syncCart(sql: Sql, account: string): Promise<number> {
	const lines = await in1688(account, () => readCart());
	const at = new Date();
	await sql.begin(async (tx) => {
		for (const l of lines) {
			await tx`
				insert into cart (account, offer_id, offer_sku_id, qty, synced_at) values (${account}, ${l.offerId}, ${l.skuId}, ${l.quantity}, ${at})
				on conflict (account, offer_id, offer_sku_id) do update set qty = excluded.qty, synced_at = excluded.synced_at`;
		}
		await tx`delete from cart where account = ${account} and synced_at < ${at}`;
	});
	return lines.length;
}

/** 1688 的物流状态里有「签收」就算签收了 */
export const signedOf = (status: string) => /签收/.test(status);

/** 采购单读最近 3 页（150 张，新的在前）；有快递单号的再读物流 */
export async function syncPurchases(sql: Sql, account: string, pages = 3): Promise<number> {
	const { orders, trace } = await in1688(account, async () => {
		const orders: BuyerOrder[] = [];
		for (let n = 1; n <= pages; n++) {
			const r = await buyerOrders(n);
			orders.push(...r.rows);
			if (n >= r.pages || r.rows.length === 0) break;
		}
		const shipped = orders.filter((o) => o.items.some((i) => i.trackingNo));
		const trace = new Map((await traces(shipped.map((o) => ({ orderId: o.orderId, trackingNos: o.items.map((i) => i.trackingNo).filter(Boolean) })))).map((t) => [t.orderId, t]));
		return { orders, trace };
	});
	const { chanboss_address } = (await sql`select chanboss_address from order_settings where id = 1`)[0]!;
	// 1688 规格：采购单上只有 specId，按货源里的规格换成 skuId（只有一个规格的货源 specId 是空的，skuId 是货源 id）
	const offerIds = [...new Set(orders.flatMap((o) => o.items.map((i) => i.offerId)))];
	const known = new Map((await sql`select offer_id, skus from offers where offer_id in ${sql(offerIds.length ? offerIds : [""])}`).map((r) => [r.offer_id as string, r.skus as Offer["skus"]]));
	const at = new Date();
	await sql.begin(async (tx) => {
		for (const o of orders) {
			const t = trace.get(o.orderId);
			for (const [line, i] of o.items.entries()) {
				// 1688 规格：采购单的每一行自带 skuId（2026-10-09 核对过）；没有时按货源里的规格从 specId 换（只有一个规格的货源 skuId 是货源 id）
				const skus = known.get(i.offerId) ?? [];
				const skuId = i.skuId || (i.specId ? skus.find((s) => s.specId === i.specId)?.skuId ?? null : i.offerId);
				const logistics = t?.traces.find((x) => x.trackingNo === i.trackingNo)?.status ?? null;
				// 签收了：这一行 1688 上是「已收货」、收了件，或者物流里有「签收」
				const signed = i.status === "success" || i.received >= i.quantity || (logistics !== null && signedOf(logistics));
				await tx`
					insert into purchases ${tx({
						order_id: o.orderId, line, account, offer_id: i.offerId, spec_id: i.specId, offer_sku_id: skuId, qty: i.quantity, price: i.price, paid: o.paid,
						status: o.status, status_label: i.statusLabel || o.statusLabel, created_at: date(o.createdAt), paid_at: date(o.paidAt),
						address: o.address, to_chanboss: chanboss_address && o.address ? o.address.includes(chanboss_address) : null,
						tracking_no: i.trackingNo || null, shipped_at: date(i.shippedAt), logistics, signed,
						raw: tx.json(o.raw as any), synced_at: at,
					})}
					on conflict (order_id, line) do update set
						offer_sku_id = excluded.offer_sku_id, qty = excluded.qty, price = excluded.price, paid = excluded.paid, status = excluded.status, status_label = excluded.status_label,
						paid_at = excluded.paid_at, address = excluded.address, to_chanboss = excluded.to_chanboss, tracking_no = excluded.tracking_no, shipped_at = excluded.shipped_at,
						logistics = excluded.logistics, signed = excluded.signed, raw = excluded.raw, synced_at = excluded.synced_at`;
			}
		}
	});
	return orders.length;
}
