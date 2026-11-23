import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Json, Sql } from "../db/index.ts";
import { NeedsHuman, Usage } from "../errors.ts";
import { type ToolTraceStep, withToolTrace } from "../mcp.ts";
import { invoke } from "../tool.ts";
import { hermesChatFields, hermesModel, validChat } from "../ui/hermes-schema.ts";
import { type Route, requireLocal } from "./setup.ts";

const requestId = z.uuid();
const chat = hermesChatFields.extend({ kind: z.literal("chat"), id: requestId }).refine(validChat);
const publish = z
	.object({
		kind: z.literal("publish"),
		id: requestId,
		shop: z.string().trim().min(1).max(100),
		sourceIds: z.array(z.string().regex(/^\d+$/)).min(1).max(1000),
		confirmed: z.literal(true),
		trial: z.boolean().default(false),
		notes: z.string().trim().max(80_000).optional(),
		model: hermesModel.optional(),
	})
	.refine(({ trial, sourceIds }) => !trial || sourceIds.length === 1, "试单只接受一个备选编号");
const input = z.discriminatedUnion("kind", [chat, publish]);
export type HermesRequest = z.input<typeof input>;

type PublishResult = {
	shop: string;
	batch: string;
	summary: string;
	error: string | null;
	items: { sourceId: string; url: string | null; draft: { id: string; listedAt: string | null; pending: string[]; problems: string | null } | null }[];
};
export type HermesRun = {
	id: string;
	kind: "chat" | "publish";
	state: "running" | "completed" | "failed" | "interrupted";
	result: { text: string } | PublishResult | null;
	error: string | null;
	trace: ToolTraceStep[];
};
export type { ToolTraceStep } from "../mcp.ts";

type RunRow = Omit<HermesRun, "state"> & { state: Exclude<HermesRun["state"], "interrupted">; owner: string; fingerprint: string };

export function hermesRoutes(workspace: () => Promise<Sql>, port: () => number): Record<string, Route> {
	const owner = randomUUID();
	const liveTraces = new Map<string, Map<string, ToolTraceStep>>();
	const publicRun = (run: RunRow): HermesRun => ({
		id: run.id,
		kind: run.kind,
		state: run.state === "running" && run.owner !== owner ? "interrupted" : run.state,
		result: run.result,
		error: run.error,
		trace: [...(liveTraces.get(run.id)?.values() ?? run.trace)],
	});
	const getRun = async (sql: Sql, id: string) => {
		const [row] = await sql<RunRow[]>`select * from hermes_web_runs where id = ${id}`;
		if (!row) throw new Usage("未找到该任务");
		return row;
	};
	return {
		"GET /api/hermes/run": async (_b, url, req) => {
			requireLocal(req, port());
			const id = requestId.safeParse(url.searchParams.get("id"));
			if (!id.success) throw new Usage("任务编号无效");
			return publicRun(await getRun(await workspace(), id.data));
		},
		"POST /api/hermes/run": async (b, _url, req) => {
			requireLocal(req, port());
			const parsed = input.safeParse(b);
			if (!parsed.success) throw new Usage("请检查消息内容、备选范围和发布确认");
			if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new NeedsHuman("请先在设置中连接 DeepSeek");
			const p = parsed.data;
			const sql = await workspace();
			const fingerprint = createHash("sha256").update(JSON.stringify(p)).digest("hex");
			const [claimed] = await sql<
				RunRow[]
			>`insert into hermes_web_runs (id, owner, kind, fingerprint, state) values (${p.id}, ${owner}, ${p.kind}, ${fingerprint}, 'running')
				on conflict (id) do nothing returning *`;
			if (!claimed) {
				const prior = await getRun(sql, p.id);
				if (prior.fingerprint !== fingerprint) throw new Usage("该任务编号已用于其他内容");
				return publicRun(prior);
			}
			const run = async () => {
				const steps = new Map<string, ToolTraceStep>();
				liveTraces.set(p.id, steps);
				try {
					const result = await withToolTrace(
						(step) => {
							if (steps.size < 100 || steps.has(step.id)) steps.set(step.id, step);
						},
						() => (p.kind === "chat" ? invoke("listing.hermes-chat", p) : invoke("listing.source-hermes", { ...p, publish: true })),
					);
					await sql`update hermes_web_runs set state='completed', result=${sql.json(result as Json)}, trace=${sql.json([...steps.values()])} where id=${p.id} and owner=${owner}`;
				} catch (error) {
					const message = error instanceof NeedsHuman || error instanceof Usage ? error.message : "x2bot 任务中断，请查看原商品稿和发布回执";
					await sql`update hermes_web_runs set state='failed', error=${message}, trace=${sql.json([...steps.values()])} where id=${p.id} and owner=${owner}`;
				} finally {
					liveTraces.delete(p.id);
				}
			};
			void run().catch(() => {}); // 进程中断或数据库失联时保留领取状态，查询显示原任务待核对。
			return publicRun(claimed);
		},
	};
}
