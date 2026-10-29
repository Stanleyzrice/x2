// x2 rule：选品规矩（docs/listing.md「策略」）。所有策略共用的规矩，一行一条；旧的不删，停用时写结束时间和停用原因。
// 商品稿加进来时，在用的规矩记进它的选品快照
// x2 rule add "<规矩>" --why "…"          记一条规矩（从现在起在用）
// x2 rule retire <编号> --why "…"         停用：写结束时间、停用原因
// x2 rule list [--all]                    在用的规矩（--all：连停用的）
import { z } from "zod";
import { db } from "../core/db.ts";
import { Usage } from "../core/errors.ts";
import { when } from "../flows/listing/pick.ts";

const flag = (args: string[], name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const plain = (args: string[], ...flags: string[]) => args.filter((a, j) => !a.startsWith("--") && !flags.includes(args[j - 1] ?? ""));

const text = z.string().trim().min(1);
const USAGE = `x2 rule add "<规矩>" --why "为什么" | retire <编号> --why "为什么停用" | list [--all]（见 docs/listing.md「策略」）`;

type Rule = { id: string; rule: string; why: string; started_at: Date; ended_at: Date | null; retire_why: string | null };
const ruleLine = (r: Rule) =>
	`#${r.id} ${r.rule}${r.ended_at ? `（已停用：${when(r.started_at)} – ${when(r.ended_at)}）` : `（${when(r.started_at)} 起）`}\n  为什么：${r.why}${r.retire_why ? `\n  停用原因：${r.retire_why}` : ""}`;

export async function ruleCommand(args: string[], json: boolean): Promise<void> {
	const [sub, ...rest] = args;
	const sql = await db();
	const out = (value: unknown, text: string) => console.log(json ? JSON.stringify(value) : text);

	if (sub === "add") {
		const a = z.object({ rule: text, why: text }).safeParse({ rule: plain(rest, "--why").join(" "), why: flag(rest, "--why") });
		if (!a.success) throw new Usage(`x2 rule add "<规矩>" --why "为什么"（--why 必填）`);
		const [r] = await sql<
			Rule[]
		>`insert into selection_rules (rule, why) values (${a.data.rule}, ${a.data.why}) returning id::text, rule, why, started_at, ended_at, retire_why`;
		return out(r, `记下选品规矩 ${ruleLine(r!)}`);
	}

	if (sub === "retire") {
		const a = z.object({ id: z.string().regex(/^\d+$/), why: text }).safeParse({ id: plain(rest, "--why")[0], why: flag(rest, "--why") });
		if (!a.success) throw new Usage(`x2 rule retire <编号> --why "为什么停用"（--why 必填；编号见 x2 rule list）`);
		// 只停用在用的：已经停用的不改结束时间
		const [r] = await sql<Rule[]>`update selection_rules set ended_at = now(), retire_why = ${a.data.why} where id = ${a.data.id} and ended_at is null
			returning id::text, rule, why, started_at, ended_at, retire_why`;
		if (!r) {
			const [old] = await sql<Rule[]>`select id::text, rule, why, started_at, ended_at, retire_why from selection_rules where id = ${a.data.id}`;
			throw new Usage(old ? `选品规矩 #${old.id} 已经停用了（${when(old.ended_at!)}）` : `没有选品规矩 #${a.data.id}`);
		}
		return out(r, `停用选品规矩 ${ruleLine(r)}`);
	}

	if (sub === "list") {
		const all = rest.includes("--all");
		const rows = await sql<
			Rule[]
		>`select id::text, rule, why, started_at, ended_at, retire_why from selection_rules ${all ? sql`` : sql`where ended_at is null`} order by id`;
		return out(rows, rows.length ? rows.map(ruleLine).join("\n") : all ? "还没有选品规矩：x2 rule add" : "没有在用的选品规矩（x2 rule list --all 看停用的）");
	}

	throw new Usage(USAGE);
}
