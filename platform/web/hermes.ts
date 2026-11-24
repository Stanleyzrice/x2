import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { Json, Sql } from "../db/index.ts";
import { NeedsHuman, Usage } from "../errors.ts";
import { withHermesOutput } from "../hermes-output.ts";
import { type ToolTraceStep, withToolTrace } from "../mcp.ts";
import { invoke } from "../tool.ts";
import { chatAttachmentText, type HermesModel, type HermesTurn, hermesChatFields, hermesModel, validChat } from "../ui/hermes-schema.ts";
import {
	conversationEntries,
	conversationTitle,
	deleteConversation,
	type HistoryMessage,
	importConversation,
	listConversations,
	readConversation,
	saveImportedConversation,
} from "./hermes-history.ts";
import { HermesLiveRun, sendHermesEvent } from "./hermes-stream.ts";
import { type Route, requireLocal } from "./setup.ts";

const requestId = z.uuid();
const chat = hermesChatFields.extend({ kind: z.literal("chat"), id: requestId, conversationId: requestId.optional() }).refine(validChat);
const publish = z
	.object({
		kind: z.literal("publish"),
		id: requestId,
		conversationId: requestId.optional(),
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

export type RunRow = Omit<HermesRun, "state"> & {
	state: Exclude<HermesRun["state"], "interrupted">;
	owner: string;
	fingerprint: string;
	message: string | null;
	context: string | null;
	model: HermesModel | null;
};

export function hermesRoutes(workspace: () => Promise<Sql>, port: () => number) {
	const owner = randomUUID();
	const liveRuns = new Map<string, HermesLiveRun>();
	const publicRun = (run: RunRow): HermesRun => ({
		id: run.id,
		kind: run.kind,
		state: run.state === "running" && run.owner !== owner ? "interrupted" : run.state,
		result: run.result,
		error: run.error,
		trace: [...(liveRuns.get(run.id)?.steps.values() ?? run.trace)],
	});
	const getRun = async (sql: Sql, id: string) => {
		const [row] = await sql<RunRow[]>`select * from hermes_web_runs where id = ${id}`;
		if (!row) throw new Usage("未找到该任务");
		return row;
	};
	const routes: Record<string, Route> = {
		"GET /api/hermes/conversations": async (_body, _url, req) => {
			requireLocal(req, port());
			return listConversations(await workspace());
		},
		"GET /api/hermes/conversation": async (_body, url, req) => {
			requireLocal(req, port());
			const id = requestId.safeParse(url.searchParams.get("id"));
			if (!id.success) throw new Usage("会话编号无效");
			return readConversation(await workspace(), id.data, publicRun);
		},
		"DELETE /api/hermes/conversation": async (_body, url, req) => {
			requireLocal(req, port());
			const id = requestId.safeParse(url.searchParams.get("id"));
			if (!id.success) throw new Usage("会话编号无效");
			return deleteConversation(await workspace(), id.data, owner);
		},
		"POST /api/hermes/conversation/import": async (body, _url, req) => {
			requireLocal(req, port());
			const parsed = importConversation.safeParse(body);
			if (!parsed.success || (!parsed.data.turns.length && !parsed.data.runIds.length)) throw new Usage("旧会话内容无法导入");
			return saveImportedConversation(await workspace(), parsed.data);
		},
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
			const p = parsed.data;
			const sql = await workspace();
			const fingerprint = createHash("sha256").update(JSON.stringify(p)).digest("hex");
			const replay = (prior: RunRow) => {
				if (prior.fingerprint !== fingerprint) throw new Usage("该任务编号已用于其他内容");
				return { claimed: false, row: prior, history: [] as HermesTurn[] };
			};
			const { claimed, row, history } = await sql.begin(async (tx) => {
				if (p.conversationId) {
					const [removed] = await tx`select id from hermes_conversations where id=${p.conversationId} and deleted_at is not null`;
					if (removed) throw new Usage("这条会话已删除，请开始新对话");
				}
				const [prior] = await tx<RunRow[]>`select * from hermes_web_runs where id=${p.id}`;
				if (prior) return replay(prior);
				if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new NeedsHuman("请先在设置中连接 DeepSeek");
				const message = p.kind === "chat" ? p.message : `上架任务 · ${p.shop} · ${p.sourceIds.length} 件备选`;
				const context = p.kind === "chat" ? chatAttachmentText(p.attachments ?? []) : `备选编号 ${p.sourceIds.join("、")}`;
				let history = p.kind === "chat" ? p.history : [];
				if (p.conversationId) {
					const title = conversationTitle(message, "资料对话");
					await tx`insert into hermes_conversations (id, title) values (${p.conversationId}, ${title}) on conflict (id) do nothing`;
					const [conversation] = await tx<
						{ imported: HistoryMessage[]; deleted_at: Date | null }[]
					>`select imported, deleted_at from hermes_conversations where id=${p.conversationId} for update`;
					if (conversation?.deleted_at) throw new Usage("这条会话已删除，请开始新对话");
					const recent = await tx<RunRow[]>`select * from hermes_web_runs where conversation_id=${p.conversationId} order by created_at desc, id desc limit 16`;
					const same = recent.find((run) => run.id === p.id);
					if (same) return replay(same);
					if (recent.some((run) => run.state === "running" && run.owner === owner)) throw new Usage("这条会话还有任务正在执行");
					history = conversationEntries(conversation?.imported ?? [], recent.reverse(), publicRun)
						.flatMap((entry) =>
							entry.role === "task"
								? []
								: [
										{
											role: entry.role,
											content: [entry.content, entry.context].filter(Boolean).join("\n\n").slice(0, 30_000),
										},
									],
						)
						.filter((entry) => entry.content.trim())
						.slice(-16);
				}
				const [row] = await tx<RunRow[]>`insert into hermes_web_runs (id, owner, kind, fingerprint, state, conversation_id, message, context, model, created_at)
					values (${p.id}, ${owner}, ${p.kind}, ${fingerprint}, 'running', ${p.conversationId ?? null},
					${p.conversationId ? message : null}, ${p.conversationId ? context || null : null}, ${p.model ?? null}, clock_timestamp())
					on conflict (id) do nothing returning *`;
				if (!row) {
					const [again] = await tx<RunRow[]>`select * from hermes_web_runs where id=${p.id}`;
					if (!again) throw new Usage("未找到原任务，请重试同一请求");
					const result = replay(again);
					return result;
				}
				if (p.conversationId) await tx`update hermes_conversations set updated_at=clock_timestamp() where id=${p.conversationId}`;
				return { claimed: true, row, history };
			});
			if (!claimed) return publicRun(row);
			const run = async () => {
				const live = new HermesLiveRun();
				liveRuns.set(p.id, live);
				try {
					const result = await withToolTrace(
						(step) => live.record(step),
						() =>
							p.kind === "chat"
								? withHermesOutput(
										(delta) => live.append(delta),
										() => invoke("listing.hermes-chat", { ...p, history, requestId: p.id }, "web"),
									)
								: invoke("listing.source-hermes", { ...p, publish: true }),
					);
					await sql`update hermes_web_runs set state='completed', result=${sql.json(result as Json)}, trace=${sql.json([...live.steps.values()])}
						where id=${p.id} and owner=${owner} and state='running'`;
				} catch (error) {
					const message = error instanceof NeedsHuman || error instanceof Usage ? error.message : "x2bot 任务中断，请查看原商品稿和发布回执";
					await sql`update hermes_web_runs set state='failed', error=${message}, trace=${sql.json([...live.steps.values()])}
						where id=${p.id} and owner=${owner} and state='running'`;
				} finally {
					live.finish();
					liveRuns.delete(p.id);
				}
			};
			void run().catch(() => {}); // 进程中断或数据库失联时保留领取状态，查询显示原任务待核对。
			return publicRun(row);
		},
	};
	async function stream(url: URL, req: IncomingMessage, res: ServerResponse) {
		requireLocal(req, port());
		const id = requestId.safeParse(url.searchParams.get("id"));
		if (!id.success) throw new Usage("任务编号无效");
		const row = await getRun(await workspace(), id.data);
		if (res.destroyed) return;
		res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
		const live = row.state === "running" && row.owner === owner ? liveRuns.get(row.id) : undefined;
		if (live) live.subscribe(res);
		else {
			sendHermesEvent(res, "done", null);
			res.end();
		}
	}
	return {
		routes,
		stream,
		closeStreams: () => {
			for (const run of liveRuns.values()) run.closeStreams();
		},
	};
}
