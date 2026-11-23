import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fetchImage, inspect } from "../../connectors/services/image/api.ts";
import { BATCH, translationConfig } from "../../connectors/services/xiangji/api.ts";
import { translateImages } from "../../connectors/services/xiangji/index.ts";
import type { Sql } from "../../platform/db/index.ts";

const translationRecord = z.object({
	status: z.enum(["submitted", "done", "failed", "unknown"]).optional(),
	requestId: z.string().optional(),
	at: z.string().optional(),
	url: z.url({ protocol: /^https?$/ }).optional(),
	failed: z.string().optional(),
});
type TranslationReceipt = { status: "done"; url: string } | { status: "failed" | "unknown"; failed: string };
type Settlement = { sha: string; record: TranslationReceipt };
type TranslationState = { url?: string; failed?: string; saved: boolean; retryable: boolean };
const UNKNOWN = "收费译图结果未知，请人工核对该图与象寄账单；不会重复提交";

export async function cachedTranslation(sql: Sql, sourceSha: string, sha?: string) {
	const [row] = await sql<{ sha256: string; source: string; bytes: Buffer }[]>`
		select sha256, source, bytes from images
		where kind = '译图' and from_sha = ${sourceSha} and bytes is not null
		${sha ? sql`and sha256 = ${sha}` : sql``}
		order by created_at desc, sha256 limit 1`;
	if (!row) return null;
	const image = inspect(row.bytes);
	if (image.sha256 !== row.sha256) throw new Error("象寄译图缓存指纹不一致，须核对原提交");
	return { url: row.source, image };
}

const translatedReply = z.object({
	kind: z.literal("done"),
	results: z.array(z.object({ origin: z.string(), url: z.url({ protocol: /^https?$/ }) })),
	failed: z.array(z.object({ origin: z.string(), why: z.string().min(1) })),
	missing: z.array(z.string()),
});

export async function translationState(sql: Sql, shas: string[]): Promise<Map<string, TranslationState>> {
	const rows = await sql<{ sha256: string; t: unknown; saved: boolean }[]>`
		select o.sha256, o.checks->'译图' as t,
		exists (select 1 from images t where t.kind = '译图' and t.from_sha = o.sha256) as saved
		from images o where o.sha256 in ${sql(shas)}`;
	return new Map(
		rows
			.filter((row) => row.t !== null || row.saved)
			.map((row) => {
				const record = translationRecord.safeParse(row.t).data;
				return [
					row.sha256,
					{
						url: record?.url,
						failed: record?.failed ?? (!record?.url && !row.saved ? UNKNOWN : undefined),
						saved: row.saved,
						retryable: !row.saved && !record?.url && (record?.status === "failed" || (record?.status === undefined && Boolean(record?.failed))),
					},
				];
			}),
	);
}

/** 象寄的地址大约 80 天失效：拿到就取回来存进库。 */
export async function saveTranslation(sql: Sql, origin: string, url: string): Promise<void> {
	const b = await fetchImage(url);
	await sql`insert into images ${sql({ sha256: b.sha256, kind: "译图", source: url, from_sha: origin, mime: b.mime, width: b.width, height: b.height, bytes: Buffer.from(b.bytes) })} on conflict (sha256) do nothing`;
}

export async function translate(
	sql: Sql,
	items: { sha: string; url: string }[],
	dependencies: Partial<{ submit: typeof translateImages.submit; save: typeof saveTranslation }> = {},
): Promise<void> {
	if (!items.length) return;
	if (items.length > BATCH) throw new Error(`译图每批最多 ${BATCH} 张，未提交`);
	if (new Set(items.map((item) => item.sha)).size !== items.length || new Set(items.map((item) => item.url)).size !== items.length)
		throw new Error("译图输入的原图指纹或地址重复，未提交");
	if (!dependencies.submit) translationConfig();
	const requestId = randomUUID();
	const at = new Date().toISOString();
	// 领取和意图在同一条语句提交；外部请求前已落库，进程消失后也不能把提交中当成尚未提交。
	const claimed = await sql<{ sha256: string }[]>`update images o set checks = o.checks || ${sql.json({ 译图: { status: "submitted", requestId, at } })}
		where o.sha256 in ${sql(items.map((item) => item.sha))}
		and (
			not (o.checks ? '译图') or (o.checks->'译图'->>'status' = 'failed' and not (o.checks->'译图' ? 'url'))
			or (o.checks->'译图'->>'status' is null and jsonb_typeof(o.checks->'译图'->'failed') = 'string'
				and o.checks->'译图'->>'failed' <> '' and not (o.checks->'译图' ? 'url'))
		)
		and not exists (select 1 from images t where t.kind = '译图' and t.from_sha = o.sha256)
		returning o.sha256`;
	const owned = new Set(claimed.map((row) => row.sha256));
	const batch = items.filter((item) => owned.has(item.sha));
	if (!batch.length) return;
	const settle = async (records: Settlement[]) =>
		sql.begin(async (tx) => {
			for (const { sha, record } of records)
				await tx`update images set checks = checks || ${tx.json({ 译图: { ...record, requestId, at } })}
					where sha256 = ${sha} and checks->'译图'->>'requestId' = ${requestId} and checks->'译图'->>'status' = 'submitted'`;
		});
	let records: Settlement[];
	let refused: string | null = null;
	try {
		const w = await (dependencies.submit ?? translateImages.submit)({ urls: batch.map((item) => item.url) });
		if (w.kind === "refused" || w.kind === "blocked") {
			refused = `象寄没译：${w.why}`;
			records = batch.map(({ sha }) => ({ sha, record: { status: "failed", failed: w.why } }));
		} else {
			if (w.kind !== "done") throw new Error(UNKNOWN);
			const reply = translatedReply.parse(w.data);
			const origins = [...reply.results.map((item) => item.origin), ...reply.failed.map((item) => item.origin), ...reply.missing];
			if (new Set(origins).size !== origins.length || origins.some((origin) => !batch.some((item) => item.url === origin)))
				throw new Error("象寄回包中的原图地址重复或不属于本次提交");
			records = batch.map(({ sha, url }) => {
				const result = reply.results.find((item) => item.origin === url);
				if (result) return { sha, record: { status: "done", url: result.url } };
				const failure = reply.failed.find((item) => item.origin === url);
				return { sha, record: failure ? { status: "failed", failed: failure.why } : { status: "unknown", failed: UNKNOWN } };
			});
		}
	} catch (error) {
		await settle(batch.map(({ sha }) => ({ sha, record: { status: "unknown", failed: UNKNOWN } })));
		throw error;
	}
	await settle(records);
	if (refused) throw new Error(refused);
	for (const { sha, record } of records) if (record.status === "done") await (dependencies.save ?? saveTranslation)(sql, sha, record.url).catch(() => {});
}
