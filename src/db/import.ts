// 把 ~/x2 的 JSON（x2 buy 时代的数据）迁进库，只用一次：
// - offers.json（货源缓存）→ offers
// - sources.json 里的 spec（规格 → 货源、1688 规格，每个规格以最新的一条为准）→ skus 的货源两列；link（商品 → 货源）是更早的线索，不迁
// - carted.json（加购过的订单号 + 规格）→ 写入（加购、成功）：同一次加的（时间一样、1688 规格一样）合成一行。件数取订单里的，1688 账号由调用方给
// orders.json 不迁：x2 sync 重新同步
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Offer } from "../site/1688.ts";
import type { Sql } from "./index.ts";

type Spec = { kind: "spec"; modelId: string; offerId: string; skuId: string; at: string };
type Carted = { orderSn: string; modelId: string; at: string };

const readJson = async <T>(dir: string, name: string, empty: T): Promise<T> => {
	const text = await readFile(join(dir, `${name}.json`), "utf8").catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
	return text === null ? empty : (JSON.parse(text) as T);
};

export async function importJson(sql: Sql, dir: string, account: string) {
	const offers = await readJson<Record<string, Offer>>(dir, "offers", {});
	const specs = (await readJson<{ kind: string }[]>(dir, "sources", [])).filter((s): s is Spec => s.kind === "spec");
	const carted = await readJson<Carted[]>(dir, "carted", []);
	const latest = new Map<string, Spec>();
	for (const s of specs) latest.set(s.modelId, s);

	return sql.begin(async (tx) => {
		for (const o of Object.values(offers)) {
			await tx`
				insert into offers ${tx({ offer_id: o.offerId, url: o.url, title: o.title, image: o.image, unit: o.unit, min_qty: o.minQty, props: tx.json(o.props as any), skus: tx.json(o.skus as any), live: true, read_at: null })}
				on conflict (offer_id) do nothing`;
		}
		for (const s of latest.values()) {
			await tx`insert into skus (model_id) values (${s.modelId}) on conflict do nothing`;
			await tx`update skus set offer_id = ${s.offerId}, offer_sku_id = ${s.skuId}, sourced_at = ${new Date(s.at)} where model_id = ${s.modelId} and offer_id is null`;
		}
		// 加购记录：按「时间 + 1688 规格」合成一行写入
		const groups = new Map<string, { at: string; spec: Spec; lines: { sn: string; modelId: string; qty: number }[] }>();
		let missing = 0;
		for (const c of carted) {
			const spec = latest.get(c.modelId);
			const [o] = await tx`select items from orders where sn = ${c.orderSn}`;
			const qty = (o?.items as { modelId: string; qty: number }[] | undefined)?.find((i) => i.modelId === c.modelId)?.qty;
			if (!spec || !qty) { missing++; continue; }
			const k = `${c.at}|${spec.offerId}|${spec.skuId}`;
			const g = groups.get(k) ?? { at: c.at, spec, lines: [] };
			g.lines.push({ sn: c.orderSn, modelId: c.modelId, qty });
			groups.set(k, g);
		}
		const [{ batch }] = await tx`select nextval('batch_seq')::text as batch` as any;
		for (const g of groups.values()) {
			const o = offers[g.spec.offerId];
			const sku = o?.skus.find((x) => x.skuId === g.spec.skuId);
			const qty = g.lines.reduce((n, l) => n + l.qty, 0);
			const params = { offerId: g.spec.offerId, skuId: g.spec.skuId, specId: sku?.specId ?? "", qty, title: o?.title ?? g.spec.offerId, sku: sku?.name || "（单规格）", price: sku?.price ?? null, lines: g.lines, newSources: [], account };
			await tx`
				insert into writes (batch, op, target, params, display, key, status, error, created_at, started_at, finished_at, host)
				values (${batch}, '加购', ${`1688:${params.offerId}:${params.skuId}`}, ${tx.json(params)}, ${`${params.title} / ${params.sku} × ${qty}（订单 ${[...new Set(g.lines.map((l) => l.sn))].join("、")}）`},
					${`cart:${g.lines.map((l) => `${l.sn}:${l.modelId}`).sort().join(",")}`}, '成功', '从 carted.json 迁来（x2 buy cart 加的，读回来核对过购物车件数）',
					${new Date(g.at)}, ${new Date(g.at)}, ${new Date(g.at)}, 'carted.json')`;
		}
		return { offers: Object.keys(offers).length, sources: latest.size, cartWrites: groups.size, cartLines: carted.length - missing, skipped: missing };
	});
}
