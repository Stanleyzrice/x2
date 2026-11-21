import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "../../platform/db/index.ts";
import type { Planned } from "../../platform/tool.ts";

export const followUpBatchId = z.uuid().describe("可选的跟踪批次编号，同一批分次发布时复用同一个 UUID");
export const followUpEventsParams = z.object({ after: z.iso.datetime({ offset: true }).describe("只读取该时间起已确认上架的新品") });

export function markFollowUpBatch(batches: Planned[][], trackingBatch: string = randomUUID()): Planned[][] {
	return batches.map((batch) =>
		batch.map((step) => {
			const params = step.params;
			if (step.op !== "上架" || !params || typeof params !== "object" || !("shop" in params) || params.shop !== "cheeroutdoor") return step;
			return { ...step, params: { ...params, trackingBatch } };
		}),
	);
}

export async function followUpEvents(sql: Sql, after: string) {
	// 已启动的旧版网页仍有提交回执，可按其中的写入编号恢复原有批次。
	const rows = await sql<{ id: string; name: string; draftId: string; batch: string; listedAt: Date }[]>`
		select distinct on (l.product_id)
			l.product_id as id, coalesce(nullif(l.nickname, ''), nullif(l.title, ''), l.product_id) as name,
			l.id::text as "draftId", coalesce(w.params->>'trackingBatch', web.request_id, 'x2-' || w.batch::text) as batch,
			coalesce(l.listed_at, w.finished_at) as "listedAt"
		from writes w join listings l on l.id::text = w.params->>'listingId'
		left join lateral (
			select c.params->>'requestId' as request_id from web_confirmations c
			where not (w.params ? 'trackingBatch') and c.tool = 'listing.source-publish'
				and c.outcome->'ran' @> jsonb_build_array(jsonb_build_object('id', w.id::text))
			limit 1
		) web on true
		where w.op = '上架' and w.status in ('已核对', '成功') and w.finished_at >= ${after}::timestamptz
			and w.params->>'shopId' = '1554182542' and l.shop = 'cheeroutdoor' and l.product_id ~ '^[0-9]+$'
			and (w.params ? 'trackingBatch' or web.request_id is not null or w.finished_at <= now() - interval '15 minutes')
		order by l.product_id, w.finished_at, w.id`;
	return { shop: "cheeroutdoor", shopId: "1554182542", rows: rows.map((row) => ({ ...row, listedAt: row.listedAt.toISOString() })) };
}
