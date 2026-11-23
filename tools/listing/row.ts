import { z } from "zod";
import type { Freight, Offer, OfferId, Tags } from "../../connectors/sites/1688/api.ts";
import type { Audit } from "./audit.ts";
import type { CategoryException } from "./category.ts";
import type { ListingCoverage } from "./coverage.ts";
import type { Pics } from "./pics.ts";
import type { ChannelOption, Product } from "./product.ts";
import type { SizeChart } from "./size-chart.ts";
import type { SourceApproval, SourceFields } from "./source-data.ts";
import type { TemplateParams } from "./template-pricing.ts";

export type PricingSnapshot = {
	model?: "template" | "settlement";
	params?: Record<string, number>;
	preOrder?: boolean;
	freightRmb?: number | null;
	minimumPurchase?: number;
	at?: string;
};

/** 商品稿编号（listings 的 id）：命令行参数、写入的参数、读库时贴上，别和货源 id、Shopee 商品 id 传混 */
export const ListingId = z.string().regex(/^\d+$/, "商品稿编号是数字").brand<"ListingId">();
export type ListingId = z.output<typeof ListingId>;

export type ListingRow = {
	id: ListingId;
	shop: string;
	offer_id: OfferId;
	source_product_id?: string | null;
	source_fields?: SourceFields | null;
	source_approval?: SourceApproval | null;
	strategy: string;
	cancelled: boolean;
	weight_kg: string | null;
	/** 兼容旧库保存的人填重量覆盖标志；缺列的旧快照不补值。 */
	weight_override?: boolean;
	freight_rmb: string | null;
	/** 单稿最低购买数量；null 或旧快照未提供时沿用店铺默认。 */
	min_purchase?: number | null;
	/** 单稿启用的物流渠道；null 或旧快照缺列沿用店铺配置。 */
	channel_ids?: string[] | null;
	/** 单稿逐渠道的原生档位、运费覆盖；null/缺列保留既有默认。 */
	channel_options?: ChannelOption[] | null;
	title: string | null;
	description: string | null;
	note: string | null;
	noted: string | null;
	nickname: string | null;
	offer: (Offer & { detail?: string[] }) | null;
	offer_read_at: Date | null;
	category_id: string | null;
	category_path: number[] | null;
	category_name: string | null;
	/** 显式单稿类目例外，仅绑定该叶子，不扩展全店允许范围。 */
	category_exception?: CategoryException | null;
	attributes: Product["attributes"] | null;
	attributes_text: string | null;
	days_to_ship: number | null;
	/** 规格：现在的样子照 variants.ts 的 specsOf 认，旧格式认不出是 null */
	variants: unknown;
	images: Partial<Pics>;
	/** 单稿已审核尺码图、来源与源规格指纹；null/旧快照缺列表示未设置。 */
	size_chart?: SizeChart | null;
	/** 上次核价：用的参数、国内运费、时间（make.ts 的 savePrices 写的） */
	pricing: PricingSnapshot | null;
	audit: Partial<Audit> | null;
	coverage?: ListingCoverage | null;
	problems: string | null;
	step: string | null;
	step_detail: string | null;
	product_id: string | null;
	listed_at: Date | null;
	removed_images: string[] | null;
	removed_variants: string[] | null;
	kept_images: string[] | null;
	pick_why: string | null;
	pick_evidence: string | null;
	pick_snapshot: unknown;
	created_at: Date;
	updated_at: Date;
};

/** 核价只看货源的这几格（规格的重量、运费、包邮）：完整的 Offer 也是它 */
export type OfferLike = Partial<Omit<Offer, "skus" | "tags" | "freight">> & {
	skus?: { skuId: string; weightKg?: number | null; attrs?: string[]; name?: string }[];
	tags?: Partial<Tags>;
	freight?: Partial<Freight> | null;
};
/** 核价要的商品稿的几格 */
export type PriceInput = {
	variants: unknown;
	offer: OfferLike | null;
	weight_kg?: string | null;
	freight_rmb?: string | null;
	min_purchase?: number | null;
	pricing?: PricingSnapshot | null;
};

export type ShopSettingsRow = {
	shop: string;
	shop_id: string;
	pricing_template: TemplateParams | null;
	fx: string;
	price_per_kg_rmb: string;
	label_fee_rmb: string;
	weight_rounding_kg: string;
	return_loss_rate: string;
	min_margin_rate: string;
	min_margin_rmb: string;
	commission_rate: string;
	pre_order_rate: string;
	payment_rate: string;
	coin_rate: string;
	free_shipping_rate: string;
	free_shipping_min_twd: string;
	shipping_net_twd: string;
	pre_order: boolean;
	min_purchase: number;
	stock_cap: number;
	channels: string | null;
	categories: unknown;
	watermark_text: string | null;
	watermark_size: number;
	watermark_opacity: string;
	watermark_position: "top-left" | "top-right" | "center" | "bottom-left" | "bottom-right";
	paused: string | null;
};
