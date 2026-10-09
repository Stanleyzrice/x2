// 选货源：给一个规格定货源和 1688 规格。agent 先自己找（x2 source）：这个商品用过的货源 → 以图搜图（知虾）→ 按规格名打分。
// 规格名里的数字、颜色都对得上，而且只有一个对得上的：记成「明显对得上」（sure），随加购一起批准，人批准了加购，货源才写进规格；
// 对不上、或者几个都像：都写成货源候选，收件箱加一行「选货源」，人在 NocoDB 的「选货源」里勾「用这个」
import type { Sql } from "./db/index.ts";
import { Usage } from "./errors.ts";
import { type Offer, offerIdOf } from "./site/1688.ts";
import { ready as zhixiaReady, similar1688 } from "./site/zhixia.ts";
import { rank } from "./similar.ts";
import { fetchOffers } from "./sync/1688.ts";

type Candidate = { offer: Offer; skuId: string; name: string; image: string; price: number; stock: number; score: number; missing: string[]; origin: string };
export type Found = { modelId: string; name: string; sure: { offerId: string; skuId: string; title: string; sku: string } | null; options: number; why: string };

/** 一家货源里和这个规格最像的几个 1688 规格 */
const fromOffer = (spec: string, o: Offer, top: number, origin: string): Candidate[] =>
	rank(spec, o.skus).slice(0, top).map((s) => ({ offer: o, skuId: s.skuId, name: s.name, image: s.image || o.image, price: s.price, stock: s.stock, score: s.score, missing: s.missing, origin }));

/** 对得上：规格名里的数字、颜色都有；有规格名时还要一半以上的字对得上（单规格的商品没有规格名，只看数字、颜色） */
const clean = (spec: string, c: Candidate) => c.missing.length === 0 && (!spec || c.score >= 0.5);

export async function findSources(sql: Sql, modelIds: string[], url?: string): Promise<Found[]> {
	const pasted = url ? offerIdOf(url) : null;
	if (url && !pasted) throw new Usage(`认不出 1688 链接：${url}`);
	const out: Found[] = [];
	for (const modelId of modelIds) {
		const [sku] = await sql`select model_id, item_id, item_name, name, image, offer_id, offer_sku_id from skus where model_id = ${modelId}`;
		if (!sku) throw new Usage(`库里没有规格 ${modelId}（先 x2 sync orders）`);
		const spec = String(sku.name ?? "");
		const label = `${sku.item_name ?? ""} / ${spec || "（单规格）"}`;
		let cands: Candidate[] = [];
		if (pasted) {
			const o = (await fetchOffers(sql, [pasted], "读贴的货源")).get(pasted);
			if (o) cands = fromOffer(spec, o, 8, "人贴的链接");
		} else {
			const used = (await sql`select distinct offer_id from skus where item_id = ${sku.item_id} and offer_id is not null`).map((r) => r.offer_id as string);
			const got = await fetchOffers(sql, used, "读这个商品用过的货源");
			const live = [...got.values()].filter((o): o is Offer => o !== null);
			cands = live.flatMap((o) => fromOffer(spec, o, live.length === 1 ? 5 : 3, "这个商品用过的"));
			// 用过的货源里没有对得上的：拿商品图以图搜图，每家只出最像的一个规格
			if (!cands.some((c) => clean(spec, c)) && sku.image) {
				await zhixiaReady();
				console.error(`以图搜图：${label}`);
				const hits = await similar1688(String(sku.image).replace(/_tn$/, ""), 8);
				const found = await fetchOffers(sql, hits.map((h) => h.offerId).filter((id) => !used.includes(id)), "读搜到的货源");
				cands.push(...[...found.values()].filter((o): o is Offer => o !== null).flatMap((o) => fromOffer(spec, o, 1, "以图搜图")));
			}
		}
		cands.sort((a, b) => Number(clean(spec, b)) - Number(clean(spec, a)) || b.score - a.score);
		const ok = cands.filter((c) => clean(spec, c));
		const sure = ok.length === 1 && !pasted ? ok[0]! : null;
		await sql.begin(async (tx) => {
			await tx`delete from source_options where model_id = ${modelId} and not chosen`;
			for (const c of cands.slice(0, 8)) {
				await tx`
					insert into source_options ${tx({
						model_id: modelId, offer_id: c.offer.offerId, offer_sku_id: c.skuId, sku_name: label, sku_image: sku.image, offer_title: c.offer.title, name: c.name || "（单规格）",
						image: c.image, price: c.price, stock: c.stock, score: Math.round(c.score * 100) / 100, missing: c.missing.join("、") || null, origin: c.origin, sure: c === sure,
					})}
					on conflict (model_id, offer_id, offer_sku_id) do update set name = excluded.name, image = excluded.image, price = excluded.price, stock = excluded.stock,
						score = excluded.score, missing = excluded.missing, origin = excluded.origin, sure = excluded.sure, found_at = now()`;
			}
		});
		out.push({
			modelId, name: label, options: Math.min(8, cands.length),
			sure: sure ? { offerId: sure.offer.offerId, skuId: sure.skuId, title: sure.offer.title, sku: sure.name || "（单规格）" } : null,
			why: sure ? "规格名里的数字、颜色都对上，而且只有它对上：随加购一起批准"
				: cands.length === 0 ? "没找到候选：贴一个 1688 链接（x2 source <规格> --url …），或者请人在 1688 上找"
				: ok.length > 1 ? `${ok.length} 个都对得上：请人在「选货源」里勾` : "没有对得上的：请人在「选货源」里勾，或者贴链接",
		});
	}
	return out;
}
