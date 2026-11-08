// 单件详情只映射站点原生文字、详情图及尺码表；图片内文字由原图展示，不猜材质、尺寸或用途。
import { z } from "zod";
import { type ProductInfo, productImageUrl } from "../../connectors/sites/shopee/products.ts";
import type { DescriptionBlock, ProductDescription } from "./facts.ts";

const richText = z.looseObject({ field_list: z.array(z.unknown()) });
const field = z.looseObject({ type: z.number().int(), value: z.string() });

export function productDescription(info: ProductInfo): ProductDescription | null {
	const raw = info.description_info?.description;
	if (raw == null) return null;
	const type = info.description_info?.description_type;
	if (type && type !== "normal" && type !== "json") return { blocks: [], error: `Shopee 描述格式 ${type} 暂不支持展示` };
	// 旧详情样本省略 description_type，但仍返回原生 field_list；普通文字始终作为文字展示。
	if (type !== "json" && (type === "normal" || !raw.trimStart().startsWith("{")))
		return { blocks: raw.trim() ? [{ type: "text", text: raw }] : [], error: null };
	let parsed: z.infer<typeof richText>;
	try {
		parsed = richText.parse(JSON.parse(raw));
	} catch {
		return { blocks: [], error: "Shopee 富文本描述解析失败，详情内容尚未完整读取" };
	}
	const blocks: DescriptionBlock[] = [];
	let unknown = 0;
	for (const value of parsed.field_list) {
		const result = field.safeParse(value);
		if (!result.success) {
			unknown++;
			continue;
		}
		const current = result.data;
		if (current.type === 0) {
			if (current.value.trim()) blocks.push({ type: "text", text: current.value });
		} else if (current.type === 1) {
			const src = productImageUrl(current.value);
			if (src) blocks.push({ type: "image", src });
			else unknown++;
		} else unknown++;
	}
	return { blocks, error: unknown ? `Shopee 描述中有 ${unknown} 项格式未知，当前仅展示可确认的文字和图片` : null };
}

export function productContent(info: ProductInfo) {
	const sizeChart = info.size_chart_info?.size_chart;
	return {
		productImages:
			info.images == null
				? null
				: info.images.flatMap((value) => {
						const src = typeof value === "string" ? productImageUrl(value) : null;
						return src ? [src] : [];
					}),
		description: productDescription(info),
		sizeChartImage: typeof sizeChart === "string" ? productImageUrl(sizeChart) : null,
	};
}
