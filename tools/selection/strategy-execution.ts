import { z } from "zod";
import type { StrategyId } from "../../platform/ui/interactable/selection/types.ts";

export const trendPolicySchema = z
	.strictObject({
		windowDays: z.number().int().min(2).max(3660),
		minPoints: z.number().int().positive(),
		maxLagDays: z.number().int().nonnegative(),
		minGrowthRate: z.number().nonnegative(),
		minPreviousGrowthRate: z.number().nonnegative(),
		minRobustGrowthRate: z.number().nonnegative(),
		minBaselineMean: z.number().positive(),
		maxQueriesPerRound: z.number().int().positive().max(12).optional(),
	})
	.refine((value) => value.minPoints <= value.windowDays, "最少点数不得大于窗口天数");

type StrategyExecution =
	| { kind: "sales-unit"; market: "comparison" }
	| { kind: "discovery"; market: "comparison" | "accessory" | "complaints" }
	| { kind: "discovery"; market: "trend"; trend: z.input<typeof trendPolicySchema> }
	| { kind: "discovery"; market: "social"; noteDays: number; maxQueriesPerRound: number };

export const strategyExecution = {
	"peer-benchmark": { kind: "discovery", market: "comparison" },
	"bestseller-accessories": { kind: "discovery", market: "accessory" },
	"unmet-needs": { kind: "discovery", market: "complaints" },
	"rising-demand": {
		kind: "discovery",
		market: "trend",
		trend: {
			windowDays: 7,
			minPoints: 7,
			maxLagDays: 3,
			minGrowthRate: 0.03,
			minPreviousGrowthRate: 0.01,
			minRobustGrowthRate: 0.02,
			minBaselineMean: 10,
			maxQueriesPerRound: 12,
		},
	},
	"bundle-sales": { kind: "sales-unit", market: "comparison" },
	"xiaohongshu-discovery": { kind: "discovery", market: "social", noteDays: 30, maxQueriesPerRound: 12 },
} as const satisfies Record<StrategyId, StrategyExecution>;
