// 单稿尺码表：只上传人已审核的图片，保存来源、证据与源规格指纹；不推断尺寸，也不修改已建商品。
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { fetchImage, inspect } from "../../connectors/services/image/api.ts";
import { uploadImages } from "../../connectors/sites/shopee/products.ts";
import type { Json, Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { flag } from "../../platform/tool.ts";
import { originalImageUpload } from "./images.ts";
import { inShopQueued, once } from "./queue.ts";
import { ListingId, type ListingRow, type ShopSettingsRow } from "./row.ts";
import { specsOf } from "./variants.ts";

const hash = z.string().regex(/^[a-f\d]{64}$/);
export const sizeChartSchema = z.object({
	shop: z.string().min(1),
	offerId: z.string().min(1),
	source: z.string().min(1),
	sha256: hash,
	imageId: z.string().regex(/^[A-Za-z0-9_-]+$/, "尺码表须为非空 Shopee 图片 id"),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	evidence: z.string().trim().min(1),
	scope: hash,
	at: z.iso.datetime(),
});
export type SizeChart = z.output<typeof sizeChartSchema>;

const source = z
	.string()
	.trim()
	.min(1)
	.refine((value) => isAbsolute(value) || z.url({ protocol: /^https?$/ }).safeParse(value).success, "尺码图来源须为 HTTP(S) URL 或本地图片绝对路径")
	.transform((value) => (isAbsolute(value) ? resolve(value) : new URL(value).href));
export const listingSizeChartParams = z.object({
	id: ListingId.describe("未建商品稿编号"),
	source: source.describe("已审核真实尺码图的 HTTP(S) URL 或本地 PNG/JPEG/WebP 绝对路径"),
	evidence: z.string().trim().min(1).describe("本稿真实源规格及尺码依据，包含原始来源；不补造内长或脚长"),
	replace: flag("显式替换本稿已保存的尺码图；默认不覆盖").default(false),
});
type Input = z.output<typeof listingSizeChartParams>;
type ScopeRow = Pick<ListingRow, "shop" | "offer_id" | "offer" | "variants">;

/** 只绑定源规格事实，不因售价、库存或译名变化失效；新增、删除或更换源规格须重新审核。 */
export function sizeChartScope(row: ScopeRow): string {
	const specs = specsOf(row.variants);
	if (!row.offer || !specs?.variants.length) throw new Usage("商品稿没有来源或规格，先做商品稿");
	const selected = specs.variants.map((v) => {
		const original = row.offer!.skus.find((sku) => sku.skuId === v.skuId);
		if (!original) throw new Usage(`尺码表：源货品没有已选 SKU ${v.skuId}`);
		const options = v.options.map((index, tier) => {
			const t = specs.tiers[tier],
				o = t?.options[index];
			if (!t || !o) throw new Usage("尺码表：商品稿规格选项不完整");
			return { tier: t.source, value: o.source };
		});
		return { skuId: v.skuId, specId: v.specId, options, sourceName: original.name, sourceAttrs: original.attrs };
	});
	selected.sort((a, b) => a.skuId.localeCompare(b.skuId));
	return createHash("sha256")
		.update(JSON.stringify({ shop: row.shop, offerId: row.offer_id, selected }))
		.digest("hex");
}

export function sizeChartEditable(row: Pick<ListingRow, "product_id" | "listed_at" | "size_chart">, replace = false): void {
	if (row.product_id !== null || row.listed_at !== null) throw new Usage("商品已经建成或上架；草稿尺码表工具不修改现有商品");
	if (row.size_chart && !replace) throw new Usage("本稿已保存尺码表；核对后使用 --replace 显式替换，不覆盖人工选择");
}

/** 空值旧稿保持原行为；已设置图必须属于当前店、货源及源规格。 */
export function sizeChartOf(row: ScopeRow & Pick<ListingRow, "size_chart">): string | null {
	if (row.size_chart == null) return null;
	const parsed = sizeChartSchema.safeParse(row.size_chart);
	if (!parsed.success) throw new Usage("尺码表：已保存的图片元数据不完整，请重新核对设置");
	const chart = parsed.data;
	if (chart.shop !== row.shop || chart.offerId !== row.offer_id || chart.scope !== sizeChartScope(row))
		throw new Usage("尺码表：店铺、货源或已选源规格已变，请重新核对后显式替换");
	return chart.imageId;
}

const state = (row: ListingRow) => JSON.stringify([sizeChartScope(row), row.size_chart ?? null]);

export async function setListingSizeChart(sql: Sql, p: Input) {
	const [row] = await sql<ListingRow[]>`select * from listings where id = ${p.id}`;
	if (!row) throw new Usage(`没有商品稿 ${p.id}`);
	sizeChartEditable(row, p.replace);
	const before = state(row);
	const [shop] = await sql<Pick<ShopSettingsRow, "shop_id">[]>`select shop_id from shop_settings where shop = ${row.shop}`;
	if (!shop) throw new Usage(`没有店铺设置 ${row.shop}`);
	const image = isAbsolute(p.source) ? inspect(new Uint8Array(await readFile(p.source)), p.source) : await fetchImage(p.source);
	if (image.width <= 0 || image.height <= 0) throw new Usage("尺码图宽高必须大于零");
	await sql`insert into images ${sql({
		sha256: image.sha256,
		kind: "尺码表",
		source: p.source,
		mime: image.mime,
		width: image.width,
		height: image.height,
		bytes: Buffer.from(image.bytes),
	})} on conflict (sha256) do nothing`;
	const imageId = await once(`尺码表:${row.shop}:${image.sha256}`, async () => {
		const [cached] = await sql<{ image_id: string }[]>`select image_id from shop_images where shop = ${row.shop} and sha256 = ${image.sha256}`;
		if (cached) return cached.image_id;
		const { file } = originalImageUpload(image);
		const [uploaded] = await inShopQueued(shop.shop_id, () => uploadImages([file]));
		if (!uploaded) throw new Error("尺码图上传没有返回图片 id");
		await sql`insert into shop_images ${sql({ shop: row.shop, sha256: image.sha256, image_id: uploaded, width: image.width, height: image.height })}
			on conflict (shop, sha256) do update set image_id = excluded.image_id, uploaded_at = now()`;
		return uploaded;
	});
	const chart = sizeChartSchema.parse({
		shop: row.shop,
		offerId: row.offer_id,
		source: p.source,
		sha256: image.sha256,
		imageId,
		width: image.width,
		height: image.height,
		evidence: p.evidence,
		scope: sizeChartScope(row),
		at: new Date().toISOString(),
	});
	return sql.begin(async (tx) => {
		const [fresh] = await tx<ListingRow[]>`select * from listings where id = ${p.id} for update`;
		if (!fresh) throw new Usage(`没有商品稿 ${p.id}`);
		sizeChartEditable(fresh, p.replace);
		if (state(fresh) !== before) throw new Usage("商品稿的源规格或尺码表已变化，未覆盖人工修改；请重新核对");
		const [saved] = await tx<Pick<ListingRow, "size_chart">[]>`update listings set size_chart = ${tx.json(chart as Json)}, updated_at = now()
			where id = ${p.id} returning size_chart`;
		return { id: p.id, shop: row.shop, sizeChart: saved!.size_chart, before: row.size_chart ?? null };
	});
}
