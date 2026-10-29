// 商品稿的检查（x2 status 问它；执行完建商品、上架的写入、人在网页上改了格也马上重算）：只看库里的，不读站点
import type { Sql } from "../../platform/db/index.ts";
import { checkListings } from "./check.ts";
import { savePrices } from "./make.ts";
import { type Settings, settingsOf } from "./pricing.ts";

/** 商品稿：只看库里的（商品稿、店铺设置、建商品和上架的写入），不读站点。
 * 还没建的「重量」「国内运费」改过的重新核价（不读 1688）；当前步骤、说明写回库。
 * ids：只看这几份（执行完写入马上更新涉及的商品稿）；不给是全部（x2 status） */
export async function listingsCheck(sql: Sql, ids?: string[]) {
	if (ids && !ids.length) return checkListings([], new Map(), []);
	const rows = ids
		? await sql`select * from listings where id in ${sql(ids)} order by id`
		: await sql`select * from listings where not cancelled or updated_at > now() - interval '7 days' order by id`;
	const settings = new Map<string, Settings>();
	for (const s of await sql`select * from shop_settings`) {
		try {
			settings.set(s.shop, settingsOf(s));
		} catch {
			/* 店铺设置填得不对：这家店的商品稿停在「已暂停」 */
		}
	}
	for (const l of rows) {
		if (l.cancelled || l.product_id) continue;
		const s = settings.get(l.shop);
		if (s) await savePrices(sql, l, s);
	}
	const writes = await sql`select id, batch, op, status, params, finished_at, error from writes where op in ('建商品', '上架')`;
	const r = checkListings(
		rows,
		settings,
		writes.map((w) => ({ id: String(w.id), batch: String(w.batch), op: w.op, status: w.status, params: w.params, finishedAt: w.finished_at, error: w.error })),
	);
	for (const [id, c] of r.steps)
		await sql`update listings set step = ${c.step}, step_detail = ${c.detail} where id = ${id} and (step is distinct from ${c.step} or step_detail is distinct from ${c.detail})`;
	return r;
}
