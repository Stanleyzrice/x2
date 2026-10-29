// 建商品的 product_info，和建完以后读回来逐项核对。照 lilto 的 build_product_info、submitted_content_problems（快照 1c8a7926）：
// 9-01 卖家中心新增商品页提交的成功样本逐字段照抄。
// 也定商品里用哪几张主图、详情图，和图的名字（主图 N、详情图 N、规格图：选项名；网页上、说明里、x2 listing keep 都用它）
import type { Pic, Pics } from "./pics.ts";
import { isSingle, type Specs, structureProblems, type Tier, type Variant } from "./variants.ts";

/** 物流渠道：9-01 成功样本原样（顺序也照抄）。有尺寸的渠道 sizeid 是 1，填成 0 回 1000100256。只按店铺设置开关 enabled */
export const CHANNELS: { size: number; price: string; cover_shipping_fee: boolean; enabled: boolean; channelid: number; sizeid: number }[] = [
	{ size: 0, price: "0", cover_shipping_fee: false, enabled: true, channelid: 30006, sizeid: 0 }, // 全家
	{ size: 0, price: "65", cover_shipping_fee: false, enabled: true, channelid: 30020, sizeid: 1 }, // 新竹物流
	{ size: 0, price: "0", cover_shipping_fee: false, enabled: true, channelid: 30005, sizeid: 0 }, // 7-ELEVEN
	{ size: 0, price: "0", cover_shipping_fee: false, enabled: false, channelid: 30019, sizeid: 0 }, // 蝦皮店到店-隔日到貨：不支持较长备货
	{ size: 0, price: "65", cover_shipping_fee: false, enabled: true, channelid: 30018, sizeid: 1 }, // 嘉里快遞
	{ size: 0, price: "0", cover_shipping_fee: false, enabled: true, channelid: 30015, sizeid: 0 }, // 蝦皮店到店
	{ size: 0, price: "70", cover_shipping_fee: false, enabled: true, channelid: 30012, sizeid: 1 }, // 宅配通
	{ size: 0, price: "65", cover_shipping_fee: false, enabled: true, channelid: 30017, sizeid: 1 }, // 店到家宅配
];
export const CHANNEL_NAMES: Record<string, string> = {
	"30005": "7-ELEVEN",
	"30006": "全家",
	"30012": "宅配通",
	"30015": "蝦皮店到店",
	"30017": "店到家宅配",
	"30018": "嘉里快遞",
	"30019": "蝦皮店到店-隔日到貨",
	"30020": "新竹物流",
};

/** 要建的一个商品：商品稿的内容，图都已经传好（Shopee 的图片 id） */
export type Product = {
	parentSku: string;
	title: string;
	description: string;
	categoryPath: number[];
	attributes: { attribute_id: number; attribute_values: { value_id: number }[] }[];
	preOrder: boolean;
	daysToShip: number;
	minPurchase: number;
	/** 开的物流渠道 id */
	channels: string[];
	/** 规格的层：第一层的选项带规格图（1688 原图地址，没传上去的是 null） */
	tiers: Tier[];
	/** 每个规格：每层一个选项的下标，都有售价（台币整数）、库存、重量 */
	variants: (Variant & { priceTwd: number })[];
	/** 主图的图片 id（第一张是封面，最多 9 张） */
	images: string[];
	/** 详情图：图片 id 和真实宽高（见 detailFits） */
	detail: { id: string; width: number; height: number }[];
	/** 规格图：1688 原图地址 → 成品的图片 id */
	optionImages: Record<string, string>;
	/** 尺码表的图片 id（不要就是空） */
	sizeChart: string | null;
};

/** 详情图 Shopee 收不收：宽 ≥ 700、高 ≥ 32、宽高比在 0.5–32 之间（太长的回 1000100256 description.richtext.image.aspect.ratio.range） */
export const detailFits = (width: number, height: number) => width >= 700 && height >= 32 && width / height >= 0.5 && width / height <= 32;

export const MAX_MAIN = 9,
	MAX_DETAIL = 12;
/** 图的名字：主图 N、详情图 N */
export const LABEL = { main: "主图", detail: "详情图" } as const;

/** 主图、详情图排上号（「主图 N」「详情图 N」）：传好的图（有图片 id；详情图的尺寸还要合 Shopee 的要求）按顺序排，
 * 人删了的、x2 去掉的也占着号，别的图的名字不跟着变 */
export function numbered(pics: Partial<Pics>, role: "main" | "detail"): { pic: Pic; n: number }[] {
	let n = 0;
	return (pics[role] ?? []).flatMap((pic) => (pic.imageId && (role === "main" || detailFits(pic.width ?? 0, pic.height ?? 0)) ? [{ pic, n: ++n }] : []));
}

/** 商品里用的主图、详情图（网页、组商品都用它）：排上号的里面没去掉、没被人删的，主图最多 9 张、详情图最多 12 张 */
export function usedPics(pics: Partial<Pics>, role: "main" | "detail", removed: Set<string>): { pic: Pic; n: number }[] {
	return numbered(pics, role)
		.filter(({ pic }) => !pic.drop && !removed.has(pic.imageId!))
		.slice(0, role === "main" ? MAX_MAIN : MAX_DETAIL);
}

/** 图的名字（图片 id → 名字）：主图 N、详情图 N、规格图：选项名。一张图在几处就写几个 */
export function imageNames(pics: Partial<Pics>, specs: Specs | null): Map<string, string> {
	const names = new Map<string, string[]>();
	const add = (id: string, name: string) => names.set(id, [...(names.get(id) ?? []), name]);
	for (const role of ["main", "detail"] as const) for (const { pic, n } of numbered(pics, role)) add(pic.imageId!, `${LABEL[role]} ${n}`);
	const option = new Map((pics.options ?? []).filter((p) => p.imageId).map((p) => [p.from, p.imageId!]));
	if (specs && !isSingle(specs))
		for (const o of specs.tiers[0]?.options ?? []) {
			const id = o.image ? option.get(o.image) : undefined;
			if (id) add(id, `规格图：${o.name}`);
		}
	return new Map([...names].map(([id, list]) => [id, list.join("、")]));
}

/** 商品稿 → product_info。规格（std_tier_variation_list、model_list 的 tier_index）照存着的结构；规格不对、缺图、详情图尺寸不够、渠道不认得都抛错，不缺着交 */
export function productInfo(p: Product): Record<string, unknown> {
	const bad = structureProblems({ tiers: p.tiers, variants: p.variants });
	if (bad.length) throw new Error(bad.join("；"));
	const std = p.tiers.map((t, a) => ({
		id: 0,
		custom_value: t.name,
		value_list: t.options.map((o) => {
			if (a > 0 || !o.image) return { id: 0, custom_value: o.name };
			const id = p.optionImages[o.image];
			if (!id) throw new Error(`规格「${o.name}」的图未传到 Shopee`);
			return { id: 0, custom_value: o.name, image_id: id };
		}),
	}));
	const model_list = p.variants.map((v, i) => ({
		id: 0,
		tier_index: v.options,
		is_default: i === 0,
		sku: v.sku,
		gtin_code: "",
		confirm_empty_gtin: false,
		price: String(Math.trunc(v.priceTwd)),
		stock_setting_list: [{ sellable_stock: Math.trunc(v.stock) }],
		sku_image: "",
	}));
	const weights = p.variants.map((v) => v.weightKg ?? 0);
	if (weights.some((w) => !(w > 0))) throw new Error("有规格缺重量");
	const known = new Set(CHANNELS.map((c) => String(c.channelid)));
	const unknown = p.channels.filter((c) => !known.has(c));
	if (unknown.length) throw new Error(`不认得的物流渠道：${unknown.join("、")}`);
	const logistics_channels = CHANNELS.map((c) => ({ ...c, enabled: p.channels.includes(String(c.channelid)) && c.channelid !== 30019 }));
	if (!logistics_channels.some((c) => c.enabled)) throw new Error("未开任何物流渠道");
	const fields: Record<string, unknown>[] = [
		{
			type: 0,
			value: p.description
				.replace(/<[^>]*>/g, "")
				.trim()
				.slice(0, 3000),
		},
	];
	for (const d of p.detail) {
		if (!detailFits(d.width, d.height)) throw new Error(`详情图 ${d.id} 尺寸不合 Shopee 的要求（${d.width}×${d.height}：宽 ≥ 700、高 ≥ 32、宽高比 0.5–32）`);
		fields.push({ type: 1, value: d.id, width: d.width, height: d.height });
	}
	if (p.images.length === 0) throw new Error("缺主图");
	return {
		name: p.title.slice(0, 60),
		enable_model_level_dts: false,
		category_path: p.categoryPath,
		weight: { value: String(Math.max(...weights)), unit: 1 },
		condition: 1,
		parent_sku: p.parentSku,
		brand_id: 0,
		authorised_brand_id: 0,
		attributes: p.attributes,
		images: p.images.slice(0, 9),
		long_images: [],
		gallery_image_list: [],
		std_tier_variation_list: std,
		size_chart_info: { size_chart: p.sizeChart ?? "" },
		video_list: [],
		description_info: { description: JSON.stringify({ field_list: fields }), description_type: "json" },
		dimension: { length: "", width: "", height: "" },
		pre_order_info: { pre_order: p.preOrder, days_to_ship: p.daysToShip },
		wholesale_list: [],
		unlisted: true,
		tax_setting: { tw_tax_setting: { tax_type: 0 } },
		min_purchase_limit: p.minPurchase,
		dangerous_goods: 0,
		model_list,
		scheduled_publish_time: 0,
		logistics_channels,
	};
}
