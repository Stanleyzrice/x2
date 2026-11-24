import { z } from "zod";

export const sourcePlatform = z.enum(["1688"]);
export const sourceStatus = z.enum(["collected", "needs-input", "ready", "listed", "unknown"]);
const httpUrl = z.url({ protocol: /^https?$/ });
export const sourceFieldsSchema = z.object({
	title: z.string().trim().min(1).optional(),
	description: z.string().trim().min(1).optional(),
	weightKg: z.number().positive().finite().optional(),
	freightRmb: z.number().nonnegative().finite().optional(),
	minQty: z.number().int().positive().optional(),
	categoryPath: z.array(z.number().int().positive()).min(1).optional(),
	daysToShip: z.number().int().positive().optional(),
	attributes: z.array(z.object({ attribute_id: z.number().int(), attribute_values: z.array(z.object({ value_id: z.number().int() })) })).optional(),
	stocks: z.record(z.string(), z.number().int().nonnegative()).optional(),
	prices: z.record(z.string(), z.number().positive().finite()).optional(),
	salePricesTwd: z.record(z.string(), z.number().int().positive()).optional(),
	weightsKg: z.record(z.string(), z.number().positive().finite()).optional(),
	tierLabels: z
		.array(z.object({ source: z.string(), name: z.string().trim().min(1).max(14), options: z.record(z.string(), z.string().trim().min(1).max(20)) }))
		.optional(),
	hiddenSkuImages: z.array(httpUrl).optional(),
	mainImages: z.array(httpUrl).min(1).max(9).optional(),
	detailImages: z.array(httpUrl).max(12).optional(),
});
export type SourceFields = z.output<typeof sourceFieldsSchema>;

export type SourcePlatform = z.output<typeof sourcePlatform>;
export type SourceStatus = z.output<typeof sourceStatus>;
export type SourceItem = {
	id: string;
	platform: SourcePlatform;
	sourceId: string;
	url: string;
	title: string;
	image: string | null;
	skuCount: number;
	capturedAt: string;
	errors: string[];
	status: SourceStatus;
	problems: string[];
	listingId: string | null;
	productId: string | null;
	deletable: boolean;
	deleteProblem: string | null;
	editedAt?: string | null;
};
