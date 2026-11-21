// 商品稿的检查（x2 status 问它；执行完建商品、上架的写入、人在网页上改了格也马上重算）：只看库里的，不读站点
import type { Sql } from "../../platform/db/index.ts";
import { checkListings, type Write } from "./check.ts";
import { imageLanguageBlock } from "./image-language.ts";
import { savePrices } from "./make.ts";
import { type Settings, settingsOf } from "./pricing.ts";
import type { SentInfo } from "./product.ts";
import type { ListingRow, ShopSettingsRow } from "./row.ts";

export async function listingsCheck(sql: Sql, ids?: string[]) {
	if (ids && !ids.length) return checkListings([], new Map(), []);
	const rows = ids
		? await sql<ListingRow[]>`select * from listings where id in ${sql(ids)} order by id`
		: await sql<ListingRow[]>`select * from listings where not cancelled or updated_at > now() - interval '7 days' order by id`;
	const settings = new Map<string, Settings>();
	for (const s of await sql<ShopSettingsRow[]>`select * from shop_settings`) {
		try {
			settings.set(s.shop, settingsOf(s));
		} catch {}
	}
	for (const l of rows) {
		if (l.cancelled || l.product_id) continue;
		const s = settings.get(l.shop);
		if (s) await savePrices(sql, l, s);
	}
	const writes = await sql<
		Write[]
	>`select id::text, batch::text, op, status, params, finished_at as "finishedAt", error from writes where op in ('建商品', '上架')`;
	const checked = checkListings(rows, settings, [...writes]);
	const languageBlocks = new Map<string, string>();
	for (const { id, writes: planned } of checked.ready) {
		const create = planned.find((write) => write.op === "建商品");
		if (!create) continue;
		const language = await imageLanguageBlock(sql, String(create.params.shop), `商品稿 #${id}`, create.params.productInfo as SentInfo);
		if (language) languageBlocks.set(id, language);
	}
	const r = languageBlocks.size ? checkListings(rows, settings, [...writes], languageBlocks) : checked;
	for (const [id, c] of r.steps)
		await sql`update listings set step = ${c.step}, step_detail = ${c.detail} where id = ${id} and (step is distinct from ${c.step} or step_detail is distinct from ${c.detail})`;
	return r;
}
