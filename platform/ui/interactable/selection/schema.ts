// 策略选品固定目标店铺；网页只提交研究条件与任务引用，不允许替换店铺或执行上架。
import { z } from "zod";
import { title } from "../../props.ts";

export const description = "选择竞品对标、爆款周边、细分需求、组合销售或近期趋势攀升，由agent（智能代理）研究并将筛出的候选保存到上架备选区，供后续审核和上架";
export const props = z.strictObject({ shop: z.string().min(1), title });
export type Props = z.infer<typeof props>;
export const actions = {
	workbench: "selection.workbench",
	start: "selection.run-start",
	detail: "selection.run-detail",
	cancel: "selection.run-cancel",
	delete: "selection.run-delete",
	"save-workflow": "selection.workflow-save",
	"reset-workflow": "selection.workflow-reset",
};
export const inputs = ["strategyId", "limit", "brief", "requestId", "runId", "steps"];
export const examples: z.input<typeof props>[] = [{ shop: "cheeroutdoor", title: "策略选品" }];
