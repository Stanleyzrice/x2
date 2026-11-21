// 策略选品服务端持久化和网页响应共用的校验与类型。
import { z } from "zod";

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
	selected?: number;
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
export const noteReferenceSchema = z.strictObject({
	noteId: z.string().regex(/^[a-f0-9]{24}$/i),
	part: z.number().int().min(0).max(20),
	relation: z.enum(["direct", "scene-extension"]),
	quote: z.string().trim().min(4).max(280),
	marketQuote: z.string().trim().min(4).max(160),
	matchTerms: z.array(z.string().trim().min(2).max(30)).min(1).max(3),
});
const purchaseExampleSchema = z.strictObject({
	itemId: z.string().regex(/^\d+$/),
	url: z.string().regex(/^https:\/\/shopee\.tw\/product\/\d+\/\d+$/),
	title: z.string().min(1).max(300),
	dataDate: z.iso.date(),
	sales30Day: z.number().int().positive(),
});
export const socialEvidenceSchema = z
	.strictObject({
		note: z.strictObject({
			url: z.string().regex(/^https:\/\/www\.xiaohongshu\.com\/explore\/[a-f0-9]{24}$/i),
			publishedAt: z.iso.date(),
			title: z.string().max(400),
			reference: noteReferenceSchema,
		}),
		purchases: z.array(purchaseExampleSchema).min(1).max(3),
		comparedItemId: z.string().regex(/^\d+$/).optional(),
	})
	.refine((evidence) => !evidence.comparedItemId || evidence.purchases.some((purchase) => purchase.itemId === evidence.comparedItemId), {
		path: ["comparedItemId"],
		message: "比较商品必须来自本候选的实际购买证据",
	});
export type SocialEvidence = z.output<typeof socialEvidenceSchema>;
export const researchQuerySchema = z.object({
	keyword: z.string().trim().min(1).max(80),
	sourceKeyword: z.string().trim().min(1).max(80),
	categoryPath: z.array(z.number().int().positive()).max(3),
	role: z.enum(["product", "main", "accessory"]).default("product"),
	note: noteReferenceSchema.optional(),
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
			social: socialEvidenceSchema.optional(),
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
export type QueryFact = Extract<RunEventData, { kind: "query" }>["fact"];
export type RunSnapshot = { workflow?: string[]; agent?: { model: string; reasoningEffort: string } };
export type RunDetail = RunSummary &
	RunSnapshot & {
		events: RunEvent[];
		candidates: RunCandidate[];
		cancelRequested: boolean;
		deleted?: true;
	};
export const eventSchema = z.object({ id: z.string(), step: z.string(), message: z.string(), at: z.string(), data: runEventDataSchema.optional() });
export const candidateSchema = z
	.object({
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
		qualification: z.enum(["rejected", "pending", "priced"]).optional(),
		pricing: z.unknown().optional(),
		research: researchConclusionSchema.optional(),
		receipt: receiptSchema.optional(),
		social: socialEvidenceSchema.optional(),
	})
	.refine((candidate) => !candidate.qualification || (candidate.qualification === "rejected") === (candidate.status === "rejected"), {
		path: ["qualification"],
		message: "资格结果与保存状态不一致",
	});
