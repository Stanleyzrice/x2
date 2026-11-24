// 人工采集与备选区的网页响应；原始内容、缺失字段和上架状态均由工具返回，浏览器会话复用网页服务的类型。
import type { CollectionSession as BrowserCollectionSession } from "../../../web/browser-connection.ts";

export type SourcePlatform = "1688";
export type SourceStatus = "collected" | "needs-input" | "ready" | "listed" | "unknown";
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
export type SourceDeletion = { deleted: string[]; alreadyDeleted: string[] };
export type SourcePrompt = { shop: string; count: number; prompt: string; filename: string };
export type SourceFields = {
	title?: string;
	description?: string;
	weightKg?: number;
	freightRmb?: number;
	minQty?: number;
	categoryPath?: number[];
	daysToShip?: number;
	attributes?: { attribute_id: number; attribute_values: { value_id: number }[] }[];
	stocks?: Record<string, number>;
	prices?: Record<string, number>;
	salePricesTwd?: Record<string, number>;
	weightsKg?: Record<string, number>;
	tierLabels?: { source: string; name: string; options: Record<string, string> }[];
	hiddenSkuImages?: string[];
	mainImages?: string[];
	detailImages?: string[];
};
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
