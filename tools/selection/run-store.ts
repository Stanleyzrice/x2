// 研究运行持久化：请求幂等、全库单活跃、持有会话锁；进程丢失后只标中断，不自动重做。
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type postgres from "postgres";
import { z } from "zod";
import type { Json, Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";

export const runStatus = z.enum(["queued", "running", "needs-human", "completed", "failed", "cancelled", "interrupted"]);
export type RunStatus = z.output<typeof runStatus>;
export type RunSummary = {
	id: string;
	shop: string;
	strategyId: string;
	strategyName: string;
	limit: number;
	brief: string;
	status: RunStatus;
	step: string;
	found: number;
	createdAt: string;
	updatedAt: string;
	error: string | null;
};
const factIndexes = z.array(z.number().int().nonnegative()).max(12);
const briefText = z.string().trim().min(1).max(500);
export const researchConclusionSchema = z.object({
	purchaseTask: briefText,
	demandLevel: z.enum(["unknown", "search", "purchase"]),
	queryFactIndexes: factIndexes,
	comparableGroup: briefText,
	deliverableDifference: briefText,
	differenceStatus: z.enum(["supported", "hypothesis", "unknown"]),
	failureConditions: z.array(briefText).min(1).max(6),
	missing: z.array(briefText).max(12),
});
export type ResearchConclusion = z.output<typeof researchConclusionSchema>;
export const researchAuditSchema = z.object({
	steps: z
		.array(
			z.object({
				stepIndex: z.number().int().positive(),
				status: z.enum(["supported", "partial", "not-applicable"]),
				conclusion: z.string().trim().min(1).max(200),
				queryFactIndexes: factIndexes,
				offerIds: z.array(z.string().regex(/^\d+$/)).max(15),
				missing: z.array(briefText).max(12),
			}),
		)
		.min(1)
		.max(12),
	stopReason: z.string().trim().min(1).max(500).nullable(),
});
export type ResearchAudit = z.output<typeof researchAuditSchema>;
export const researchQuerySchema = z.object({
	keyword: z.string().trim().min(1).max(80),
	sourceKeyword: z.string().trim().min(1).max(80),
	categoryPath: z.array(z.number().int().positive()).max(3),
	role: z.enum(["product", "main", "accessory"]).default("product"),
});
const trendFactSchema = z.object({
	wordId: z.number().int().positive(),
	word: z.string(),
	metric: z.string(),
	basis: z.enum(["daily", "observed", "rolling", "unknown"]),
	source: z.unknown().optional(),
	qualified: z.boolean(),
	reasons: z.array(z.string()),
	summary: z.unknown(),
});
export type TrendFact = z.output<typeof trendFactSchema>;
export const runEventDataSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("tool"),
		tool: z.string(),
		input: z.record(z.string(), z.unknown()),
		result: z.unknown().optional(),
		error: z.string().optional(),
	}),
	z.object({
		kind: z.literal("plan"),
		round: z.number().int().positive(),
		plan: z.object({ focus: z.string(), decision: z.string(), explanation: z.string(), queries: z.array(researchQuerySchema) }),
	}),
	z.object({
		kind: z.literal("query"),
		round: z.number().int().positive(),
		queryFactIndex: z.number().int().nonnegative(),
		fact: z.object({
			query: researchQuerySchema,
			observedAt: z.string(),
			updateTime: z.string().nullable(),
			words: z.array(z.unknown()),
			items: z.array(z.unknown()),
			competition: z.unknown(),
			needs: z.unknown(),
			errors: z.array(z.string()),
			searchSignal: z.boolean().nullable(),
			purchaseSignal: z.boolean().nullable(),
			demandScope: z.literal("keyword-category-or-whole-listing"),
			trend: trendFactSchema.optional(),
		}),
	}),
	z.object({
		kind: z.literal("analysis"),
		round: z.number().int().positive(),
		batch: z.number().int().positive(),
		summary: z.string(),
		audit: researchAuditSchema.optional(),
		research: z.array(researchConclusionSchema.extend({ offerId: z.string(), skuId: z.string() })),
	}),
	z.object({ kind: z.literal("stop"), reason: z.string(), added: z.number().int().nonnegative(), existing: z.number().int().nonnegative() }),
]);
export type RunEventData = z.output<typeof runEventDataSchema>;
export type RunEvent = z.output<typeof eventSchema>;
const receiptSchema = z.object({
	sourceId: z.string(),
	offerId: z.string(),
	status: z.enum(["added", "existing"]),
	sourceCapturedAt: z.string().optional(),
	reusedSnapshot: z.boolean().optional(),
});
export type RunCandidate = z.output<typeof candidateSchema>;
export type RunDetail = RunSummary &
	ReturnType<typeof runSnapshot> & {
		events: RunEvent[];
		candidates: RunCandidate[];
		cancelRequested: boolean;
	};
export type RunCreation = {
	requestId: string;
	fingerprint: string;
	shop: string;
	strategyId: string;
	strategyName: string;
	limit: number;
	brief: string;
	config: unknown;
};
export type RunLease = { run: RunDetail; created: boolean; release: () => Promise<void> };
export type RunStore = {
	open: (input: RunCreation) => Promise<RunLease>;
	list: (shop?: string) => Promise<RunSummary[]>;
	get: (id: string) => Promise<RunDetail | null>;
	event: (id: string, step: string, message: string, data?: RunEventData) => Promise<void>;
	candidate: (id: string, candidate: RunCandidate) => Promise<void>;
	running: (id: string) => Promise<void>;
	cancel: (id: string) => Promise<RunDetail | null>;
	shouldStop: (id: string) => Promise<boolean>;
	finish: (id: string, status: Exclude<RunStatus, "queued" | "running">, error?: string | null) => Promise<void>;
	recover: () => Promise<number>;
};

const LEASE_KEY = "x2 selection active research";
const eventSchema = z.object({ id: z.string(), step: z.string(), message: z.string(), at: z.string(), data: runEventDataSchema.optional() });
const candidateSchema = z.object({
	offerId: z.string(),
	url: z.string(),
	title: z.string(),
	sourceId: z.string().nullable(),
	status: z.enum(["added", "existing", "rejected"]),
	reason: z.string(),
	evidence: z.string(),
	problems: z.array(z.string()),
	hardProblems: z.array(z.string()).optional(),
	warnings: z.array(z.string()).optional(),
	pricing: z.unknown().optional(),
	research: researchConclusionSchema.optional(),
	receipt: receiptSchema.optional(),
});
type Row = {
	id: string;
	request_id: string;
	input_fingerprint: string;
	shop: string;
	strategy_id: string;
	strategy_name: string;
	limit_count: number;
	brief: string;
	status: string;
	step: string;
	found: number;
	created_at: Date;
	updated_at: Date;
	error: string | null;
	events: unknown;
	candidates: unknown;
	cancel_requested: boolean;
	config: unknown;
};
export function runSnapshot(config: unknown): { workflow?: string[]; agent?: { model: string; reasoningEffort: string } } {
	const parsed = z
		.object({ strategy: z.object({ steps: z.array(z.string()) }).optional(), agent: z.object({ model: z.string(), reasoningEffort: z.string() }).optional() })
		.safeParse(config);
	if (!parsed.success) return {};
	return { ...(parsed.data.strategy ? { workflow: parsed.data.strategy.steps } : {}), ...(parsed.data.agent ? { agent: parsed.data.agent } : {}) };
}
const detail = (r: Row): RunDetail => ({
	id: r.id,
	shop: r.shop,
	strategyId: r.strategy_id,
	strategyName: r.strategy_name,
	limit: r.limit_count,
	brief: r.brief,
	status: runStatus.parse(r.status),
	step: r.step,
	found: r.found,
	createdAt: r.created_at.toISOString(),
	updatedAt: r.updated_at.toISOString(),
	error: r.error,
	events: z.array(eventSchema).parse(r.events),
	candidates: z.array(candidateSchema).parse(r.candidates),
	cancelRequested: r.cancel_requested,
	...runSnapshot(r.config),
});
const summary = (r: Row): RunSummary => {
	const { events: _events, candidates: _candidates, cancelRequested: _cancel, workflow: _workflow, agent: _agent, ...value } = detail(r);
	return value;
};

export function sameRunInput(savedFingerprint: string, fingerprint: string): void {
	if (savedFingerprint !== fingerprint) throw new Usage("该requestId已用于另一组研究输入，请使用新的请求编号");
}

export function runShouldStop(row: { status: string; cancel_requested: boolean; lease_active: boolean } | null): boolean {
	return !row || row.cancel_requested || !["queued", "running"].includes(row.status) || !row.lease_active;
}

/** 重试相同来源不重复计数；已有备选保留结果但不占本次新增名额。 */
export function appendRunCandidate(previous: readonly RunCandidate[], next: RunCandidate): { candidates: RunCandidate[]; found: number } {
	const saved = z.array(candidateSchema).parse(previous);
	const candidate = candidateSchema.parse(next);
	const candidates = candidate.offerId && saved.some((item) => item.offerId === candidate.offerId) ? saved : [...saved, candidate];
	return { candidates, found: candidates.filter((item) => item.status === "added").length };
}

export function postgresRunStore(sql: Sql): RunStore {
	const leases = new Map<string, postgres.ReservedSql>();
	let opening: Promise<void> = Promise.resolve();
	const connection = (id?: string): Sql => (id ? leases.get(id) : undefined) ?? leases.values().next().value ?? sql;
	const serializeOpen = async <T>(operation: () => Promise<T>): Promise<T> => {
		const previous = opening;
		let done = () => {};
		opening = new Promise<void>((resolve) => {
			done = resolve;
		});
		await previous;
		try {
			return await operation();
		} finally {
			done();
		}
	};
	const get = async (id: string) => {
		const [r] = await connection(id)<Row[]>`select * from selection_runs where id=${id}`;
		return r ? detail(r) : null;
	};
	const sameRequest = async (input: RunCreation, query = connection()) => {
		const [r] = await query<Row[]>`select * from selection_runs where request_id=${input.requestId}`;
		if (!r) return null;
		sameRunInput(r.input_fingerprint, input.fingerprint);
		return detail(r);
	};
	const recover = async () => {
		const rows = await connection()`update selection_runs s set status='interrupted',step='执行进程已中断',error='执行者已失去连接，未自动重做',updated_at=now()
			where s.status in ('queued','running') and not exists (
				select 1 from pg_locks l,(select hashtextextended(${LEASE_KEY},0) as k) h
				where l.locktype='advisory' and l.granted and l.pid=s.backend_pid and l.objsubid=1
				and l.classid=((h.k >> 32) & 4294967295)::oid and l.objid=(h.k & 4294967295)::oid
			) returning id`;
		return rows.length;
	};
	return {
		get,
		recover,
		list: async (shop) =>
			(
				await connection()<Row[]>`select * from selection_runs where (${shop ?? null}::text is null or shop=${shop ?? null}) order by created_at desc limit 40`
			).map(summary),
		open: (input) =>
			serializeOpen(async () => {
				await recover();
				const old = await sameRequest(input);
				if (old) return { run: old, created: false, release: async () => {} };
				if (leases.size) throw new Usage("已有选品研究正在执行，请等待完成或取消后再开始");
				const conn = await sql.reserve();
				const requestKey = `x2 selection request:${input.requestId}`;
				let released = false;
				let requestLocked = false;
				let leaseLocked = false;
				let runId: string | undefined;
				const unlockRequest = async () => {
					if (!requestLocked) return;
					requestLocked = false;
					await conn`select pg_advisory_unlock(hashtextextended(${requestKey},0))`;
				};
				const release = async () => {
					if (released) return;
					released = true;
					if (runId) leases.delete(runId);
					try {
						await unlockRequest();
						if (leaseLocked) await conn`select pg_advisory_unlock(hashtextextended(${LEASE_KEY},0))`;
					} finally {
						conn.release();
					}
				};
				try {
					// 幂等锁只覆盖短暂创建，跨进程同请求不会在首行落库前误报忙。
					await conn`select pg_advisory_lock(hashtextextended(${requestKey},0))`;
					requestLocked = true;
					const repeated = await sameRequest(input, conn);
					if (repeated) {
						await release();
						return { run: repeated, created: false, release: async () => {} };
					}
					const [lock] = await conn<
						{ locked: boolean; pid: number }[]
					>`select pg_try_advisory_lock(hashtextextended(${LEASE_KEY},0)) as locked,pg_backend_pid() as pid`;
					leaseLocked = Boolean(lock?.locked);
					if (!leaseLocked) {
						await release();
						const repeated = await sameRequest(input);
						if (repeated) return { run: repeated, created: false, release: async () => {} };
						throw new Usage("已有选品研究正在执行，请等待完成或取消后再开始");
					}
					// 已独占全局租约，没有别的活跃执行者；不把连接池复用PID误认成旧行仍持锁。
					await conn`update selection_runs set status='interrupted',step='执行进程已中断',error='执行者已失去连接，未自动重做',updated_at=now() where status in ('queued','running')`;
					const id = randomUUID();
					const [r] = await conn<Row[]>`insert into selection_runs
					(id,request_id,input_fingerprint,shop,strategy_id,strategy_name,limit_count,brief,status,step,config,backend_pid,worker_host,worker_pid)
					values (${id},${input.requestId},${input.fingerprint},${input.shop},${input.strategyId},${input.strategyName},${input.limit},${input.brief},'queued','等待智能体规划',${conn.json(input.config as Json)},${lock!.pid},${hostname()},${process.pid})
					on conflict(request_id) do nothing returning *`;
					if (!r) {
						await release();
						const repeated = await sameRequest(input);
						if (!repeated) throw new Error("研究请求保存失败");
						return { run: repeated, created: false, release: async () => {} };
					}
					runId = id;
					leases.set(id, conn);
					await unlockRequest();
					return { run: detail(r), created: true, release };
				} catch (error) {
					await release();
					throw error;
				}
			}),
		event: async (id, step, message, data) => {
			const event = eventSchema.parse({ id: randomUUID(), step, message: message.slice(0, 600), at: new Date().toISOString(), ...(data ? { data } : {}) });
			const query = connection(id);
			// 保存已发生的事实与停止原因；取消只禁止继续业务操作，不抹掉迟到的真实回执。
			await query`update selection_runs set step=${step},events=events || ${query.json([event] as Json)},updated_at=now() where id=${id} and status in ('queued','running')`;
		},
		candidate: async (id, candidate) => {
			const query = connection(id);
			const saved = candidateSchema.parse(candidate);
			// 已导入结果允许在取消请求后记回；同offer重试不重复占用新增名额。
			await query`update selection_runs set candidates=candidates || ${query.json([saved] as Json)},found=found+${saved.status === "added" ? 1 : 0},updated_at=now()
				where id=${id} and status='running' and (${saved.offerId}='' or not exists
					(select 1 from jsonb_array_elements(candidates) previous where previous->>'offerId'=${saved.offerId}))`;
		},
		running: async (id) => {
			await connection(
				id,
			)`update selection_runs set status='running',step='智能体规划研究',updated_at=now() where id=${id} and status='queued' and not cancel_requested`;
		},
		cancel: async (id) => {
			await connection(
				id,
			)`update selection_runs set cancel_requested=true,step='正在取消，等待执行者停止',updated_at=now() where id=${id} and status in ('queued','running')`;
			return get(id);
		},
		shouldStop: async (id) => {
			const [r] = await connection(id)<{ cancel_requested: boolean; status: string; lease_active: boolean }[]>`
				select s.cancel_requested,s.status,exists (
					select 1 from pg_locks l,(select hashtextextended(${LEASE_KEY},0) as k) h
					where l.locktype='advisory' and l.granted and l.pid=s.backend_pid and l.objsubid=1
					and l.classid=((h.k >> 32) & 4294967295)::oid and l.objid=(h.k & 4294967295)::oid
				) as lease_active from selection_runs s where s.id=${id}`;
			return runShouldStop(r ?? null);
		},
		finish: async (id, status, error = null) => {
			await connection(id)`update selection_runs set status=case when cancel_requested then 'cancelled' else ${status} end,
				step=case when cancel_requested then '已取消' else ${status === "completed" ? "研究完成" : status === "needs-human" ? "需要人工处理" : "研究未完成"} end,
				error=${error},updated_at=now() where id=${id} and status in ('queued','running')`;
		},
	};
}
