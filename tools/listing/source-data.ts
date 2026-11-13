// 1688原始商品快照与人工补充：只整理技术结构，保留来源原文，未知的价格和库存不补零。
import { createHash } from "node:crypto";
import { z } from "zod";
import { type Offer, OfferId, offerIdOf, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import { strs } from "../../platform/tool.ts";

export const SourceId = z.string().regex(/^\d+$/).brand<"SourceId">();
export type SourceId = z.output<typeof SourceId>;
export const sourcePlatform = z.enum(["1688"]);
const httpUrl = z.url({ protocol: /^https?$/ });
export const descriptionBlock = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({ type: z.literal("image"), src: httpUrl }),
]);
export const sourceProductSchema = z
	.object({
		platform: sourcePlatform,
		sourceId: z.string().regex(/^\d+$/),
		url: httpUrl,
		title: z.string(),
		images: z.array(httpUrl),
		props: z.array(z.object({ name: z.string(), values: z.array(z.object({ name: z.string(), image: z.string() })) })),
		skus: z.array(
			z.object({
				id: z.string().min(1),
				specId: z.string(),
				name: z.string(),
				attrs: z.array(z.string()),
				price: z.number().nonnegative().finite().nullable(),
				stock: z.number().int().nonnegative().nullable(),
				image: z.string().nullable(),
				weightKg: z.number().positive().finite().nullable(),
			}),
		),
		description: z.object({ text: z.string(), images: z.array(httpUrl), blocks: z.array(descriptionBlock) }),
		minQty: z.number().int().positive().nullable(),
		freightRmb: z.number().nonnegative().finite().nullable(),
		freeShipping: z.boolean().nullable(),
		tags: z.object({ onePsale: z.boolean(), freeShipping: z.boolean(), ship48h: z.boolean(), deliveryDays: z.number().nullable() }).optional(),
		errors: z.array(z.string()),
	})
	.refine(
		(source) => {
			const host = new URL(source.url).hostname;
			return (host === "1688.com" || host.endsWith(".1688.com")) && offerIdOf(source.url) === source.sourceId;
		},
		{ path: ["url"], message: "1688链接与商品编号不一致" },
	);
export type SourceProduct = z.output<typeof sourceProductSchema>;
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
	mainImages: z.array(httpUrl).min(1).max(9).optional(),
	detailImages: z.array(httpUrl).max(12).optional(),
});
export type SourceFields = z.output<typeof sourceFieldsSchema>;

// 备选区的输入和列表契约集中在数据边界；工具实现只负责读取、保存和串接既有上架。
export const sourceShopParams = z.object({ shop: z.string().min(1), targetShop: z.string().min(1).optional() });
export type SourceShopInput = z.output<typeof sourceShopParams>;
export const sourceSelectionParams = sourceShopParams.extend({
	sourceIds: strs("备选商品编号，逗号分隔；不给表示全部").pipe(z.array(SourceId).max(1000)).optional(),
	requestId: z.string().uuid().optional(),
});
export const sourceDetailParams = sourceShopParams.extend({ sourceId: SourceId });
export const sourceDeleteParams = sourceShopParams.extend({
	sourceIds: strs("明确删除的备选商品编号，不能为空")
		.pipe(z.array(SourceId).min(1).max(1000))
		.transform((ids) => [...new Set(ids)]),
});
export const sourceStatus = z.enum(["collected", "needs-input", "ready", "listed", "unknown"]);
export const sourceListParams = sourceShopParams.extend({
	query: z.string().default(""),
	platform: z.enum(["all", ...sourcePlatform.options]).default("all"),
	status: z.enum(["all", ...sourceStatus.options]).default("all"),
});
export const sourceUpdateParams = sourceDetailParams.extend(sourceFieldsSchema.shape);
export const sourcePublishParams = sourceSelectionParams.extend({
	requestId: z.string().uuid(),
	sourceIds: z.array(SourceId),
	products: z.array(z.object({ sourceId: SourceId, listingId: z.string(), hash: z.string().regex(/^[a-f0-9]{64}$/) })),
});
export type SourcePublishInput = z.output<typeof sourcePublishParams>;
export const sourcePublishResultParams = sourceShopParams.extend({ requestId: z.string().uuid() });
export type SourceItem = {
	id: string;
	platform: SourceProduct["platform"];
	sourceId: string;
	url: string;
	title: string;
	image: string | null;
	skuCount: number;
	capturedAt: string;
	errors: string[];
	status: z.output<typeof sourceStatus>;
	problems: string[];
	listingId: string | null;
	productId: string | null;
	deletable: boolean;
	deleteProblem: string | null;
};
export type SourceApproval = { kind: "original-source"; sourceProductId: string; hash: string; at: string };
/** 新建使用完整product指纹；已有商品仍须把本次批准绑定到当前稿与实际商品编号。 */
export function sourcePublicationHash(
	row: { id: string; shop: string; product_id: string | null; title: string | null; cancelled: boolean; listed_at: Date | null },
	productHash?: string,
): string | undefined {
	return (
		productHash ??
		(row.product_id
			? createHash("sha256")
					.update(
						JSON.stringify({ id: row.id, productId: row.product_id, shop: row.shop, title: row.title, cancelled: row.cancelled, listedAt: row.listed_at }),
					)
					.digest("hex")
			: undefined)
	);
}
export const originalSourceApproved = (
	approval: SourceApproval | null | undefined,
	sourceId: string | null | undefined,
	imageMode: string | undefined,
	hash: string | undefined,
) =>
	Boolean(
		sourceId &&
			imageMode === "original" &&
			hash &&
			approval?.kind === "original-source" &&
			approval.sourceProductId === String(sourceId) &&
			approval.hash === hash &&
			approval.at,
	);

/** 未完整的SKU只留在备选区；显式补充覆盖转换用值，不改来源快照。 */
export function sourceOffer(source: SourceProduct, fields: SourceFields = {}): { offer: Offer | null; problems: string[] } {
	const problems: string[] = [];
	const minQty = fields.minQty ?? source.minQty;
	if (!minQty) problems.push("货源：起订量未知，待补充");
	if (!source.skus.length) problems.push("规格：尚未取得商品规格");
	const skus: Offer["skus"] = [];
	for (const sku of source.skus) {
		const label = sku.name || sku.attrs.join(" / ") || sku.id;
		const price = fields.prices?.[sku.id] ?? sku.price,
			stock = fields.stocks?.[sku.id] ?? sku.stock;
		if (price === null) problems.push(`规格：${label} 的采购价未知`);
		if (stock === null) problems.push(`规格：${label} 的库存未知`);
		if (price !== null && stock !== null)
			skus.push({
				skuId: SkuId.parse(sku.id),
				specId: SpecId.parse(sku.specId),
				attrs: sku.attrs,
				name: sku.name,
				price,
				stock,
				image: sku.image ?? "",
				weightKg: sku.weightKg,
			});
	}
	if (new Set(source.skus.map((s) => s.id)).size !== source.skus.length) problems.push("规格：来源SKU编号重复，待重新采集");
	if (problems.length || minQty === null) return { offer: null, problems };
	return {
		offer: {
			offerId: OfferId.parse(source.sourceId),
			url: source.url,
			title: source.title,
			image: source.images[0] ?? "",
			images: source.images,
			unit: "",
			minQty,
			props: source.props,
			skus,
			...(source.freightRmb !== null ? { freight: { costRmb: source.freightRmb, to: "来源页面" } } : {}),
			...(source.tags ? { tags: source.tags } : {}),
		},
		problems,
	};
}
