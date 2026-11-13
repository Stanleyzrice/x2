// 已审本地图片的正式导入：锁源规格、验来源及文件SHA，经既有水印/上传管线保存；不修改Gemini检查缓存或商品规格。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { type Bytes, inspect } from "../../connectors/services/image/api.ts";
import type { Json, Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { parseJson } from "../../platform/tool.ts";
import { finish, original } from "./images.ts";
import type { Pic, Pics } from "./pics.ts";
import { settingsOf } from "./pricing.ts";
import { detailFits, MAX_DETAIL, MAX_MAIN } from "./product.ts";
import { inShopQueued } from "./queue.ts";
import { ListingId, type ListingRow, type ShopSettingsRow } from "./row.ts";
import { sizeChartScope } from "./size-chart.ts";
import { specsOf } from "./variants.ts";

const hash = z.string().regex(/^[a-f\d]{64}$/);
const evidence = z.string().trim().min(1);
const image = z.object({
	sourceUrl: z.url({ protocol: /^https?$/ }),
	sourceSha256: hash,
	path: z.string().trim().refine(isAbsolute, "图片须为本地绝对路径"),
	sha256: hash,
	provider: z.enum(["openai-image", "clean-original"]),
	evidence,
});
export const reviewedImagesManifest = z.object({
	expectedScope: hash,
	main: z.array(image).min(1).max(MAX_MAIN),
	detail: z.array(image).max(MAX_DETAIL),
	options: z.array(image.extend({ skuIds: z.array(z.string().min(1)).min(1) })),
});
export const reviewedImagesPreviewParams = z.object({ id: ListingId });
export const reviewedImagesParams = z.object({
	id: ListingId,
	manifest: z.preprocess(parseJson, reviewedImagesManifest).describe("已审图片清单JSON，含expectedScope、main/detail/options；写 - 从stdin读"),
});
type Manifest = z.output<typeof reviewedImagesManifest>;
type ImageInput = z.output<typeof image> & { skuIds?: string[] };
type SourceRow = Pick<ListingRow, "shop" | "offer_id" | "offer" | "variants" | "images">;
const roles = ["main", "detail", "options"] as const;

/** 第一层选项以来源URL分组；同URL的全部已选SKU必须一起绑定，禁止把别的花色图套到一个SKU。 */
export function reviewedOptions(row: SourceRow): { sourceUrl: string; skuIds: string[] }[] {
	const specs = specsOf(row.variants);
	if (!row.offer || !specs?.variants.length) throw new Usage("商品稿没有已保存货源和规格，先做商品稿");
	const groups = new Map<string, string[]>();
	for (const v of specs.variants) {
		const source = row.offer.skus.find((s) => s.skuId === v.skuId);
		if (!source || source.specId !== v.specId) throw new Usage(`源SKU ${v.skuId} 或specId不匹配，不能导入图片`);
		const url = specs.tiers[0]?.options[v.options[0]!]?.image;
		if (url) groups.set(url, [...(groups.get(url) ?? []), v.skuId]);
	}
	return [...groups].map(([sourceUrl, skuIds]) => ({ sourceUrl, skuIds: skuIds.sort() })).sort((a, b) => a.sourceUrl.localeCompare(b.sourceUrl));
}

export function reviewedImagesScope(row: SourceRow): string {
	return createHash("sha256")
		.update(JSON.stringify([sizeChartScope(row), reviewedOptions(row)]))
		.digest("hex");
}

function sourceLists(row: SourceRow) {
	if (!row.offer) throw new Usage("缺已保存的货源");
	const detail = z.array(z.string()).parse("detail" in row.offer ? (row.offer.detail ?? []) : []);
	return { main: row.offer.images ?? [row.offer.image], detail };
}

export function reviewedImagesPreview(row: SourceRow) {
	const sources = sourceLists(row);
	const shas = new Map(roles.flatMap((role) => (row.images[role] ?? []).filter((p) => p.sha).map((p) => [p.from, p.sha!])));
	return {
		expectedScope: reviewedImagesScope(row),
		requiredOptions: reviewedOptions(row).map((o) => ({ ...o, sourceSha256: shas.get(o.sourceUrl) ?? null })),
		sourceMain: sources.main,
		sourceDetail: sources.detail,
		sourceMainCount: sources.main.length,
		sourceDetailCount: sources.detail.length,
		savedSourceShas: Object.fromEntries(shas),
	};
}

export function validateReviewedManifest(row: SourceRow, manifest: Manifest): void {
	if (manifest.expectedScope !== reviewedImagesScope(row)) throw new Usage("源规格或规格图映射已变，请重新预览审阅清单");
	const source = sourceLists(row);
	const known = new Set([
		...source.main,
		...source.detail,
		...(row.offer?.skus.map((s) => s.image).filter(Boolean) ?? []),
		...reviewedOptions(row).map((o) => o.sourceUrl),
	]);
	const sourceShas = new Map<string, string>();
	for (const role of roles) {
		const identities = manifest[role].map((p) => (role === "options" ? p.sourceUrl : `${p.sourceUrl}:${p.sha256}`));
		if (new Set(identities).size !== manifest[role].length) throw new Usage(`${role}含重复图片`);
		for (const p of manifest[role]) {
			if (!known.has(p.sourceUrl)) throw new Usage("图片来源URL不在本稿保存的货源图片中");
			if (sourceShas.has(p.sourceUrl) && sourceShas.get(p.sourceUrl) !== p.sourceSha256) throw new Usage("同一来源URL的原图SHA不一致");
			sourceShas.set(p.sourceUrl, p.sourceSha256);
			if (p.provider === "clean-original" && p.sha256 !== p.sourceSha256) throw new Usage("clean-original的文件须与原图SHA相同，处理过的图须如实标注provider");
		}
	}
	const required = reviewedOptions(row);
	if (required.length !== manifest.options.length) throw new Usage("审阅清单未完整覆盖当前规格图");
	for (const group of required) {
		const p = manifest.options.find((x) => x.sourceUrl === group.sourceUrl);
		if (!p || new Set(p.skuIds).size !== p.skuIds.length || JSON.stringify([...p.skuIds].sort()) !== JSON.stringify(group.skuIds))
			throw new Usage("规格图skuIds与本稿已选SKU映射不一致，不更换规格或图片");
	}
}

export function validateReviewedBytes(input: ImageInput, processed: Bytes, sourceSha: string, role: (typeof roles)[number]): void {
	if (sourceSha !== input.sourceSha256) throw new Usage("来源原图SHA与审阅清单不一致，请重新核图");
	if (processed.sha256 !== input.sha256) throw new Usage("本地处理文件SHA已变化，请重新审阅");
	if (processed.width <= 10 || processed.height <= 10 || processed.width * processed.height > 40_000_000) throw new Usage("已审图片尺寸无效或超过4000万像素");
	if (role === "detail" && !detailFits(processed.width, processed.height)) throw new Usage("已审详情图须宽≥700、高≥32、宽高比0.5–32；请先处理合规尺寸");
}

/** 续做和发布前验证已保存清单仍属于当前源规格，不把旧审阅套到新款上。 */
export function validateSavedReviewedImages(row: SourceRow): void {
	if (row.images.imageMode !== "reviewed") throw new Usage("尚未导入已审图片，先 listing reviewed-images");
	const manifest: Manifest = {
		expectedScope: reviewedImagesScope(row),
		main: [],
		detail: [],
		options: [],
	};
	for (const role of roles)
		for (const p of row.images[role] ?? []) {
			const r = p.review;
			if (!r || r.scope !== manifest.expectedScope || r.sourceSha256 !== p.sha || !p.imageId || !p.final || p.drop)
				throw new Usage("已审图片来源、上传结果或审阅范围失效，请重新导入");
			const input = { sourceUrl: p.from, sourceSha256: r.sourceSha256, path: r.path, sha256: r.processedSha256, provider: r.provider, evidence: r.evidence };
			if (role === "options") manifest.options.push({ ...input, skuIds: r.skuIds ?? [] });
			else manifest[role].push(input);
			if (!p.width || !p.height || p.width <= 10 || p.height <= 10 || (role === "detail" && !detailFits(p.width, p.height)))
				throw new Usage("已审图片保存尺寸不完整或不合要求");
		}
	validateReviewedManifest(row, reviewedImagesManifest.parse(manifest));
}

function editable(row: Pick<ListingRow, "product_id" | "listed_at">) {
	if (row.product_id || row.listed_at) throw new Usage("仅未建商品稿可导入已审图片");
}
const state = (row: SourceRow) => JSON.stringify([reviewedImagesScope(row), row.images]);

export async function importReviewedImages(sql: Sql, p: z.output<typeof reviewedImagesParams>) {
	const [row] = await sql<ListingRow[]>`select * from listings where id = ${p.id}`;
	if (!row) throw new Usage(`没有商品稿 ${p.id}`);
	editable(row);
	validateReviewedManifest(row, p.manifest);
	const before = state(row);
	const [shop] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${row.shop}`;
	if (!shop) throw new Usage(`没有店铺设置 ${row.shop}`);
	const settings = settingsOf(shop);
	if (!settings.mark) throw new Usage("店铺缺水印设置");
	const files = new Map<string, Bytes>();
	// 整份清单先验证，再上传；文件变动、错SHA、错款不会留下部分商品稿。
	for (const role of roles)
		for (const input of p.manifest[role]) {
			const processed = inspect(new Uint8Array(await readFile(input.path)), input.path);
			const source = await original(sql, input.sourceUrl);
			validateReviewedBytes(input, processed, source.sha256, role);
			files.set(input.path, processed);
		}
	const pics: Pics = { imageMode: "reviewed", main: [], detail: [], options: [] };
	const cache = new Map<string, { reused: boolean; chunks: number }>();
	for (const role of roles)
		for (const input of p.manifest[role]) {
			const processed = files.get(input.path)!;
			const provenance = {
				provider: input.provider,
				evidence: input.evidence,
				sourceSha256: input.sourceSha256,
				processedSha256: processed.sha256,
				path: input.path,
				scope: p.manifest.expectedScope,
				...("skuIds" in input ? { skuIds: input.skuIds } : {}),
				at: new Date().toISOString(),
			};
			if (!cache.has(processed.sha256)) cache.set(processed.sha256, await persistReviewedImage(sql, input, processed));
			const pic: Pic = { from: input.sourceUrl, sha: input.sourceSha256, review: provenance };
			await finish(sql, row.shop, settings.mark, pic, processed, (fn) => inShopQueued(settings.shopId, fn));
			pics[role].push(pic);
		}
	return sql.begin(async (tx) => {
		const [fresh] = await tx<ListingRow[]>`select * from listings where id = ${p.id} for update`;
		if (!fresh) throw new Usage(`没有商品稿 ${p.id}`);
		editable(fresh);
		if (state(fresh) !== before) throw new Usage("上传期间源规格或图片已变化，未覆盖，请重新审阅");
		validateSavedReviewedImages({ ...fresh, images: pics });
		await tx`update listings set images = ${tx.json(pics as Json)}, updated_at = now() where id = ${p.id}`;
		return {
			id: p.id,
			shop: row.shop,
			expectedScope: p.manifest.expectedScope,
			counts: Object.fromEntries(roles.map((role) => [role, pics[role].length])),
			cache: [...cache].map(([sha256, result]) => ({ sha256, ...result })),
			images: pics,
		};
	});
}

type ReviewedFileDigest = { sha256: string; digest: string | null; bytes_length: number | null; width: number | null; height: number | null };

/** 参数块原始字节最多64KiB；所有追加及最终摘要核验都由调用方包在同一事务、同一行锁内。 */
export const REVIEWED_CACHE_CHUNK_BYTES = 64 * 1024;
type CacheStore = {
	read: () => Promise<ReviewedFileDigest | undefined>;
	initialize: () => Promise<void>;
	append: (chunk: Uint8Array) => Promise<void>;
};
function cachedImageMatches(image: Bytes, saved: ReviewedFileDigest): void {
	if (saved.width !== image.width || saved.height !== image.height) throw new Usage("已审图片缓存尺寸与处理文件不一致，未覆盖缓存");
	if (saved.digest !== image.sha256 || saved.bytes_length !== image.bytes.length) throw new Usage("已审图片缓存完整摘要或长度不符，未覆盖错误缓存");
}

/** 有效缓存只读取摘要；缺缓存才分块写入。失败直接抛出，由事务回滚，禁止提交不完整内容。 */
export async function writeReviewedImageCache(image: Bytes, store: CacheStore): Promise<{ reused: boolean; chunks: number }> {
	const before = await store.read();
	if (before && before.bytes_length !== null) {
		cachedImageMatches(image, before);
		return { reused: true, chunks: 0 };
	}
	if (before && (before.width !== image.width || before.height !== image.height)) throw new Usage("已审图片空缓存尺寸不符，未覆盖缓存");
	await store.initialize();
	let chunks = 0;
	for (let offset = 0; offset < image.bytes.length; offset += REVIEWED_CACHE_CHUNK_BYTES) {
		await store.append(image.bytes.subarray(offset, offset + REVIEWED_CACHE_CHUNK_BYTES));
		chunks++;
	}
	const saved = await store.read();
	if (!saved?.bytes_length) throw new Usage("已审图片缓存写入未完成，事务回滚");
	cachedImageMatches(image, saved);
	return { reused: false, chunks };
}

async function persistReviewedImage(sql: Sql, input: ImageInput, image: Bytes) {
	const [cached] = await sql<ReviewedFileDigest[]>`select sha256, encode(sha256(bytes), 'hex') as digest,
		octet_length(bytes)::integer as bytes_length, width, height from images where sha256 = ${image.sha256}`;
	if (cached && cached.bytes_length !== null) {
		cachedImageMatches(image, cached);
		return { reused: true, chunks: 0 };
	}
	return sql.begin(async (tx) => {
		// 只先写小型元数据，不把整张PNG放进ON CONFLICT参数；并发导入同SHA时由行锁串行。
		await tx`insert into images ${tx({ sha256: image.sha256, kind: "已审图片", source: input.path, from_sha: input.sourceSha256, mime: image.mime, width: image.width, height: image.height })}
			on conflict (sha256) do nothing`;
		return writeReviewedImageCache(image, {
			read: async () => {
				const [saved] = await tx<ReviewedFileDigest[]>`select sha256, encode(sha256(bytes), 'hex') as digest,
					octet_length(bytes)::integer as bytes_length, width, height from images where sha256 = ${image.sha256} for update`;
				return saved;
			},
			initialize: async () => {
				await tx`update images set bytes = decode('', 'hex') where sha256 = ${image.sha256} and bytes is null`;
			},
			append: async (chunk) => {
				await tx`update images set bytes = bytes || ${Buffer.from(chunk)} where sha256 = ${image.sha256}`;
			},
		});
	});
}

/** 完整内容摘要在数据库端计算；匹配审核过的SHA后，保存的尺寸仍须与最终图片一致。 */
export function validateReviewedFileDigests(pics: Partial<Pics>, rows: ReviewedFileDigest[]): void {
	const bySha = new Map(rows.map((r) => [r.sha256, r]));
	for (const role of roles)
		for (const pic of pics[role] ?? []) {
			const sha = pic.review?.processedSha256;
			const saved = sha ? bySha.get(sha) : undefined;
			if (!saved?.bytes_length) throw new Usage("已审图片处理文件没有保存bytes，请重新导入");
			if (saved.digest !== sha) throw new Usage("已审图片完整内容SHA256与审阅清单不一致，请重新核图并导入");
			if (saved.width !== pic.width || saved.height !== pic.height) throw new Usage("已审图片保存尺寸与处理文件元数据不一致，请重新核对");
		}
}

export async function verifyReviewedFiles(sql: Sql, row: SourceRow): Promise<void> {
	validateSavedReviewedImages(row);
	const shas = [...new Set(roles.flatMap((role) => (row.images[role] ?? []).map((pic) => pic.review!.processedSha256)))];
	// bytes全量参与SHA256，只回传摘要和尺寸，避免为每个主图/规格重复跨SSH传输大块bytea。
	const rows = await sql<ReviewedFileDigest[]>`select sha256, encode(sha256(bytes), 'hex') as digest,
		octet_length(bytes)::integer as bytes_length, width, height from images where sha256 in ${sql(shas)}`;
	validateReviewedFileDigests(row.images, rows);
}
