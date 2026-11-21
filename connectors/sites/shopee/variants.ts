// 商品规格更新：沿用卖家中心 update_product_info 的字段，只提交一次；现读和回读由业务写操作负责。
import { z } from "zod";
import { submit } from "../../../platform/tool.ts";
import { updateProduct } from "./products.ts";
import { ItemId, ModelId } from "./seller.ts";

const positiveId = (id: string) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0;
const tierIndex = z.array(z.number().int().nonnegative()).min(1);
const price = z.string().refine((value) => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) > 0, "规格价格须为正数字符串");

const existingModel = z.object({
	id: ModelId.refine(positiveId, "既有规格 id 须为安全正整数"),
	tier_index: tierIndex,
	price,
});
const newModel = z.object({
	id: z.literal(0),
	tier_index: tierIndex,
	price,
	sku: z.string().min(1),
	stock_setting_list: z.array(z.object({ sellable_stock: z.number().int().nonnegative() })).min(1),
	is_default: z.boolean(),
	confirm_empty_gtin: z.boolean(),
	gtin_code: z.string(),
	sku_image: z.string(),
});

export const addSizeInfo = z.object({
	name: z.string().min(1),
	description_info: z.looseObject({ description: z.string(), description_type: z.string().min(1) }),
	std_tier_variation_list: z.array(
		z.looseObject({
			custom_value: z.string().min(1),
			value_list: z.array(
				z.looseObject({
					custom_value: z.string().min(1),
					image_id: z.string().nullish(),
					id: z.union([z.number(), z.string()]).optional(),
				}),
			),
		}),
	),
	model_list: z.array(z.union([existingModel, newModel])).min(1),
});
export type AddSizeInfo = z.output<typeof addSizeInfo>;

export const addSizeProduct = submit(
	"修改商品規格及對應名稱、描述（只经业务工具的写工具调）",
	z.object({ productId: ItemId.refine(positiveId, "商品 id 须为安全正整数"), info: addSizeInfo }),
	async (p) => {
		const w = await updateProduct(p.productId, {
			...p.info,
			model_list: p.info.model_list.map((model) => ({ ...model, id: Number(model.id) })),
		});
		return w.kind === "refused" ? { kind: "refused", why: `${w.code ?? ""} ${w.why}`.trim() } : w;
	},
);

/** 单规格展开或扩充完整规格表；旧模型只更新索引/图/原价，不发送库存或货号。 */
const retainedModel = existingModel.extend({ sku_image: z.string() });
export const expandInfo = z.object({
	std_tier_variation_list: addSizeInfo.shape.std_tier_variation_list.min(1).max(2),
	description_info: addSizeInfo.shape.description_info.optional(),
	model_list: z
		.array(z.union([retainedModel, newModel]))
		.min(1)
		.max(100),
	weight: z.object({ value: price, unit: z.literal(1) }).optional(),
});
export type ExpandInfo = z.output<typeof expandInfo>;
export const expandProductInfo = (info: ExpandInfo) => ({ ...info, model_list: info.model_list.map((m) => ({ ...m, id: Number(m.id) })) });
export const expandProduct = submit(
	"展開商品規格和對應圖片，保留舊規格id、價格、貨號及庫存（只经业务工具的写工具调）",
	z.object({ productId: ItemId.refine(positiveId), info: expandInfo }),
	async (p) => {
		const w = await updateProduct(p.productId, expandProductInfo(p.info));
		return w.kind === "refused" ? { kind: "refused", why: `${w.code ?? ""} ${w.why}`.trim() } : w;
	},
);
