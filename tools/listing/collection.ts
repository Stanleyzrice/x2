// 人工采集沿用站点读取和 CDP 会话：只保存来源快照，店铺核价、补充与发布仍交给既有商品稿流程。
import { z } from "zod";
import { collectionLink, description, type Offer, type OfferId, offer, offerIdOf } from "../../connectors/sites/1688/api.ts";
import { using } from "../../platform/browser/browser.ts";
import { collectionSession, openCollection, stopCollection } from "../../platform/browser/collection.ts";
import { db, type Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { get } from "../../platform/tool.ts";
import { saveSource } from "./source.ts";
import { type SourceProduct, sourcePlatform, sourceProductSchema } from "./source-data.ts";

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

async function readSource(url: string): Promise<SourceProduct> {
	const id = offerIdOf(url);
	if (!id) throw new Usage("不是有效的 1688 商品链接");
	const o = await offer(id);
	const errors: string[] = [];
	const detail = o.detailUrl
		? await description(o.detailUrl).catch((e: unknown) => {
				errors.push(`详情读取未完成：${e instanceof Error ? e.message : String(e)}`);
				return { text: "", images: [], blocks: [] };
			})
		: { text: "", images: [], blocks: [] };
	return alibabaSource(o, detail, errors);
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
