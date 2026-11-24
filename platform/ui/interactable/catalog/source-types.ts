import type { CollectionSession as BrowserCollectionSession } from "../../../web/browser-connection.ts";
import type { SourceFields, SourceItem, SourcePlatform } from "../../../web/listing-source.ts";

export type { SourceFields, SourceItem, SourcePlatform, SourceStatus } from "../../../web/listing-source.ts";

export type SourceDeletion = { deleted: string[]; alreadyDeleted: string[] };
export type SourcePrompt = { shop: string; count: number; prompt: string; filename: string };
export type SourceDetail = SourceItem & {
	research?: {
		kind: "strategy-run";
		runId: string;
		strategyId: string;
		strategyName: string;
		shop: string;
		reason: string;
		evidence: string;
		recordedAt: string;
	}[];
	minQty?: number | null;
	images: string[];
	description: { text: string; images: string[]; blocks: ({ type: "text"; text: string } | { type: "image"; src: string })[] };
	props: { name: string; values: { name: string; image: string }[] }[];
	skus: { id: string; name: string; attrs: string[]; price: number | null; stock: number | null; image: string | null; weightKg: number | null }[];
	fields: SourceFields;
	tiers: { source: string; name: string; options: { source: string; name: string }[] }[];
	salePrices: Record<string, number | null>;
	skuNames: Record<string, string>;
	listingDescription: string;
	selectedMain: string[];
	selectedDetail: string[];
};
export type SourceList = {
	shop: string;
	shops: { shop: string; shopId: string }[];
	items: SourceItem[];
	total: number;
	counts: { collected: number; ready: number; needsInput: number; listed: number; unknown: number };
};
export type SourcePreparation = { items: SourceItem[]; problems: { id: string; problems: string[] }[] };
export type SourceReceipt = { requestId: string; state: "prepared" | "running" | "completed" | "unknown"; items: SourceItem[] };
export type PublishReceipt = { requestId: string; token?: string; state: SourceReceipt["state"]; error?: string };

export type CollectionSession = Omit<BrowserCollectionSession, "site"> & { site: SourcePlatform };
