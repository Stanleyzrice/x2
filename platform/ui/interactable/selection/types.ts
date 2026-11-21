// 页面与选品业务工具的响应合同；候选证据与金额由服务端提供。
import type { RunDetail, RunSummary } from "./contract.ts";

export type {
	QueryFact,
	ResearchAudit as BatchAudit,
	ResearchConclusion,
	RunCandidate as Candidate,
	RunDetail,
	RunEvent,
	RunStatus,
	RunSummary,
} from "./contract.ts";

export const socialDiscoveryStrategy = "xiaohongshu-discovery";
export const strategyIds = ["peer-benchmark", "bestseller-accessories", "unmet-needs", "rising-demand", "bundle-sales", socialDiscoveryStrategy] as const;
export type StrategyId = (typeof strategyIds)[number];
export const defaultSelectionLimit = (strategyId: string) => (strategyId === socialDiscoveryStrategy ? 10 : 3);
export type Strategy = {
	id: string;
	name: string;
	description: string;
	steps: string[];
	policyPath: string;
	isCustomized?: boolean;
	kind?: "discovery" | "sales-unit";
	purchaseReason?: string;
	evidenceNeeded?: string[];
	rejectWhen?: string[];
	researchVersion?: 1;
	trend?: {
		windowDays: number;
		minPoints: number;
		maxLagDays: number;
		minGrowthRate: number;
		minPreviousGrowthRate: number;
		minRobustGrowthRate: number;
		minBaselineMean: number;
	};
};
export type Methodology = {
	summary: string;
	commonChecks: string[];
	evidenceRules: string[];
	deferred: { name: string; reason: string }[];
};
export type RunReceipt = RunDetail | { id: string; shop: string; deleted: true };
export type Workbench = {
	shop: string;
	strategies: Strategy[];
	methodology?: Methodology;
	agent: { available: boolean; version: string | null; error: string | null; model?: string; reasoningEffort?: string };
	runs: RunSummary[];
};
export type StartInput = { strategyId: StrategyId; limit: number; brief: string; requestId: string };
