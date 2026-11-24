// 研究运行持久化：请求幂等、全库单活跃、持有会话锁；进程丢失后只标中断，不自动重做。
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type postgres from "postgres";
import { z } from "zod";
import type { Json, Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import {
	candidateSchema,
	eventSchema,
	type RunCandidate,
	type RunDetail,
	type RunEventData,
	type RunSnapshot,
	type RunStatus,
	type RunSummary,
	runStatus,
} from "../../platform/ui/interactable/selection/contract.ts";
import { socialDiscoveryStrategy } from "../../platform/ui/interactable/selection/types.ts";

export type { RunCandidate, RunDetail, RunEvent, RunEventData, RunStatus, RunSummary } from "../../platform/ui/interactable/selection/contract.ts";

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
	deleted_at: Date | null;
	error: string | null;
	events: unknown;
	candidates: unknown;
	cancel_requested: boolean;
	config: unknown;
	stopped_at_step?: string | null;
	stop_reason?: string | null;
};
const stopFields = (sql: Sql) => sql`
	case when status in ('needs-human','failed','interrupted') then (
		select event->>'step' from jsonb_array_elements(events) with ordinality as history(event, position)
		where event->>'step' not in ('停止原因','工具读取受限','工具事实')
		order by position desc limit 1
	) end as stopped_at_step,
	case when status='completed' and events->-1->'data'->>'kind'='stop' then
		case when events->-1->>'step'='完成' and events->-2->>'step'='停止补充' then events->-2->'data'->>'reason'
			else events->-1->'data'->>'reason' end
	end as stop_reason`;
export function runSnapshot(config: unknown): RunSnapshot {
	const parsed = z
		.object({ strategy: z.object({ steps: z.array(z.string()) }).optional(), agent: z.object({ model: z.string(), reasoningEffort: z.string() }).optional() })
		.safeParse(config);
	if (!parsed.success) return {};
	return { ...(parsed.data.strategy ? { workflow: parsed.data.strategy.steps } : {}), ...(parsed.data.agent ? { agent: parsed.data.agent } : {}) };
}
type SummaryRow = Omit<Row, "request_id" | "input_fingerprint" | "events" | "candidates" | "config" | "cancel_requested" | "deleted_at"> & {
	existing_count?: number;
};
const summary = (r: SummaryRow): RunSummary => ({
	id: r.id,
	shop: r.shop,
	strategyId: r.strategy_id,
	strategyName: r.strategy_name,
	limit: r.limit_count,
	brief: r.brief,
	status: runStatus.parse(r.status),
	step: r.step,
	...(r.stopped_at_step ? { stoppedAtStep: r.stopped_at_step } : {}),
	...(r.stop_reason ? { stopReason: r.stop_reason } : {}),
	found: r.found,
	...(r.strategy_id === socialDiscoveryStrategy ? { selected: r.found + (r.existing_count ?? 0) } : {}),
	createdAt: r.created_at.toISOString(),
	updatedAt: r.updated_at.toISOString(),
	error: r.error,
});
const detail = (r: Row): RunDetail => {
	const candidates = z.array(candidateSchema).parse(r.candidates);
	return {
		...summary({ ...r, existing_count: candidates.filter((candidate) => candidate.status === "existing").length }),
		events: z.array(eventSchema).parse(r.events),
		candidates,
		cancelRequested: r.cancel_requested,
		...(r.deleted_at ? { deleted: true } : {}),
		...runSnapshot(r.config),
	};
};

export async function deleteRun(sql: Sql, shop: string, id: string): Promise<{ id: string }> {
	const [deleted] = await sql<{ id: string }[]>`update selection_runs set deleted_at=coalesce(deleted_at, now())
		where id=${id} and shop=${shop} and status not in ('queued','running') returning id`;
	if (!deleted) throw new Usage("找不到可删除的研究记录，或研究仍在进行");
	return deleted;
}

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
		const query = connection(id);
		const [r] = await query<Row[]>`select *, ${stopFields(query)} from selection_runs where id=${id}`;
		return r ? detail(r) : null;
	};
	const sameRequest = async (input: RunCreation, query = connection()) => {
		const [r] = await query<Row[]>`select *, ${stopFields(query)} from selection_runs where request_id=${input.requestId}`;
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
		list: async (shop) => {
			const query = connection();
			return (
				await query<SummaryRow[]>`select id, shop, strategy_id, strategy_name, limit_count, brief, status, step, found, created_at, updated_at, error,
					${stopFields(query)},
					case when strategy_id = ${socialDiscoveryStrategy} then
						(select count(*)::int from jsonb_array_elements(candidates) entry where entry->>'status' = 'existing')
					end as existing_count
					from selection_runs where deleted_at is null and (${shop ?? null}::text is null or shop=${shop ?? null})
					order by created_at desc limit 40`
			).map(summary);
		},
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
