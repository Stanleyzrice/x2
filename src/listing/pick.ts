// 选品可追溯（docs/listing.md「策略」）：商品稿加进来那一刻按的是哪一版策略、哪些选品规矩
import type { Sql } from "../db/index.ts";

/** 选品快照：策略（名字、版本号、假设、选法）、在用的选品规矩、时间。补记的 backfilled 是 true，at 是补记的时间，不是加进来的时间 */
export type PickSnapshot = {
	at: string;
	backfilled: boolean;
	strategy: { name: string; version: number; bet: string | null; how: string | null; status: string } | { name: string; missing: true };
	rules: { id: string; rule: string }[];
};

/** 现在的策略和在用的选品规矩 */
export async function pickSnapshot(sql: Sql, strategy: string, backfilled = false): Promise<PickSnapshot> {
	const [s] = await sql`select name, version, bet, how, status from strategies where name = ${strategy}`;
	const rules = await sql`select id::text, rule from selection_rules where ended_at is null order by id`;
	return {
		at: new Date().toISOString(),
		backfilled,
		strategy: s ? { name: s.name, version: s.version, bet: s.bet, how: s.how, status: s.status } : { name: strategy, missing: true },
		rules: rules.map((r) => ({ id: r.id as string, rule: r.rule as string })),
	};
}

/** 给人看的一行：按「策略」第 N 版、选品规矩 #1 #3 */
export function snapshotLine(s: PickSnapshot): string {
	const st = "missing" in s.strategy ? `策略「${s.strategy.name}」（库里没有）` : `策略「${s.strategy.name}」第 ${s.strategy.version} 版`;
	const rules = s.rules.length ? `选品规矩 ${s.rules.map((r) => `#${r.id}`).join(" ")}` : "没有在用的选品规矩";
	return `${s.backfilled ? `补记于 ${when(s.at)}，按现在的` : `${when(s.at)}，按`}${st}、${rules}`;
}

/** 本机时间，到分钟：2026-10-10 14:03 */
export const when = (t: string | Date) => new Date(t).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
