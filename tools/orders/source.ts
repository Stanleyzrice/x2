// 选货源：给店里的一个商品定一个货源（一个商品只用一个货源；店里的规格加购时按名字在货源的规格里配，配不上的看人定的规格例外）。
// agent 先自己找（x2 orders source）：拿商品图经知虾以图搜图，每个找到的货源，看店里卖过的规格在它里面有几个对得上。
// 卖过的规格都对得上、而且只有它这样：标成「明显匹配」（sure），人同意加购时一起定下，加购做成了这个货源才标成「选用」；
// 别的都写成还在挑的货源，x2 status 提醒「选货源」，人在网页的「货源」里勾「选用」。人贴了链接（--url）就直接用它。
// 货源的样子（标题、图、规格）存一份快照，x2 每次现读就更新；买之前一律现读

import { Gone, type Offer, OfferId, offerIdOf, offer as readOffer } from "../../connectors/sites/1688/api.ts";
import { similar1688, ready as zhixiaReady } from "../../connectors/sites/zhixia/api.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import type { SourceSku } from "./check.ts";
import { addException, matchSku } from "./similar.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const live = (id: OfferId) =>
	readOffer(id).catch((e) => {
		if (e instanceof Gone) return null;
		throw e;
	});

export async function snapshot(sql: Sql, itemId: string, o: Offer): Promise<void> {
	await sql`update sources set url = ${o.url}, title = ${o.title}, image = ${o.image}, skus = ${sql.json(o.skus as any)}, read_at = now(), broken = null
		where item_id = ${itemId} and offer_id = ${o.offerId}`;
}

export async function markBroken(sql: Sql, itemId: string, offerId: string, why: string): Promise<void> {
	await sql`update sources set broken = ${why}, read_at = now() where item_id = ${itemId} and offer_id = ${offerId} and chosen`;
}

/** 现读这几个商品选用的货源，更新快照；下架的标成不可用。隔 1.5 秒一个（1688 对频率敏感） */
export async function refreshChosen(sql: Sql, itemIds: string[]): Promise<number> {
	if (itemIds.length === 0) return 0;
	const rows = await sql`select item_id, offer_id from sources where chosen and item_id in ${sql(itemIds)}`;
	for (const [i, r] of rows.entries()) {
		if (i > 0) await sleep(1500);
		const o = await live(r.offer_id);
		if (o) await snapshot(sql, r.item_id, o);
		else await markBroken(sql, r.item_id, r.offer_id, "货源已在 1688 下架");
	}
	return rows.length;
}

type Scored = { offer: Offer; matched: number; total: number; missing: string[]; origin: string };
export type Found = { itemId: string; name: string; chosen: string | null; sure: string | null; options: number; why: string };

const score = (specs: string[], o: Offer, origin: string, exceptions?: string | null): Scored => {
	const missing = specs.filter((s) => !matchSku(s, o.skus, exceptions));
	return { offer: o, matched: specs.length - missing.length, total: specs.length, missing, origin };
};

export async function findSources(sql: Sql, itemIds: string[], url?: string): Promise<Found[]> {
	const pasted = url ? offerIdOf(url) : null;
	if (url && !pasted) throw new Usage(`认不出 1688 链接：${url}`);
	const out: Found[] = [];
	for (const itemId of itemIds) {
		const rows =
			await sql`select distinct i->>'name' as name, i->>'image' as image, i->>'spec' as spec from orders o, jsonb_array_elements(o.items) i where i->>'itemId' = ${itemId}`;
		if (!rows.length) throw new Usage(`最近 60 天的订单里没有商品 ${itemId}（先 x2 status）`);
		const name = String(rows[0]!.name),
			image = String(rows[0]!.image ?? "");
		const specs = [...new Set(rows.map((r) => String(r.spec ?? "")))];
		const kept = new Map(
			(await sql`select offer_id, sku_exceptions from sources where item_id = ${itemId}`).map((r) => [r.offer_id as string, r.sku_exceptions as string | null]),
		);
		let found: Scored[] = [];
		if (pasted) {
			const o = await live(pasted);
			if (o) found = [score(specs, o, "人工添加", kept.get(o.offerId))];
		} else if (image) {
			await zhixiaReady();
			console.error(`以图搜图：${name}`);
			const hits = await similar1688(image.replace(/_tn$/, ""), 8);
			for (const [i, h] of hits.entries()) {
				if (i > 0) await sleep(1500);
				console.error(`读搜到的货源 ${i + 1}/${hits.length}：${h.offerId}`);
				const o = await live(OfferId.parse(h.offerId));
				if (o) found.push(score(specs, o, "以图搜图", kept.get(o.offerId)));
			}
		}
		found.sort((a, b) => b.matched - a.matched);
		const all = found.filter((f) => f.matched === f.total);
		const sure = !pasted && all.length === 1 ? all[0]! : null;
		await sql.begin(async (tx) => {
			if (pasted) await tx`update sources set chosen = false where item_id = ${itemId} and chosen`;
			else await tx`update sources set chosen = false where item_id = ${itemId} and chosen and broken is not null`;
			await tx`delete from sources where item_id = ${itemId} and not chosen`;
			for (const f of found) {
				await tx`
					insert into sources ${tx({
						item_id: itemId,
						site: "1688",
						offer_id: f.offer.offerId,
						item_name: name,
						item_image: image,
						url: f.offer.url,
						title: f.offer.title,
						image: f.offer.image,
						skus: tx.json(f.offer.skus as any),
						read_at: new Date(),
						score: f.total ? Math.round((f.matched / f.total) * 100) / 100 : null,
						missing: f.missing.join("、") || null,
						origin: f.origin,
						sure: f === sure,
						chosen: Boolean(pasted),
					})}
					on conflict (item_id, offer_id) do update set url = excluded.url, title = excluded.title, image = excluded.image, skus = excluded.skus, read_at = excluded.read_at,
						score = excluded.score, missing = excluded.missing, origin = excluded.origin, sure = excluded.sure, chosen = excluded.chosen, broken = null, found_at = now()`;
			}
		});
		out.push({
			itemId,
			name,
			options: found.length,
			chosen: pasted && found.length ? found[0]!.offer.title : null,
			sure: sure?.offer.title ?? null,
			why: pasted
				? found.length
					? `用人贴的货源${found[0]!.missing.length ? `（未匹配的规格：${found[0]!.missing.join("、")}）` : ""}`
					: "贴的货源已在 1688 下架"
				: sure
					? "卖过的规格都对得上，而且只有它这样：随加购一起定下"
					: found.length === 0
						? "没找到：贴一个 1688 链接（x2 orders source --items <商品> --url …），或者请人在 1688 上找"
						: all.length > 1
							? `${all.length} 个货源都对得上：请人在「货源」里勾`
							: "没有规格全对得上的：请人在「货源」里勾，或者贴链接",
		});
	}
	return out;
}

export async function setException(sql: Sql, itemId: string, text: string): Promise<{ spec: string; sku: string; title: string }> {
	if (text.indexOf("=") <= 0) throw new Usage(`--spec 写成「店里的规格名 = 货源的规格名」：${text}`);
	const [row] =
		await sql`select offer_id, title, skus, sku_exceptions from sources where item_id = ${itemId} and (chosen or sure) and broken is null order by chosen desc limit 1`;
	if (!row) throw new Usage(`商品 ${itemId} 还没定货源：先选货源（x2 orders source --items ${itemId}）`);
	const sold = (await sql`select distinct i->>'spec' as spec from orders o, jsonb_array_elements(o.items) i where i->>'itemId' = ${itemId}`).map((r) =>
		String(r.spec ?? ""),
	);
	const title = String(row.title ?? row.offer_id);
	const r = addException(text, sold, { title, skus: row.skus as SourceSku[], exceptions: row.sku_exceptions });
	if ("error" in r) throw new Usage(`商品 ${itemId}：${r.error}`);
	await sql`update sources set sku_exceptions = ${r.exceptions} where item_id = ${itemId} and offer_id = ${row.offer_id}`;
	return { spec: r.spec, sku: r.sku, title };
}
