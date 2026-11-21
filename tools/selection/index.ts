// 选品记录：保存实验状态、方法文档引用、版本与历史；现行规则正文在 skills，历史数据库不作为规则维护入口。
import { z } from "zod";
import { codexStatus } from "../../connectors/services/codex/index.ts";
import { db, type Json } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { flag, get, str, type Toolkit } from "../../platform/tool.ts";
import { defaultSelectionLimit } from "../../platform/ui/interactable/selection/types.ts";
import { loadRunConfig, loadSelectionPolicy, loadStrategyDefinitions, saveWorkflow, selectionStrategyId, workflowStepsSchema } from "./definitions.ts";
import { deleteRun, type RunDetail } from "./run-store.ts";
import { cancelRun, getRun, listRuns, recoverInterruptedRuns, startRun, timeSeriesSummaryTool } from "./runs.ts";
import { SELECTION_TABLES } from "./tables.ts";

const when = (t: string | Date) => new Date(t).toLocaleString("sv-SE", { hour12: false }).slice(0, 16);
const STATUS = ["试验中", "使用中", "已停用"] as const;
const FIELD = { status: "状态", bet: "假设", how: "方法引用", note: "备注" } as const;
type Field = keyof typeof FIELD;

/** 改策略：和现在一样的不算改（空的是清掉）；改了的记改之前、改之后，版本号加 1 */
export function strategyDiff(
	old: Partial<Record<Field, string | null>>,
	wanted: Partial<Record<Field, string>>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
	const before: Record<string, unknown> = {},
		after: Record<string, unknown> = {};
	for (const k of Object.keys(FIELD) as Field[]) {
		const v = wanted[k];
		if (v === undefined || v === (old[k] ?? "")) continue;
		before[k] = old[k];
		after[k] = v === "" ? null : v;
	}
	return { before, after };
}
const text = z.string().trim().min(1);
const skillRef = text.regex(/^skills\/[\w-]+\/(?:SKILL\.md|references\/[\w.-]+\.md)(?:#[\w-]+)?$/, "方法只保存 skills 下的 Markdown 文件引用");
const RULE_SOURCE = "skills/selection/references/rules.md";
const runReceipt = (run: RunDetail) => (run.deleted ? { id: run.id, shop: run.shop, deleted: true as const } : run);

const changeLines = (before: Record<string, unknown> | null, after: Record<string, unknown>) =>
	Object.entries(after).map(([k, v]) => `${FIELD[k as Field] ?? k}：${before && k in before ? `${before[k] ?? "（空）"} → ` : ""}${v ?? "（空）"}`);

type Rule = { id: string; rule: string; why: string; started_at: Date; ended_at: Date | null; retire_why: string | null };
const ruleLine = (r: Rule) =>
	`#${r.id} ${r.rule}${r.ended_at ? `（已停用：${when(r.started_at)} – ${when(r.ended_at)}）` : `（${when(r.started_at)} 起）`}\n  为什么：${r.why}${r.retire_why ? `\n  停用原因：${r.retire_why}` : ""}`;

export const selection: Toolkit = {
	name: "selection",
	title: "选品记录：策略实验、方法引用、规则历史",
	kind: "tool",
	tools: {
		"time-series-summary": timeSeriesSummaryTool,
		workbench: get("当前商品发现与组合设计流程、证据边界及agent状态；不自动启动研究", z.object({ shop: str("目标店铺") }), async ({ shop }) => {
			const sql = await db();
			await recoverInterruptedRuns(sql);
			const definitions = await loadStrategyDefinitions(sql, shop);
			const saved = await sql<{ name: string; status: string }[]>`select name, status from strategies`;
			const strategies = definitions.filter((definition) => !saved.some((row) => row.name === definition.name && row.status === "已停用"));
			const { methodology } = await loadSelectionPolicy();
			return { shop, strategies, methodology, agent: await codexStatus(), runs: await listRuns(sql, shop) };
		}),
		"workflow-save": get(
			"保存当前店铺的自定义研究步骤，不更改经营规则或已启动的研究",
			z.strictObject({ shop: str("目标店铺"), strategyId: selectionStrategyId, steps: workflowStepsSchema }),
			async (input) => ({ strategy: await saveWorkflow(await db(), input) }),
		),
		"workflow-reset": get(
			"恢复项目技能中的默认研究步骤，不更改已启动的研究",
			z.strictObject({ shop: str("目标店铺"), strategyId: selectionStrategyId }),
			async (input) => ({ strategy: await saveWorkflow(await db(), input) }),
		),
		"run-start": get(
			"按详细策略启动一次选品研究；候选只进入上架备选区，不采购或发布",
			z.strictObject({
				shop: str("目标店铺"),
				strategyId: selectionStrategyId,
				limit: z.coerce.number().int().min(1).max(10).optional(),
				brief: z.string().trim().max(2000).default(""),
				requestId: z.string().uuid(),
			}),
			async ({ requestId, limit, ...fields }, source) => {
				const input = { ...fields, limit: limit ?? defaultSelectionLimit(fields.strategyId) };
				const sql = await db();
				// 未收到启动回执时先查原请求；之后保存的流程不能改变该次运行快照。
				const [previous] = await sql<
					{ id: string; shop: string; strategy_id: string; limit_count: number; brief: string }[]
				>`select id,shop,strategy_id,limit_count,brief from selection_runs where request_id=${requestId}`;
				if (previous) {
					if (
						previous.shop !== input.shop ||
						previous.strategy_id !== input.strategyId ||
						previous.limit_count !== input.limit ||
						previous.brief !== input.brief
					)
						throw new Usage("该requestId已用于另一组研究输入，请使用新的请求编号");
					const run = await getRun(sql, previous.id);
					if (!run) throw new Usage("没有这家店的研究任务");
					return runReceipt(run);
				}
				const config = await loadRunConfig(sql, input);
				const agent = await codexStatus();
				if (agent.model && agent.reasoningEffort) config.agent = { model: agent.model, reasoningEffort: agent.reasoningEffort };
				const [saved] = await sql<{ status: string }[]>`select status from strategies where name = ${config.strategy.name}`;
				if (saved?.status === "已停用") throw new Usage("该策略已停用，请选择当前研究方法");
				await sql.begin(async (tx) => {
					const [added] = await tx`insert into strategies (name, bet, how, status)
						values (${config.strategy.name}, ${config.strategy.description}, ${config.strategy.policyPath}, '试验中')
						on conflict (name) do nothing returning name`;
					if (added)
						await tx`insert into strategy_changes (strategy, version, after, why)
						values (${config.strategy.name}, 1, ${tx.json({ status: "试验中", bet: config.strategy.description, how: config.strategy.policyPath })},
						'用户从策略工作台启动研究，按当前项目技能执行')`;
				});
				// 网页由服务继续执行，命令行等到结束再关闭数据库。
				return runReceipt(await startRun(sql, config, requestId, source === "web"));
			},
		),
		"run-detail": get("读取一项研究的步骤、证据及备选结果", z.strictObject({ shop: str("目标店铺"), runId: z.string().uuid() }), async ({ shop, runId }) => {
			const run = await getRun(await db(), runId);
			if (!run || run.shop !== shop) throw new Usage("没有这家店的研究任务");
			return runReceipt(run);
		}),
		"run-cancel": get(
			"停止研究；保留已经保存的备选，不再新增",
			z.strictObject({ shop: str("目标店铺"), runId: z.string().uuid() }),
			async ({ shop, runId }) => {
				const sql = await db();
				const run = await getRun(sql, runId);
				if (!run || run.shop !== shop || run.deleted) throw new Usage("没有这家店的研究任务");
				return cancelRun(sql, runId);
			},
		),
		"run-delete": get("删除历史研究记录，保留已保存的备选货源", z.strictObject({ shop: str("目标店铺"), runId: z.string().uuid() }), async ({ shop, runId }) =>
			deleteRun(await db(), shop, runId),
		),
		"strategy-add": get(
			"记一个策略（试验中，第 1 版）",
			z.object({
				name: text.describe("策略名"),
				bet: text.describe("假设"),
				how: skillRef.describe("方法文档引用"),
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
			{
				text: (r) => `记下策略「${r.name}」（试验中，第 1 版），方法引用：${r.how}`,
			},
		),
		"strategy-set": get(
			"改状态，或者边试边改假设、选法：版本号加 1，变更记录记一行（改之前、改之后、为什么）；和现在一样的不加。--why 必填，至少改一样",
			z
				.object({
					name: text.describe("策略名"),
					why: text.describe("为什么改"),
					status: z.enum(STATUS).optional().describe("状态"),
					bet: text.optional().describe("假设"),
					how: skillRef.optional().describe("方法文档引用"),
					note: z.string().trim().optional().describe("备注（空的是清掉）"),
				})
				.refine((a) => a.status !== undefined || a.bet !== undefined || a.how !== undefined || a.note !== undefined, { message: "至少改一样" }),
			async ({ why, ...wanted }) => {
				const r = await (await db()).begin(async (tx) => {
					const [old] = await tx<
						{ status: string | null; bet: string | null; how: string | null; note: string | null; version: number }[]
					>`select status, bet, how, note, version from strategies where name = ${wanted.name} for update`;
					if (!old) return null;
					const { before, after } = strategyDiff(old, wanted);
					if (!Object.keys(after).length) return { version: old.version, before, after };
					const version = old.version + 1;
					await tx`update strategies set ${tx(after as Record<string, Json>)}, version = ${version}, updated_at = now() where name = ${wanted.name}`;
					await tx`insert into strategy_changes (strategy, version, before, after, why) values (${wanted.name}, ${version}, ${tx.json(before as Json)}, ${tx.json(after as Json)}, ${why})`;
					return { version, before, after };
				});
				if (!r) throw new Usage(`没有策略「${wanted.name}」`);
				if (!Object.keys(r.after).length) return { name: wanted.name, version: r.version, changed: false };
				return { name: wanted.name, version: r.version, changed: true, before: r.before, after: r.after, why };
			},
			{
				text: (r) =>
					r.changed
						? `策略「${r.name}」改成第 ${r.version} 版：\n  ${changeLines(r.before ?? null, r.after ?? {}).join("\n  ")}\n  为什么：${r.why}`
						: `策略「${r.name}」没有变（还是第 ${r.version} 版）`,
			},
		),
		"strategy-list": get(
			"每个策略第几版、出了几份商品稿、上架了几个",
			undefined,
			async () => (await db())`
					select s.name, s.status, s.version, s.bet, s.how,
						count(l.id)::int as listings,
						count(l.id) filter (where l.listed_at is not null)::int as live,
						count(l.id) filter (where l.cancelled)::int as cancelled
					from strategies s left join listings l on l.strategy = s.name
					group by s.name order by s.created_at`,
			{
				text: (rows) =>
					rows
						.map(
							(r) =>
								`${r.name}（${r.status}，第 ${r.version} 版）：商品稿 ${r.listings} 份，上架 ${r.live} 个${r.cancelled ? `，已放弃 ${r.cancelled}` : ""}\n  假设：${r.bet ?? ""}\n  选品方法：${r.how ?? ""}`,
						)
						.join("\n"),
			},
		),
		"strategy-log": get(
			"一个策略的变更记录",
			z.object({ name: str("策略名") }),
			async ({ name }) => {
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
			},
			{
				text: (r) =>
					[
						`策略「${r.name}」现在是第 ${r.version} 版`,
						...(r.changes[0]?.version === 1 ? [] : ["第 1 版：加版本号之前记的，没有记录"]),
						...r.changes.map(
							(c) =>
								`第 ${c.version} 版（${when(c.changedAt)}）${c.version === 1 ? "：记下" : ""}\n  ${changeLines(c.before, c.after).join("\n  ")}${c.why ? `\n  为什么：${c.why}` : ""}`,
						),
					].join("\n"),
			},
		),
		"rule-add": get("旧接口：现行规则在 skills 中编辑，不再写入数据库", z.object({ rule: text.describe("规矩"), why: text.describe("为什么") }), async () => {
			throw new Usage(`现行规则只在 ${RULE_SOURCE} 中维护`);
		}),
		"rule-retire": get(
			"旧接口：数据库规则为历史记录，现行规则在 skills 中编辑",
			z.object({ id: z.string().regex(/^\d+$/).describe("规矩编号（x2 selection rule-list）"), why: text.describe("为什么停用") }),
			async () => {
				throw new Usage(`历史记录不再改写；现行规则只在 ${RULE_SOURCE} 中维护`);
			},
		),
		"rule-list": get(
			"规则文件入口；--all 附数据库中的历史记录",
			z.object({ all: flag("附历史记录").default(false) }),
			async (p) => {
				const history = p.all
					? await (await db())<Rule[]>`select id::text, rule, why, started_at, ended_at, retire_why from selection_rules order by selection_rules.id`
					: [];
				return { source: RULE_SOURCE, history };
			},
			{ text: (r) => [`规则入口：${r.source}`, ...r.history.map(ruleLine)].join("\n") },
		),
	},
	tables: SELECTION_TABLES,
	schema: new URL("./schema.sql", import.meta.url),
};
