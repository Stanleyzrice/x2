// 选品可追溯：记录策略版本，以及 skills 规则文件的位置与摘要；历史快照兼容旧规则编号，不复制新的规则正文。

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { offerIdOf } from "../../connectors/sites/1688/api.ts";
import type { Json, Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";

export type PickSnapshot = {
	at: string;
	backfilled: boolean;
	strategy: { name: string; version: number; bet: string | null; how: string | null; status: string } | { name: string; missing: true };
	rules: { id: string; rule: string }[];
	ruleSource?: { path: string; sha256: string };
};

export async function pickSnapshot(sql: Sql, strategy: string, backfilled = false): Promise<PickSnapshot> {
	const [s] = await sql`select name, version, bet, how, status from strategies where name = ${strategy}`;
	const path = "skills/selection/references/rules.md";
	const content = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
	return {
		at: new Date().toISOString(),
		backfilled,
		strategy: s ? { name: s.name, version: s.version, bet: s.bet, how: s.how, status: s.status } : { name: strategy, missing: true },
		rules: [],
		ruleSource: { path, sha256: createHash("sha256").update(content).digest("hex") },
	};
}

export function snapshotLine(s: PickSnapshot): string {
	const st = "missing" in s.strategy ? `策略「${s.strategy.name}」（库里没有）` : `策略「${s.strategy.name}」第 ${s.strategy.version} 版`;
	const rules = s.ruleSource
		? `规则文件 ${s.ruleSource.path}（${s.ruleSource.sha256.slice(0, 12)}）`
		: s.rules.length
			? `历史选品规矩 ${s.rules.map((r) => `#${r.id}`).join(" ")}`
			: "没有记录规则来源";
	return `${s.backfilled ? `补记于 ${when(s.at)}，按现在的` : `${when(s.at)}，按`}${st}、${rules}`;
}

const when = (t: string | Date) => new Date(t).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);

export type Added = { id: string; offerId: string; isNew: boolean; why: string | null; evidence: string | null; snapshot: PickSnapshot | null };

export async function addListings(
	sql: Sql,
	a: { shop: string; links: string[]; strategy?: string; why?: string; evidence?: string },
): Promise<{ added: Added[]; snapshot: PickSnapshot }> {
	const strategy = a.strategy ?? "人选";
	const [st] = await sql`select name from strategies where name = ${strategy}`;
	if (!st) throw new Usage(`没有策略「${strategy}」：参见 skills/selection/SKILL.md`);
	const [s] = await sql`select shop from shop_settings where shop = ${a.shop}`;
	if (!s) throw new Usage(`没有「${a.shop}」这家店（店铺设置里有的：${(await sql`select shop from shop_settings`).map((r) => r.shop).join("、")}）`);
	const offerIds = a.links.map((link) => {
		const id = offerIdOf(link);
		if (!id) throw new Usage(`认不出 1688 链接：${link}`);
		return id;
	});
	const snapshot = await pickSnapshot(sql, strategy);
	const added: Added[] = [];
	for (const offerId of offerIds) {
		const [r] = await sql`insert into listings (shop, offer_id, strategy, pick_why, pick_evidence, pick_snapshot)
			values (${a.shop}, ${offerId}, ${strategy}, ${a.why ?? null}, ${a.evidence ?? null}, ${sql.json(snapshot as Json)})
			on conflict (shop, offer_id) do update set updated_at = listings.updated_at returning id::text, (xmax = 0) as is_new, pick_why, pick_evidence, pick_snapshot`;
		added.push({ id: r!.id, offerId, isNew: Boolean(r!.is_new), why: r!.pick_why, evidence: r!.pick_evidence, snapshot: r!.pick_snapshot });
	}
	return { added, snapshot };
}
