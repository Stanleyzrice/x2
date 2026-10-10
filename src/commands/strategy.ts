// x2 strategy：选品的策略（docs/listing.md「策略」）。agent 定策略、做实验；每份商品稿记下从哪个策略来、按的是第几版，按策略看效果。
// x2 strategy add <名字> --bet "假设" --how "选品方法" [--why "…"]   记一个策略（试验中，第 1 版）
// x2 strategy set <名字> --why "…" [--status 使用中|已停用|试验中] [--bet "假设"] [--how "选品方法"] [--note …]
//                                                      改状态，或者边试边改假设、选法：版本号加 1，变更记录记一行（改之前、改之后、为什么）
// x2 strategy list                                     每个策略第几版、出了几份商品稿、上架了几个
// x2 strategy log <名字>                               这个策略的变更记录
import { z } from "zod";
import { db } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { when } from "../listing/pick.ts";

const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const STATUS = ["试验中", "使用中", "已停用"] as const;
const FLAGS = ["--bet", "--how", "--status", "--note", "--why"];
/** 变更记录里的列 → 中文 */
const FIELD = { status: "状态", bet: "假设", how: "选品方法", note: "备注" } as const;
type Field = keyof typeof FIELD;

const text = z.string().trim().min(1);
const addArgs = z.object({ name: text, bet: text, how: text, note: text.optional(), why: text.optional() });
const setArgs = z.object({ name: text, why: text, status: z.enum(STATUS).optional(), bet: text.optional(), how: text.optional(), note: z.string().trim().optional() })
	.refine((a) => a.status !== undefined || a.bet !== undefined || a.how !== undefined || a.note !== undefined);

/** 改了什么：「假设：旧 → 新」 */
const changeLines = (before: Record<string, unknown> | null, after: Record<string, unknown>) =>
	Object.entries(after).map(([k, v]) => `${FIELD[k as Field] ?? k}：${before && k in before ? `${before[k] ?? "（空）"} → ` : ""}${v ?? "（空）"}`);

export async function strategyCommand(args: string[], json: boolean): Promise<void> {
	const [sub, ...rest] = args;
	const sql = await db();
	const out = (value: unknown, text: string) => console.log(json ? JSON.stringify(value) : text);
	const name = rest.find((a, j) => !a.startsWith("--") && !FLAGS.includes(rest[j - 1] ?? ""));

	if (sub === "add") {
		const a = addArgs.safeParse({ name, bet: flag(rest, "--bet"), how: flag(rest, "--how"), note: flag(rest, "--note"), why: flag(rest, "--why") });
		if (!a.success) throw new Usage(`x2 strategy add <名字> --bet "假设" --how "选品方法" [--why "为什么定这个策略"] [--note …]`);
		const { bet, how, note, why } = a.data;
		const added = await sql.begin(async (tx) => {
			const [r] = await tx`insert into strategies (name, bet, how, note) values (${a.data.name}, ${bet}, ${how}, ${note ?? null}) on conflict (name) do nothing returning name`;
			if (!r) return false;
			await tx`insert into strategy_changes (strategy, version, after, why) values (${a.data.name}, 1, ${tx.json({ status: "试验中", bet, how, ...(note ? { note } : {}) })}, ${why ?? null})`;
			return true;
		});
		if (!added) throw new Usage(`已经有策略「${a.data.name}」了：改状态、假设、选法用 x2 strategy set`);
		return out({ name: a.data.name, version: 1, bet, how, status: "试验中" },
			`记下策略「${a.data.name}」（试验中，第 1 版）。上它选出来的货源：x2 listing add <店> <链接…> --strategy ${a.data.name} --why "为什么选它" --evidence "数据"`);
	}

	if (sub === "set") {
		const usage = `x2 strategy set <名字> --why "为什么改" [--status ${STATUS.join("|")}] [--bet "假设"] [--how "选品方法"] [--note …]（--why 必填；至少改一样）`;
		const a = setArgs.safeParse({ name, why: flag(rest, "--why"), status: flag(rest, "--status"), bet: flag(rest, "--bet"), how: flag(rest, "--how"), note: flag(rest, "--note") });
		if (!a.success) throw new Usage(usage);
		const { why, ...wanted } = a.data;
		// 锁住这一行：几个 x2 同时改，版本号不重
		const r = await sql.begin(async (tx) => {
			const [old] = await tx`select status, bet, how, note, version from strategies where name = ${wanted.name} for update`;
			if (!old) return null;
			const before: Record<string, unknown> = {}, after: Record<string, unknown> = {};
			for (const k of Object.keys(FIELD) as Field[]) {
				const v = wanted[k];
				if (v === undefined || v === (old[k] ?? "")) continue;
				before[k] = old[k];
				after[k] = v === "" ? null : v;
			}
			if (!Object.keys(after).length) return { version: old.version as number, before, after };
			const version = (old.version as number) + 1;
			await tx`update strategies set ${tx(after as any)}, version = ${version}, updated_at = now() where name = ${wanted.name}`;
			await tx`insert into strategy_changes (strategy, version, before, after, why) values (${wanted.name}, ${version}, ${tx.json(before as any)}, ${tx.json(after as any)}, ${why})`;
			return { version, before, after };
		});
		if (!r) throw new Usage(`没有策略「${wanted.name}」`);
		if (!Object.keys(r.after).length) return out({ name: wanted.name, version: r.version, changed: false }, `策略「${wanted.name}」没有变（还是第 ${r.version} 版）`);
		return out({ name: wanted.name, version: r.version, changed: true, before: r.before, after: r.after, why },
			`策略「${wanted.name}」改成第 ${r.version} 版：\n  ${changeLines(r.before, r.after).join("\n  ")}\n  为什么：${why}`);
	}

	if (sub === "list") {
		const rows = await sql`
			select s.name, s.status, s.version, s.bet, s.how,
				count(l.id)::int as listings,
				count(l.id) filter (where l.listed_at is not null)::int as live,
				count(l.id) filter (where l.cancelled)::int as cancelled
			from strategies s left join listings l on l.strategy = s.name
			group by s.name order by s.created_at`;
		return out(rows, rows.map((r) => `${r.name}（${r.status}，第 ${r.version} 版）：商品稿 ${r.listings} 份，上架 ${r.live} 个${r.cancelled ? `，已放弃 ${r.cancelled}` : ""}\n  假设：${r.bet ?? ""}\n  选品方法：${r.how ?? ""}`).join("\n"));
	}

	if (sub === "log") {
		if (!name) throw new Usage("x2 strategy log <名字>");
		const [s] = await sql`select version from strategies where name = ${name}`;
		if (!s) throw new Usage(`没有策略「${name}」`);
		const rows = (await sql`select version, before, after, why, changed_at from strategy_changes where strategy = ${name} order by version`)
			.map((r) => ({ version: r.version as number, before: r.before, after: r.after, why: r.why, changedAt: r.changed_at }));
		// 加版本号之前记的策略没有第 1 版的记录
		const first = rows[0]?.version === 1 ? [] : ["第 1 版：加版本号之前记的，没有记录"];
		return out({ name, version: s.version, changes: rows }, [
			`策略「${name}」现在是第 ${s.version} 版`, ...first,
			...rows.map((r) => `第 ${r.version} 版（${when(r.changedAt)}）${r.version === 1 ? "：记下" : ""}\n  ${changeLines(r.before, r.after).join("\n  ")}${r.why ? `\n  为什么：${r.why}` : ""}`),
		].join("\n"));
	}

	throw new Usage("x2 strategy add | set | list | log（见 docs/listing.md「策略」）");
}
