// 选品（x2 selection <工具>）：策略（假设、选品方法、版本号；每份商品稿记下从哪个策略来、按的是第几版，按策略看效果）和选品规矩（所有策略共用，旧的不删）。
// 别的 skill 用的（添加货源、选品快照）从这里拿
import { z } from "zod";
import { db } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { flag, get, str, type Toolkit } from "../../platform/tool.ts";
import { when } from "./pick.ts";
import { SELECTION_TABLES } from "./tables.ts";

export { type Added, addListings, type PickSnapshot, pickSnapshot, snapshotLine } from "./pick.ts";

const STATUS = ["试验中", "使用中", "已停用"] as const;
const FIELD = { status: "状态", bet: "假设", how: "选品方法", note: "备注" } as const;
type Field = keyof typeof FIELD;
const text = z.string().trim().min(1);

const changeLines = (before: Record<string, unknown> | null, after: Record<string, unknown>) =>
	Object.entries(after).map(([k, v]) => `${FIELD[k as Field] ?? k}：${before && k in before ? `${before[k] ?? "（空）"} → ` : ""}${v ?? "（空）"}`);

type Rule = { id: string; rule: string; why: string; started_at: Date; ended_at: Date | null; retire_why: string | null };
const ruleLine = (r: Rule) =>
	`#${r.id} ${r.rule}${r.ended_at ? `（已停用：${when(r.started_at)} – ${when(r.ended_at)}）` : `（${when(r.started_at)} 起）`}\n  为什么：${r.why}${r.retire_why ? `\n  停用原因：${r.retire_why}` : ""}`;

export const selection: Toolkit = {
	name: "selection",
	title: "选品：策略、选品规矩",
	kind: "skill",
	tools: {
		"strategy-add": {
			...get(
				"记一个策略（试验中，第 1 版）",
				z.object({
					name: text.describe("策略名"),
					bet: text.describe("假设"),
					how: text.describe("选品方法"),
					why: text.optional().describe("为什么定这个策略"),
					note: text.optional(),
				}),
				async ({ name, bet, how, note, why }) => {
					const added = await (await db()).begin(async (tx) => {
						const [r] =
							await tx`insert into strategies (name, bet, how, note) values (${name}, ${bet}, ${how}, ${note ?? null}) on conflict (name) do nothing returning name`;
						if (!r) return false;
						await tx`insert into strategy_changes (strategy, version, after, why) values (${name}, 1, ${tx.json({ status: "试验中", bet, how, ...(note ? { note } : {}) })}, ${why ?? null})`;
						return true;
					});
					if (!added) throw new Usage(`已经有策略「${name}」了：改状态、假设、选法用 x2 selection strategy-set`);
					return { name, version: 1, bet, how, status: "试验中" };
				},
			),
			text: (r) =>
				`记下策略「${r.name}」（试验中，第 1 版）。上它选出来的货源：x2 listing add --shop <店> --links <链接…> --strategy ${r.name} --why "为什么选它" --evidence "数据"`,
		},
		"strategy-set": {
			...get(
				"改状态，或者边试边改假设、选法：版本号加 1，变更记录记一行（改之前、改之后、为什么）；和现在一样的不加。--why 必填，至少改一样",
				z
					.object({
						name: text.describe("策略名"),
						why: text.describe("为什么改"),
						status: z.enum(STATUS).optional().describe("状态"),
						bet: text.optional().describe("假设"),
						how: text.optional().describe("选品方法"),
						note: z.string().trim().optional().describe("备注（空的是清掉）"),
					})
					.refine((a) => a.status !== undefined || a.bet !== undefined || a.how !== undefined || a.note !== undefined, { message: "至少改一样" }),
				async ({ why, ...wanted }) => {
					const r = await (await db()).begin(async (tx) => {
						const [old] = await tx`select status, bet, how, note, version from strategies where name = ${wanted.name} for update`;
						if (!old) return null;
						const before: Record<string, unknown> = {},
							after: Record<string, unknown> = {};
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
					if (!Object.keys(r.after).length) return { name: wanted.name, version: r.version, changed: false };
					return { name: wanted.name, version: r.version, changed: true, before: r.before, after: r.after, why };
				},
			),
			text: (r) =>
				r.changed
					? `策略「${r.name}」改成第 ${r.version} 版：\n  ${changeLines(r.before, r.after).join("\n  ")}\n  为什么：${r.why}`
					: `策略「${r.name}」没有变（还是第 ${r.version} 版）`,
		},
		"strategy-list": {
			...get(
				"每个策略第几版、出了几份商品稿、上架了几个",
				undefined,
				async () => (await db())`
					select s.name, s.status, s.version, s.bet, s.how,
						count(l.id)::int as listings,
						count(l.id) filter (where l.listed_at is not null)::int as live,
						count(l.id) filter (where l.cancelled)::int as cancelled
					from strategies s left join listings l on l.strategy = s.name
					group by s.name order by s.created_at`,
			),
			text: (rows) =>
				rows
					.map(
						(r: any) =>
							`${r.name}（${r.status}，第 ${r.version} 版）：商品稿 ${r.listings} 份，上架 ${r.live} 个${r.cancelled ? `，已放弃 ${r.cancelled}` : ""}\n  假设：${r.bet ?? ""}\n  选品方法：${r.how ?? ""}`,
					)
					.join("\n"),
		},
		"strategy-log": {
			...get("一个策略的变更记录", z.object({ name: str("策略名") }), async ({ name }) => {
				const sql = await db();
				const [s] = await sql`select version from strategies where name = ${name}`;
				if (!s) throw new Usage(`没有策略「${name}」`);
				const changes = (await sql`select version, before, after, why, changed_at from strategy_changes where strategy = ${name} order by version`).map(
					(r) => ({
						version: r.version as number,
						before: r.before,
						after: r.after,
						why: r.why,
						changedAt: r.changed_at,
					}),
				);
				return { name, version: s.version, changes };
			}),
			text: (r) =>
				[
					`策略「${r.name}」现在是第 ${r.version} 版`,
					...(r.changes[0]?.version === 1 ? [] : ["第 1 版：加版本号之前记的，没有记录"]),
					...r.changes.map(
						(c: any) =>
							`第 ${c.version} 版（${when(c.changedAt)}）${c.version === 1 ? "：记下" : ""}\n  ${changeLines(c.before, c.after).join("\n  ")}${c.why ? `\n  为什么：${c.why}` : ""}`,
					),
				].join("\n"),
		},
		"rule-add": {
			...get(
				"记一条选品规矩（从现在起在用；商品稿加进来时，在用的规矩记进它的选品快照）",
				z.object({ rule: text.describe("规矩"), why: text.describe("为什么") }),
				async (p) => {
					const [r] = await (await db())<
						Rule[]
					>`insert into selection_rules (rule, why) values (${p.rule}, ${p.why}) returning id::text, rule, why, started_at, ended_at, retire_why`;
					return r!;
				},
			),
			text: (r) => `记下选品规矩 ${ruleLine(r)}`,
		},
		"rule-retire": {
			...get(
				"停用一条选品规矩：写结束时间、停用原因（不删）",
				z.object({ id: z.string().regex(/^\d+$/).describe("规矩编号（x2 selection rule-list）"), why: text.describe("为什么停用") }),
				async (p) => {
					const sql = await db();
					const [r] = await sql<Rule[]>`update selection_rules set ended_at = now(), retire_why = ${p.why} where id = ${p.id} and ended_at is null
						returning id::text, rule, why, started_at, ended_at, retire_why`;
					if (!r) {
						const [old] = await sql<Rule[]>`select id::text, rule, why, started_at, ended_at, retire_why from selection_rules where id = ${p.id}`;
						throw new Usage(old ? `选品规矩 #${old.id} 已经停用了（${when(old.ended_at!)}）` : `没有选品规矩 #${p.id}`);
					}
					return r;
				},
			),
			text: (r) => `停用选品规矩 ${ruleLine(r)}`,
		},
		"rule-list": {
			...get("在用的选品规矩（--all：连停用的）", z.object({ all: flag("连停用的").default(false) }), async (p) => {
				const sql = await db();
				return sql<
					Rule[]
				>`select id::text, rule, why, started_at, ended_at, retire_why from selection_rules ${p.all ? sql`` : sql`where ended_at is null`} order by id`;
			}),
			text: (rows) => (rows.length ? rows.map(ruleLine).join("\n") : "没有选品规矩（x2 selection rule-list --all 看停用的；x2 selection rule-add 记一条）"),
		},
	},
	tables: SELECTION_TABLES,
	schema: new URL("./schema.sql", import.meta.url),
};
