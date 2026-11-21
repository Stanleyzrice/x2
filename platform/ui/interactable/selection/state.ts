// 仅保留现行研究方法；提交锁在同一事件周期即生效，未收到结果时复用原请求避免重复研究。
import {
	type Candidate,
	type QueryFact,
	type RunDetail,
	type RunStatus,
	type RunSummary,
	type StartInput,
	type Strategy,
	type StrategyId,
	strategyIds,
	type Workbench,
} from "./types.ts";

export const statusLabels: Record<RunStatus, string> = {
	queued: "等待开始",
	running: "研究中",
	"needs-human": "需要处理",
	completed: "已完成",
	failed: "研究失败",
	cancelled: "已停止",
	interrupted: "已中断",
};

export const isStrategyId = (value: string): value is StrategyId => strategyIds.some((id) => id === value);
/** 直达参数仅用于首次选择；无效参数沿用已经保存的现行方法。 */
export function initialStrategy(search: string, savedId: string): StrategyId {
	const requested = new URLSearchParams(search).get("selectionStrategy");
	if (requested && isStrategyId(requested)) return requested;
	return isStrategyId(savedId) ? savedId : "peer-benchmark";
}
export const currentStrategies = (strategies: Strategy[]) => strategies.filter((strategy) => isStrategyId(strategy.id));
/** 分类只反映接口提供的依据，历史流程缺分类时保留原样。 */
export function strategyCounts(strategies: Strategy[]) {
	const current = currentStrategies(strategies);
	const discovery = current.filter((strategy) => strategy.kind === "discovery").length;
	const salesUnit = current.filter((strategy) => strategy.kind === "sales-unit").length;
	return { discovery, salesUnit, uncategorized: current.length - discovery - salesUnit, total: current.length };
}
export type WorkflowReceipt = { basis: Workbench | null; values: Record<string, Strategy> };
/** 保存回执只填补当前轮询的间隔；下一份服务端结果恢复权威，避免多窗口改流程后仍显示旧值。 */
export function workbenchStrategies(workbench: Workbench | null, receipt: WorkflowReceipt): Strategy[] {
	const overrides = receipt.basis === workbench ? receipt.values : {};
	return currentStrategies(workbench?.strategies ?? []).map((strategy) => overrides[strategy.id] ?? strategy);
}
export const canCancelRun = (status: RunStatus) => status === "queued" || status === "running";
export const isTerminalRun = (status: RunStatus) => !canCancelRun(status);
export const canRequestStart = (agentAvailable: boolean, pendingStart: boolean, submitting: boolean, runs: RunSummary[]) =>
	!submitting && (pendingStart || (agentAvailable && !runs.some((run) => canCancelRun(run.status))));

export function workflowInput(steps: string[]): { steps: string[] | null; error: string | null } {
	if (steps.length < 1 || steps.length > 12) return { steps: null, error: "研究步骤须为1至12条" };
	const trimmed = steps.map((step) => step.trim());
	if (trimmed.some((step) => !step || step.length > 1000)) return { steps: null, error: "每条步骤请填写1至1000个字符" };
	return { steps: trimmed, error: null };
}

export const workflowChanged = (saved: string[], draft: string[]) => JSON.stringify(saved) !== JSON.stringify(draft.map((step) => step.trim()));

/** 取消或保存编辑只清当前策略的本地草稿，不触碰服务端流程和其他策略的草稿。 */
export function discardWorkflowDraft(drafts: Record<string, string[]>, strategyId: string): Record<string, string[]> {
	const next = { ...drafts };
	delete next[strategyId];
	return next;
}

export function moveWorkflowStep(steps: string[], index: number, direction: -1 | 1): string[] {
	const target = index + direction;
	if (index < 0 || index >= steps.length || target < 0 || target >= steps.length) return steps;
	const reordered = [...steps];
	[reordered[index], reordered[target]] = [reordered[target]!, reordered[index]!];
	return reordered;
}

export function runOutcome(run: Pick<RunSummary, "status" | "found" | "limit" | "selected">): string {
	if (run.status !== "completed") return statusLabels[run.status];
	if (run.selected !== undefined) return run.selected < run.limit ? "研究结束 · 数量不足" : "已达选品目标";
	if (run.found === 0) return "未新增备选";
	if (run.found < run.limit) return "研究结束 · 数量不足";
	return "已达新增目标";
}

export function researchInput(strategyId: string, rawLimit: string, brief: string): { input: Omit<StartInput, "requestId"> | null; error: string | null } {
	if (!isStrategyId(strategyId)) return { input: null, error: "请选择一种当前研究方法" };
	const limit = Number(rawLimit);
	if (!rawLimit.trim() || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) return { input: null, error: "候选数量须为1至10的整数" };
	if (brief.trim().length > 2000) return { input: null, error: "研究方向请控制在2000字符以内" };
	return { input: { strategyId, limit, brief: brief.trim() }, error: null };
}

/** 载入失败条件只填表；后续由明确的开始操作创建新请求，不重发旧请求。 */
export function retryConditions(run: RunSummary): Omit<StartInput, "requestId"> | null {
	if (!["failed", "interrupted", "needs-human"].includes(run.status)) return null;
	return researchInput(run.strategyId, String(run.limit), run.brief).input;
}

export type SavedResearch = { strategyId: string; limit: string; brief: string; selectedRunId: string | null; pendingStart: StartInput | null };
export const emptyResearch = (): SavedResearch => ({ strategyId: "peer-benchmark", limit: "3", brief: "", selectedRunId: null, pendingStart: null });
const validRequestId = (value: unknown): value is string =>
	typeof value === "string" && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);

export function restoredResearch(raw: string | null): SavedResearch {
	const blank = emptyResearch();
	if (!raw) return blank;
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object") return blank;
		const saved: Record<string, unknown> = { ...value };
		const pending = saved.pendingStart;
		let pendingStart: StartInput | null = null;
		if (pending && typeof pending === "object") {
			const fields: Record<string, unknown> = { ...pending };
			const request = researchInput(
				typeof fields.strategyId === "string" ? fields.strategyId : "",
				String(fields.limit ?? ""),
				typeof fields.brief === "string" ? fields.brief : "",
			);
			if (request.input && validRequestId(fields.requestId)) pendingStart = { ...request.input, requestId: fields.requestId };
		}
		return {
			strategyId: pendingStart?.strategyId ?? (typeof saved.strategyId === "string" && isStrategyId(saved.strategyId) ? saved.strategyId : blank.strategyId),
			limit: pendingStart ? String(pendingStart.limit) : typeof saved.limit === "string" ? saved.limit : blank.limit,
			brief: pendingStart?.brief ?? (typeof saved.brief === "string" ? saved.brief : blank.brief),
			selectedRunId: typeof saved.selectedRunId === "string" && saved.selectedRunId.trim() ? saved.selectedRunId : null,
			pendingStart,
		};
	} catch {
		return blank;
	}
}

export function createStartGate(restored: StartInput | null = null) {
	let pending = false;
	let request: StartInput | null = restored;
	return {
		begin(input: Omit<StartInput, "requestId">, makeId: () => string): StartInput | null {
			if (pending) return null;
			if (request && (request.strategyId !== input.strategyId || request.limit !== input.limit || request.brief !== input.brief)) return null;
			request ??= { ...input, requestId: makeId() };
			pending = true;
			return request;
		},
		settle(received: boolean) {
			pending = false;
			if (received) request = null;
		},
	};
}

const updated = (run: RunSummary) => {
	const time = Date.parse(run.updatedAt);
	return Number.isFinite(time) ? time : 0;
};
const statusRank = (status: RunStatus) => (isTerminalRun(status) ? 2 : status === "running" ? 1 : 0);
const newer = (a: RunSummary, b: RunSummary) => updated(a) - updated(b) || statusRank(a.status) - statusRank(b.status);

export function mergeRuns(runs: RunSummary[], received: RunSummary | null, shop: string): RunSummary[] {
	const byId = new Map(runs.filter((run) => run.shop === shop).map((run) => [run.id, run]));
	if (received?.shop === shop) {
		const previous = byId.get(received.id);
		if (!previous || newer(received, previous) >= 0) byId.set(received.id, received);
	}
	return [...byId.values()].sort((a, b) => updated(b) - updated(a));
}

export function latestDetail(runId: string | null, ...details: (RunDetail | null)[]): RunDetail | null {
	return (
		details
			.filter((detail): detail is RunDetail => detail?.id === runId)
			.sort((a, b) => newer(b, a) || b.events.length - a.events.length || b.candidates.length - a.candidates.length)[0] ?? null
	);
}

export const candidateLabel = (candidate: Candidate) =>
	candidate.status === "rejected" ? "未纳入" : !candidate.sourceId ? "保存结果待核对" : candidate.status === "added" ? "已加入备选区" : "备选区已有";

/** 模型提出的引用必须对应已保存查询；缺项不补成事实。 */
export function candidateQueryEvidence(candidate: Pick<Candidate, "research">, events: RunDetail["events"]) {
	const queries = new Map(events.flatMap((event) => (event.data?.kind === "query" ? [[event.data.queryFactIndex, event.data.fact] as const] : [])));
	const facts: { index: number; fact: QueryFact }[] = [];
	const missingIndexes: number[] = [];
	for (const index of [...new Set(candidate.research?.queryFactIndexes ?? [])]) {
		const fact = queries.get(index);
		if (fact) facts.push({ index, fact });
		else missingIndexes.push(index);
	}
	return { facts, missingIndexes };
}

export function pricingFacts(pricing: unknown): { label: string; value: string }[] {
	if (typeof pricing !== "object" || pricing === null) return [];
	const values: Record<string, unknown> = { ...pricing };
	const facts: { label: string; value: string }[] = [];
	for (const [key, label, prefix] of [
		["priceTwd", "试算售价", "NT$"],
		["totalCostRmb", "成本", "¥"],
		["profitRmb", "模板毛利", "¥"],
	] as const) {
		const value = values[key];
		if (typeof value === "number" && Number.isFinite(value))
			facts.push({ label, value: `${prefix}${value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}` });
	}
	return facts;
}
