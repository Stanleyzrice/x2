import { z } from "zod";
import { type HermesModel, hermesModel } from "../../hermes-schema.ts";
import { type RunStatus, type RunSummary, type StartInput, type StrategyId, strategyIds } from "./types.ts";

const strategy = z.enum(strategyIds);
const startInput = z.object({
	strategyId: strategy,
	limit: z.number().int().min(1).max(10),
	brief: z.string().trim().max(2000),
	model: hermesModel.optional(),
	requestId: z.uuid(),
});

export function initialStrategy(search: string, saved: StrategyId | null): StrategyId | null {
	const requested = strategy.safeParse(new URLSearchParams(search).get("selectionStrategy"));
	return requested.success ? requested.data : saved;
}

export type SavedResearch = { strategyId: StrategyId | null; model: HermesModel | null; pendingStart: StartInput | null };
export function restoredResearch(raw: string | null): SavedResearch {
	const empty = { strategyId: null, model: null, pendingStart: null };
	try {
		const parsed = z
			.object({ strategyId: z.unknown().optional(), model: z.unknown().optional(), pendingStart: z.unknown().optional() })
			.safeParse(JSON.parse(raw ?? "null"));
		if (!parsed.success) return empty;
		const pending = startInput.safeParse(parsed.data.pendingStart);
		return {
			strategyId: pending.data?.strategyId ?? strategy.safeParse(parsed.data.strategyId).data ?? null,
			model: pending.data?.model ?? hermesModel.safeParse(parsed.data.model).data ?? null,
			pendingStart: pending.data ?? null,
		};
	} catch {
		return empty;
	}
}

export function createStartGate(restored: StartInput | null = null) {
	let submitting = false;
	let request = restored;
	return {
		begin(input: Omit<StartInput, "requestId">, makeId: () => string): StartInput | null {
			if (submitting) return null;
			if (
				request &&
				(request.strategyId !== input.strategyId || request.limit !== input.limit || request.brief !== input.brief || request.model !== input.model)
			)
				return null;
			request ??= { ...input, requestId: makeId() };
			submitting = true;
			return request;
		},
		settle(known: boolean) {
			submitting = false;
			if (known) request = null;
		},
	};
}

export const canCancelRun = (status: RunStatus) => status === "queued" || status === "running";

export function runOutcome(run: Pick<RunSummary, "status" | "found" | "limit" | "selected">): "成功" | "失败" | "需要处理" | null {
	if (canCancelRun(run.status)) return null;
	if (run.status === "completed") return (run.selected ?? run.found) >= run.limit ? "成功" : "需要处理";
	return run.status === "failed" || run.status === "cancelled" ? "失败" : "需要处理";
}

export function mergeRuns(runs: RunSummary[], received: RunSummary | null, shop: string): RunSummary[] {
	const byId = new Map(runs.filter((run) => run.shop === shop).map((run) => [run.id, run]));
	if (received?.shop === shop) {
		const current = byId.get(received.id);
		if (!current || received.updatedAt > current.updatedAt || (received.updatedAt === current.updatedAt && canCancelRun(current.status))) {
			byId.set(received.id, received);
		}
	}
	return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
