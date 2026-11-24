import { z } from "zod";
import { localTool } from "../../platform/mcp.ts";
import { invoke } from "../../platform/tool.ts";
import type { HermesModel } from "../../platform/ui/hermes-schema.ts";
import { candidateSchema, runOutcome, runOutcomeDetail, runStatus } from "../../platform/ui/interactable/selection/contract.ts";
import { strategyIds } from "../../platform/ui/interactable/selection/types.ts";

const summary = z.object({
	id: z.uuid(),
	strategyName: z.string(),
	status: runStatus,
	step: z.string(),
	stoppedAtStep: z.string().optional(),
	error: z.string().nullable(),
	stopReason: z.string().optional(),
	limit: z.number(),
	found: z.number(),
	selected: z.number().optional(),
});
function withOutcome<T extends z.output<typeof summary>>(run: T) {
	return { ...run, outcome: runOutcome(run), detail: runOutcomeDetail(run) };
}
const decisionSteps = new Set(["原帖证据不足", "购买证据不足", "趋势未通过", "搜索未完成", "货源未读全", "候选排除", "本批研究核对", "停止补充"]);
const savedCandidate = z
	.object(candidateSchema.shape)
	.pick({ title: true, sourceId: true, offerId: true, status: true, reason: true, qualification: true, problems: true });
const receipt = z.union([
	z.object({ id: z.uuid(), deleted: z.literal(true) }),
	summary
		.extend({
			events: z.array(z.object({ step: z.string(), message: z.string() })).transform((events) =>
				events
					.filter((event) => decisionSteps.has(event.step))
					.slice(-6)
					.map(({ step, message }) => ({ step, message: message.slice(0, 500) })),
			),
			candidates: z.array(savedCandidate).transform((candidates) => candidates.filter((item) => item.status !== "rejected")),
		})
		.transform(withOutcome),
]);
const workbench = z.object({
	strategies: z.array(z.object({ id: z.enum(strategyIds), name: z.string() })),
	runs: z.array(summary).transform((runs) => runs.slice(0, 8).map(withOutcome)),
});

export function chatSelectionTools(shop: string, model: HermesModel, requestId: string, source: "cli" | "web", call = invoke) {
	return [
		localTool("selection_workbench", "读取当前店铺可用的选品策略和最近任务。只查询，不启动。", z.object({}), async () =>
			workbench.parse(await call("selection.workbench", { shop }, "web")),
		),
		localTool(
			"selection_start",
			"用户明确要求执行时，启动一项策略选品，名额为1到10，只保存研究备选。重复调用沿用本轮请求。",
			z.object({
				strategyId: z.enum(strategyIds),
				limit: z.number().int().min(1).max(10).optional(),
				brief: z.string().trim().max(2000).optional().describe("用户指定的研究方向，未指定则留空"),
			}),
			async (input) => receipt.parse(await call("selection.run-start", { ...input, shop, model, requestId }, source)),
		),
		localTool("selection_result", "按原任务编号读取当前店铺的进度、停止原因和已保存备选编号。", z.object({ runId: z.uuid() }), async ({ runId }) =>
			receipt.parse(await call("selection.run-detail", { shop, runId }, source)),
		),
	];
}
