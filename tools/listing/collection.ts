// 人工采集沿用站点读取和 CDP 会话：只保存来源快照，店铺核价、补充与发布仍交给既有商品稿流程。
import { z } from "zod";
import { collectionLink, description, type Offer, type OfferId, offer, offerIdOf } from "../../connectors/sites/1688/api.ts";
import { using } from "../../platform/browser/browser.ts";
import { collectionSession, openCollection, stopCollection } from "../../platform/browser/collection.ts";
import { db, type Sql } from "../../platform/db/index.ts";
import { NeedsHuman, Usage } from "../../platform/errors.ts";
import { get } from "../../platform/tool.ts";
import { saveCollectedSource, saveSource } from "./source.ts";
import {
	type CollectedSourceResult,
	type CollectSourceInput,
	collectSourceParams,
	type SourceProduct,
	sourcePlatform,
	sourceProductSchema,
} from "./source-data.ts";

const alibaba = {
	site: "1688",
	origin: "https://www.1688.com/",
	hosts: ["1688.com"],
	resultHash: "listing-candidates",
	linkPattern: "/offer(?:/\\d+\\.html|\\?(?:[^#]*&)?offerId=\\d+)",
	extractLink: collectionLink,
	canonicalize: (url: string) => {
		const id = offerIdOf(url);
		return id ? `https://detail.1688.com/offer/${id}.html` : null;
	},
};

export function alibabaSource(o: Offer, detail: SourceProduct["description"], errors: string[] = []): SourceProduct {
	return sourceProductSchema.parse({
		platform: "1688",
		sourceId: o.offerId,
		url: o.url,
		title: o.title,
		images: o.images?.length ? o.images : o.image ? [o.image] : [],
		props: o.props,
		skus: o.skus.map((sku) => ({
			id: sku.skuId,
			specId: sku.specId,
			name: sku.name,
			attrs: sku.attrs,
			price: sku.price,
			stock: sku.stock,
			image: sku.image || null,
			weightKg: sku.weightKg ?? null,
		})),
		description: detail,
		minQty: o.minQty,
		freightRmb: o.freight?.costRmb ?? null,
		freeShipping: o.tags?.freeShipping ?? null,
		...(o.tags ? { tags: o.tags } : {}),
		errors,
	});
}

export async function readSource(url: string): Promise<SourceProduct> {
	const id = offerIdOf(url);
	if (!id) throw new Usage("不是有效的 1688 商品链接");
	const o = await offer(id);
	const errors: string[] = [];
	const detail = o.detailUrl
		? await description(o.detailUrl).catch((e: unknown) => {
				if (e instanceof NeedsHuman) throw e;
				errors.push(`详情读取未完成：${e instanceof Error ? e.message : String(e)}`);
				return { text: "", images: [], blocks: [] };
			})
		: { text: "", images: [], blocks: [] };
	return alibabaSource(o, detail, errors);
}

type ExistingSource = { snapshot: SourceProduct; deleted: boolean };
export function collectedSourceDecision(existing: ExistingSource | null): "read" | "reuse" {
	if (existing?.deleted) throw new Usage("商品已由用户从备选区移除，未自动恢复");
	return existing && !existing.snapshot.errors.length ? "reuse" : "read";
}

type CollectSourceDependencies = {
	existing: (id: OfferId) => Promise<ExistingSource | null>;
	read: (url: string) => Promise<SourceProduct>;
	save: (input: CollectSourceInput, product: SourceProduct) => Promise<CollectedSourceResult>;
};

/** 只采集一个真实来源；已成功的快照复用原时间，手动删除不因策略重跑而恢复。 */
export async function collectSource(input: CollectSourceInput, dependencies: CollectSourceDependencies): Promise<CollectedSourceResult> {
	const id = offerIdOf(input.link);
	if (!id) throw new Usage("不是有效的 1688 商品链接");
	const existing = await dependencies.existing(id);
	const source = collectedSourceDecision(existing) === "reuse" ? existing!.snapshot : await dependencies.read(`https://detail.1688.com/offer/${id}.html`);
	if (source.sourceId !== id) throw new Usage("读取的1688商品编号与本次来源不一致，未保存");
	return dependencies.save(input, sourceProductSchema.parse(source));
}

/** 只有本次明确点击开始时恢复同一来源；外部读取完成后的保存不得覆盖期间发生的删除。 */
export async function claimCollectedSource(sql: Sql, sourceId: OfferId): Promise<{ id: string; title: string; complete: boolean; restored: boolean } | null> {
	return sql.begin(async (tx) => {
		const [existing] = await tx<
			{ id: string; title: string; error_count: number; deleted: boolean }[]
		>`select id::text, snapshot->>'title' as title, jsonb_array_length(snapshot->'errors') as error_count,
			deleted_at is not null as deleted from listing_sources where platform = '1688' and source_id = ${sourceId} for update`;
		if (!existing) return null;
		if (existing.deleted) await tx`update listing_sources set deleted_at = null where id = ${existing.id}`;
		return { id: existing.id, title: existing.title, complete: existing.error_count === 0, restored: existing.deleted };
	});
}

const sessionInput = z.object({ sessionId: z.string().uuid() });
export const collectionTools = {
	"collect-source": get("逐件读取真实1688来源并保存到现有备选区；保留策略研究依据，不建稿、不采购或上架", collectSourceParams, async (input) => {
		const sql = await db();
		return collectSource(input, {
			existing: async (id) => {
				const [row] = await sql<
					{ snapshot: SourceProduct; deleted: boolean }[]
				>`select snapshot, deleted_at is not null as deleted from listing_sources where platform = '1688' and source_id = ${id}`;
				return row ? { snapshot: sourceProductSchema.parse(row.snapshot), deleted: row.deleted } : null;
			},
			read: readSource,
			save: (request, source) => saveCollectedSource(sql, request, source),
		});
	}),
	"collection-open": get(
		"从当前 X2 页面经 CDP 打开人工采集标签；只保存原文原图，不提交采购或上架",
		z.object({ platform: sourcePlatform, pageUrl: z.url(), marker: z.string().uuid() }),
		async ({ pageUrl, marker }) => {
			const sql = await db();
			return openCollection({ ...alibaba, pageUrl, marker }, async (url, { browserId }) => {
				const offerId = offerIdOf(url);
				if (!offerId) throw new Usage("不是有效的 1688 商品链接");
				const existing = await claimCollectedSource(sql, offerId);
				if (existing?.complete) return { status: existing.restored ? "added" : "exists", title: existing.title };
				const source = await using(browserId, () => readSource(url));
				const saved = await saveSource(sql, source);
				return { status: saved.isNew || existing?.restored ? "added" : "exists", title: source.title };
			});
		},
	),
	"collection-state": get("读取人工采集进度；失败和部分完成不冒充全页成功", sessionInput, async ({ sessionId }) => collectionSession(sessionId)),
	"collection-stop": get("停止本次人工采集，保留已保存的备选商品", sessionInput, async ({ sessionId }) => stopCollection(sessionId)),
};
