// 网页策略表单和运行回执。
import type { HermesModel } from "../../hermes-schema.ts";
import type { RunDetail, RunSummary } from "./contract.ts";

export type { RunStatus, RunSummary } from "./contract.ts";

export const socialDiscoveryStrategy = "xiaohongshu-discovery";
export const strategyIds = ["peer-benchmark", "bestseller-accessories", "unmet-needs", "rising-demand", "bundle-sales", socialDiscoveryStrategy] as const;
export type StrategyId = (typeof strategyIds)[number];
export const defaultSelectionLimit = (strategyId: string) => (strategyId === socialDiscoveryStrategy ? 10 : 3);
export type RunReceipt = RunDetail | { id: string; shop: string; deleted: true };
export type Workbench = {
	shop: string;
	strategies: { id: StrategyId; name: string }[];
	agent: { available: boolean; error: string | null; model: HermesModel };
	runs: RunSummary[];
};
export type StartInput = { strategyId: StrategyId; limit: number; brief: string; requestId: string; model?: HermesModel };
