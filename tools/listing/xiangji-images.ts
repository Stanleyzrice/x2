import { z } from "zod";
import { BATCH, translationConfig } from "../../connectors/services/xiangji/api.ts";
import type { Sql } from "../../platform/db/index.ts";
import { NeedsHuman, Usage } from "../../platform/errors.ts";
import { flag, strs } from "../../platform/tool.ts";
import { imageSha256 } from "./image-language.ts";
import { original } from "./images.ts";
import { reviewedImagesPreview } from "./reviewed-images.ts";
import { ListingId, type ListingRow } from "./row.ts";
import { cachedTranslation, saveTranslation, translate, translationState } from "./translations.ts";

export const imageTranslationFlow = z.enum(["xiangji", "processed"]);
export type ImageTranslationFlow = z.infer<typeof imageTranslationFlow>;

export async function shopImageFlow(sql: Sql, shop: string, mode?: ImageTranslationFlow) {
	const [row] = mode
		? await sql`update shop_settings set image_translation_flow = ${mode} where shop = ${shop} returning image_translation_flow`
		: await sql`select image_translation_flow from shop_settings where shop = ${shop}`;
	if (!row) throw new Usage(`找不到店铺 ${shop}`);
	return { shop, mode: imageTranslationFlow.parse(row.image_translation_flow) };
}

export function listingSourceImageUrl(value: string): string {
	const url = URL.parse(value.startsWith("//") ? `https:${value}` : value);
	if (url?.protocol !== "https:" || url.username || url.password || url.port || !/(^|\.)(alicdn\.com|1688\.com|alibaba\.com)$/i.test(url.hostname))
		throw new NeedsHuman("这张来源图片需人工处理，地址不属于已支持的货源图床");
	return url.href;
}

export const xiangjiImagesParams = z.object({
	id: ListingId,
	expectedScope: imageSha256,
	urls: strs("本稿明确选中的待翻译原图 URL，每批最多五张").refine((urls) => urls.length <= BATCH, `每批最多 ${BATCH} 张`),
	submit: flag("明确提交收费翻译；省略或 false 只核对现有译图回执").default(false),
});

export async function xiangjiImages(
	sql: Sql,
	p: z.output<typeof xiangjiImagesParams>,
	deps: Partial<{ original: typeof original; translate: typeof translate; save: typeof saveTranslation; checkConfig: typeof translationConfig }> = {},
) {
	const [row] = await sql<ListingRow[]>`select * from listings where id = ${p.id}`;
	if (!row || row.cancelled || row.product_id || row.listed_at) throw new Usage("仅有效的未建商品稿可处理译图");
	const preview = reviewedImagesPreview(row);
	if (p.expectedScope !== preview.expectedScope) throw new Usage("源规格或规格图映射已变化，请重新预览");
	const containsAll = (view: typeof preview) => {
		const allowed = new Set([...view.sourceMain, ...view.sourceDetail, ...view.requiredOptions.map((entry) => entry.sourceUrl)]);
		return p.urls.every((url) => allowed.has(url));
	};
	if (!containsAll(preview)) throw new Usage("选中的图片不在本稿主图、详情图或已选规格图中");
	const items = await Promise.all(
		[...new Set(p.urls)].map(async (sourceUrl) => {
			const url = listingSourceImageUrl(sourceUrl);
			const image = await (deps.original ?? original)(sql, url, { redirect: "error" });
			return { sourceUrl, url, sha: image.sha256 };
		}),
	);
	const unique = new Map(items.map((item) => [item.sha, item]));
	const shas = [...unique.keys()];
	const before = await translationState(sql, shas);
	const fresh = [...unique.values()].filter(({ sha }) => !before.has(sha) || before.get(sha)?.retryable);
	let error: string | null = null;
	if (p.submit && fresh.length) {
		(deps.checkConfig ?? translationConfig)();
		const [current] = await sql<ListingRow[]>`select * from listings where id = ${p.id}`;
		if (!current || current.cancelled || current.product_id || current.listed_at) throw new Usage("商品稿在准备期间已变化，未提交翻译");
		const currentPreview = reviewedImagesPreview(current);
		if (currentPreview.expectedScope !== p.expectedScope || !containsAll(currentPreview)) throw new Usage("商品稿在准备期间已变化，未提交翻译");
		try {
			await (deps.translate ?? translate)(sql, fresh);
		} catch (failure) {
			error = failure instanceof Error ? failure.message : "象寄请求异常，请检查回执";
		}
	}
	const state = await translationState(sql, shas);
	await Promise.all(
		shas.map(async (sha) => {
			const receipt = state.get(sha);
			if (receipt?.url && !receipt.saved) await (deps.save ?? saveTranslation)(sql, sha, receipt.url).catch(() => {});
		}),
	);
	const receipts = new Map(await Promise.all(shas.map(async (sha) => [sha, await cachedTranslation(sql, sha)] as const)));
	return {
		id: p.id,
		error,
		images: items.map(({ sourceUrl, sha }) => {
			const translated = receipts.get(sha);
			const receipt = state.get(sha);
			return {
				sourceUrl,
				sourceSha256: sha,
				translation: translated ? { url: translated.url, sha256: translated.image.sha256 } : null,
				status: translated ? "ready" : receipt?.url ? "download-pending" : receipt?.retryable ? "failed" : receipt ? "unknown" : "not-submitted",
				message: translated ? null : (receipt?.failed ?? null),
			};
		}),
	};
}
