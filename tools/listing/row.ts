// 库里读出的商品稿、店铺设置的一行：列照 schema.sql（numeric、bigint 回字符串，jsonb 回写进去的样子）。读库的地方用 sql<ListingRow[]>，不再当 any 往下传
import { z } from "zod";
import type { Freight, Offer, OfferId, Tags } from "../../connectors/sites/1688/api.ts";
import type { Audit } from "./audit.ts";
import type { Pics } from "./pics.ts";
import type { Product } from "./product.ts";

/** 商品稿编号（listings 的 id）：命令行参数、写入的参数、读库时贴上，别和货源 id、Shopee 商品 id 传混 */
export const ListingId = z.string().regex(/^\d+$/, "商品稿编号是数字").brand<"ListingId">();
export type ListingId = z.output<typeof ListingId>;

export type ListingRow = {
	id: ListingId;
	shop: string;
	offer_id: OfferId;
	strategy: string;
	cancelled: boolean;
	weight_kg: string | null;
	freight_rmb: string | null;
	title: string | null;
	description: string | null;
	note: string | null;
	noted: string | null;
	nickname: string | null;
	offer: Offer | null;
	offer_read_at: Date | null;
	category_id: string | null;
	category_path: number[] | null;
	category_name: string | null;
	attributes: Product["attributes"] | null;
	attributes_text: string | null;
	days_to_ship: number | null;
	/** 规格：现在的样子照 variants.ts 的 specsOf 认，旧格式认不出是 null */
	variants: unknown;
	images: Partial<Pics>;
	/** 上次核价：用的参数、国内运费、时间（make.ts 的 savePrices 写的） */
	pricing: { freightRmb?: number | null } | null;
	audit: Partial<Audit> | null;
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
	pricing?: { freightRmb?: number | null } | null;
};

export type ShopSettingsRow = {
	shop: string;
	shop_id: string;
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
