// 页面与选品业务工具的响应合同；候选证据与金额由服务端提供。
export const strategyIds = ["peer-benchmark", "bestseller-accessories", "unmet-needs", "rising-demand", "bundle-sales"] as const;
export type StrategyId = (typeof strategyIds)[number];
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
export type RunStatus = "queued" | "running" | "needs-human" | "completed" | "failed" | "cancelled" | "interrupted";
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
export type ResearchConclusion = {
	purchaseTask: string;
	demandLevel: "unknown" | "search" | "purchase";
	queryFactIndexes: number[];
	comparableGroup: string;
	deliverableDifference: string;
	differenceStatus: "supported" | "hypothesis" | "unknown";
	failureConditions: string[];
	missing: string[];
};
export type QueryFact = {
	query: { keyword: string; sourceKeyword: string; categoryPath: number[]; role: "product" | "main" | "accessory" };
	observedAt: string;
	updateTime?: unknown;
	words?: unknown;
	items?: unknown;
	competition?: unknown;
	needs?: unknown;
	errors?: unknown;
	searchSignal: boolean | null;
	purchaseSignal: boolean | null;
	demandScope: "keyword-category-or-whole-listing";
	trend?: {
		wordId: number;
		word: string;
		metric: string;
		basis: string;
		qualified: boolean;
		reasons: string[];
		summary: unknown;
	};
};
export type BatchAudit = {
	steps: {
		stepIndex: number;
		status: "supported" | "partial" | "not-applicable";
		conclusion: string;
		queryFactIndexes: number[];
		offerIds: string[];
		missing: string[];
	}[];
	stopReason: string | null;
};
export type RunEventData =
	| { kind: "tool"; tool: string; input: unknown; result?: unknown; error?: string }
	| { kind: "plan"; round: number; plan: unknown }
	| { kind: "query"; round: number; queryFactIndex: number; fact: QueryFact }
	| {
			kind: "analysis";
			round: number;
			batch: number;
			audit?: BatchAudit;
			summary: string;
			research: (ResearchConclusion & { offerId: string; skuId: string })[];
	  }
	| { kind: "stop"; reason: string; added: number; existing: number };
export type RunEvent = { id: string; step: string; message: string; at: string; data?: RunEventData };
export type Candidate = {
	offerId: string;
	url: string;
	title: string;
	sourceId: string | null;
	status: "added" | "existing" | "rejected";
	reason: string;
	evidence: string;
	problems: string[];
	hardProblems?: string[];
	warnings?: string[];
	pricing?: unknown;
	research?: ResearchConclusion;
	receipt?: { sourceId: string; offerId: string; status: "added" | "existing"; sourceCapturedAt?: string; reusedSnapshot?: boolean };
};
export type RunDetail = RunSummary & {
	cancelRequested?: boolean;
	events: RunEvent[];
	candidates: Candidate[];
	workflow?: string[];
	agent?: { model: string; reasoningEffort: string };
};
export type Workbench = {
	shop: string;
	strategies: Strategy[];
	methodology?: Methodology;
	agent: { available: boolean; version: string | null; error: string | null; model?: string; reasoningEffort?: string };
	runs: RunSummary[];
};
export type StartInput = { strategyId: StrategyId; limit: number; brief: string; requestId: string };
