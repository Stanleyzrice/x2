// x2 shopee <工具>：卖家中心的工具。读的直接跑；建商品、上架是写（publish.ts），只经业务工具的写工具调
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { inAccount } from "../../../platform/browser/browser.ts";
import { all, byPage, day, flag, get, list, num, parseJson, str, type Toolkit } from "../../../platform/tool.ts";
import { conversations, messages, unreplied } from "./chat.ts";
import { income, incomeComponents } from "./finance.ts";
import { article, articles } from "./help.ts";
import {
	adsAccount,
	adsSetup,
	bundles,
	campaign,
	campaignGraph,
	campaigns,
	discountItems,
	discounts,
	gmsItems,
	reviews,
	shopMetrics,
	voucher,
	vouchers,
} from "./marketing.ts";
import { drafts, recordFile, records, template } from "./mass.ts";
import { oneOrder, orders, TAB } from "./orders.ts";
import {
	allProducts,
	attributes,
	categoryTree,
	channels,
	countLimit,
	liveProducts,
	performance,
	productInfo,
	recommendedCategory,
	shippingDays,
	uploadDiagnostics,
	uploadPrepare,
} from "./products.ts";
import { createListing, editProduct, listProduct, unlistProduct } from "./publish.ts";
import { cases } from "./returns.ts";
import { seller, shop } from "./seller.ts";
import {
	createShopCategoryDraftTool,
	createShopCategoryTool,
	setShopCategoryStatusTool,
	shopCategories,
	shopCategory,
	shopCategoryDrafts,
	sortShopCategoriesTool,
} from "./shop-categories.ts";
import { addSizeProduct, expandProduct } from "./variants.ts";

const TABS = { all: TAB.all, unpaid: TAB.unpaid, "to-ship": TAB.toShip, shipping: TAB.shipping, completed: TAB.completed } as const;

async function save(b64: string, out: string) {
	const bytes = Buffer.from(b64, "base64");
	await writeFile(out, bytes);
	return { path: out, bytes: bytes.length };
}

const tools = {
	"create-product": createListing,
	"list-product": listProduct,
	"unlist-product": unlistProduct,
	"edit-product": editProduct,
	"add-size-product": addSizeProduct,
	"expand-product": expandProduct,
	"create-shop-category-draft": createShopCategoryDraftTool,
	"create-shop-category": createShopCategoryTool,
	"set-shop-category-status": setShopCategoryStatusTool,
	"sort-shop-categories": sortShopCategoriesTool,
	"shop-categories": all("店铺导览分类（非商品平台类目），含显示状态、排序和有效商品数", undefined, shopCategories),
	"shop-category": get("指定店铺分类及完整商品成员（包含异常成员），不是平台 category_path", z.object({ id: str("店铺分类 id") }), (p) => shopCategory(p.id)),
	"shop-category-drafts": all("店铺分类草稿，尚未转换成正式分类", undefined, shopCategoryDrafts),
	shop: get("当前登录的店铺：shopId（店铺 id）、userId（卖家账号 id）、店名、账号名、评分", undefined, () => shop()),

	orders: all(
		"一个标签下的全部订单（订单号、出货期限、商品和规格、包裹）",
		z.object({
			tab: z
				.enum(Object.keys(TABS) as [keyof typeof TABS])
				.default("to-ship")
				.describe("订单标签"),
		}),
		(p) => orders(TABS[p.tab]),
	),
	order: get("一张订单的原样详情（下单时间、金额、运费、买家；地址电话也在里面）", z.object({ id: str("订单 id（不是订单号）") }), (p) => oneOrder(p.id)),

	products: byPage("在售商品（每个带规格：价格、库存、销量）", undefined, async (_, n) => {
		const r = await liveProducts(n);
		return { rows: r.rows, more: n * 48 < r.total };
	}),
	"all-products": byPage("全部商品（含下架、审核中）：id、名字、状态码（0 删除、1 在售、2 审核中、3 禁卖、8 下架）", undefined, async (_, n) => {
		const r = await allProducts(n);
		return { rows: r.rows, more: n * 48 < r.total };
	}),
	product: get("一个商品的完整资料（原样的 product_info）", z.object({ id: str("商品 id") }), (p) => productInfo(p.id)),
	"product-channels": all("一个商品的物流渠道（新商品 --id 0）", z.object({ id: str("商品 id"), category: num("叶子类目 id") }), (p) =>
		channels(p.id, p.category),
	),
	"count-limit": get("商品额度：已发布、下架的、上限", undefined, () => countLimit()),
	"upload-diagnostics": get("只读诊断X2自有新增商品页、空表单与原生上传loader；不上传、不重载、不初始化服务", undefined, () => uploadDiagnostics()),
	"upload-prepare": get(
		"仅在X2自有新增商品页执行一次原生上传准备并保留首次异常；显式空页重载受守卫保护，不上传图片",
		z.object({
			reloadIfEmpty: flag("仅确认空白自有新增页后正常重载一次，再捕获首次初始化结果").default(false),
			attempts: z.coerce.number().int().min(1).max(5).default(1).describe("仅在模块尚未出现时有界等待；真正初始化一次后立即返回"),
		}),
		(p) => uploadPrepare(p.reloadIfEmpty, p.attempts),
	),
	"category-tree": all("Shopee 台湾站的类目树", undefined, () => categoryTree()),
	attributes: all("叶子类目的属性：必填的、可选值", z.object({ category: num("叶子类目 id") }), (p) => attributes(p.category)),
	"recommended-category": get(
		"Shopee 按商品名（和一张已传的图）推荐的类目",
		z.object({ name: str("商品名"), image: z.string().default("").describe("已传的图片 id（例商品资料 images 里的；只给商品名时站点常回空的 {}）") }),
		(p) => recommendedCategory(p.name, p.image),
	),
	"shipping-days": get("各类目的备货天数范围和现货的备货天数", undefined, () => shippingDays()),
	performance: byPage(
		"数据中心的商品表现：销售额、订单、件数、曝光、点击、访客、加购、转化",
		z.object({ start: day("开始"), end: day("结束", true), period: z.enum(["past7days", "past30days"]).describe("期间") }),
		async (p, n) => {
			const r = await performance(p.start, p.end, p.period, n);
			return { rows: r.rows, more: n * 50 < r.total };
		},
	),

	"shop-metrics": get(
		"店铺关键指标（成交额、订单、访客、点击、转化，每个带逐日 points）",
		z.object({ start: day("开始"), end: day("结束", true), period: z.enum(["past7days", "real_time"]).describe("期间") }),
		(p) => shopMetrics(p.start, p.end, p.period),
	),
	reviews: list("评价（每页 20 条）", z.object({ orderSn: z.string().optional().describe("只找这张订单的评价") }), async (p, cursor) => {
		const [n, last] = cursor ? (cursor.split(":") as [string, string]) : ["1", "0"];
		const r = await reviews(Number(n), last, p.orderSn);
		const lastId = r.rows.at(-1)?.comment_id;
		return { rows: r.rows, next: Number(n) * 20 < r.total && lastId ? `${Number(n) + 1}:${lastId}` : null };
	}),
	"ads-account": get("广告账户和广告余额", undefined, () => adsAccount()),
	"ads-setup": get("各类广告能不能开、已开的计划 id", undefined, () => adsSetup()),
	campaigns: list(
		"广告计划，带期间内的汇总表现（has_report_failure 时表现不完整）",
		z.object({ start: day("开始"), end: day("结束", true) }),
		async (p, cursor) => {
			const offset = Number(cursor ?? 0);
			const r = await campaigns(p.start, p.end, offset);
			if (r.reportFailed) console.error("Shopee 说这一页广告表现不完整（has_report_failure）");
			return { rows: r.rows, next: r.rows.length > 0 && offset + r.rows.length < r.total ? String(offset + r.rows.length) : null };
		},
	),
	campaign: get("一个商品广告计划的详情", z.object({ id: str("计划 id") }), (p) => campaign(p.id)),
	"campaign-graph": get(
		"一个计划在期间内的表现：汇总和逐日",
		z.object({ id: str("计划 id"), type: str("计划类型，例 product_gms"), start: day("开始"), end: day("结束", true) }),
		(p) => campaignGraph(p.id, p.type, p.start, p.end),
	),
	"gms-items": list(
		"自动广告（product_gms：Shopee 自己挑商品投放）里各商品的表现",
		z.object({ id: str("计划 id"), start: day("开始"), end: day("结束", true), all: flag("回全店能投的商品，不只是有曝光的").default(false) }),
		async (p, cursor) => {
			const r = await gmsItems(p.id, p.start, p.end, cursor ?? "", !p.all);
			return { rows: r.rows, next: r.next || null };
		},
	),
	vouchers: list("优惠券", undefined, async (_, cursor) => {
		const offset = Number(cursor ?? 0);
		const r = await vouchers(offset);
		return { rows: r.rows, next: r.rows.length > 0 && offset + r.rows.length < r.total ? String(offset + r.rows.length) : null };
	}),
	voucher: get("一张优惠券的详情", z.object({ id: str("优惠券 id") }), (p) => voucher(p.id)),
	bundles: list("组合购活动", undefined, async (_, cursor) => {
		const offset = Number(cursor ?? 0);
		const r = await bundles(offset);
		return { rows: r.rows, next: r.rows.length > 0 && offset + r.rows.length < r.total ? String(offset + r.rows.length) : null };
	}),
	discounts: get("进行中的折扣活动（原样的 data）", z.object({ offset: num("从第几个起").default(0) }), (p) => discounts(p.offset)),
	"discount-items": get(
		"一个折扣活动里各规格的折扣价（promotion_price 是新台币乘 100000）",
		z.object({ id: num("活动 id"), offset: num("从第几个起").default(0) }),
		(p) => discountItems(p.id, p.offset),
	),

	income: list(
		"已拨款的订单收入（金额是新台币乘 100000）",
		z.object({ start: str("拨款日期起，YYYY-MM-DD"), end: str("拨款日期止，YYYY-MM-DD") }),
		async (p, cursor) => {
			const r = await income(p.start, p.end, cursor ?? "");
			return { rows: r.rows, next: r.nextCursor || null };
		},
	),
	"income-components": get("一张订单的收入明细（汇总和子项不要重复相加）", z.object({ order: str("订单 id") }), (p) => incomeComponents(p.order)),
	returns: byPage("售后案件（退货、退款、不成立）", undefined, async (_, n) => {
		const r = await cases(n);
		return { rows: r.rows, more: r.hasMore };
	}),
	conversations: list("聊聊的会话，按最后一条消息从新到旧", undefined, async (_, cursor) => {
		const rows = await conversations(cursor ?? "");
		const next = String(rows.at(-1)?.next_timestamp_nano ?? "");
		return { rows, next: next && next !== cursor ? next : null };
	}),
	unreplied: list("聊聊的「未回覆」会话", undefined, async (_, cursor) => {
		const r = await unreplied(cursor ?? "");
		return { rows: r.rows, next: r.next && r.next !== cursor ? r.next : null };
	}),
	messages: all(
		"一个会话最近的 30 条消息（谁发的按 from_shop_id 认：等于 x2 shopee shop 的 shopId 是我们发的）",
		z.object({ conversation: str("会话 id") }),
		(p) => messages(p.conversation),
	),

	"mass-records": all("最近的批量上传记录", undefined, () => records()),
	drafts: all("批量上架的草稿池（id 是 unpublished_product_id；imagesPending 时不能发布）", undefined, () => drafts()),
	template: get(
		"下载批量上架的模板（xlsx）存到 --out",
		z.object({ category: num("叶子类目 id：给了是类目模板").optional(), out: str("存到哪个文件") }),
		async (p) => save(await template(p.category), p.out),
	),
	"record-file": get("下载一次批量上传的坏行报告（xlsx）存到 --out", z.object({ record: num("记录 id"), out: str("存到哪个文件") }), async (p) =>
		save(await recordFile(p.record), p.out),
	),
	articles: byPage(
		"帮助中心一个二级分类下的文章",
		z.object({ category: num("帮助中心的二级分类 id（不是商品类目）：卖家中心 /edu/category?sub_cat_id= 里的，例 43；一级分类回空") }),
		async (p, n) => {
			const r = await articles(p.category, n, 50);
			return { rows: r.rows, more: (n + 1) * 50 < r.total };
		},
		0,
	),
	article: get("帮助中心的一篇文章（content 是 HTML）", z.object({ id: str("文章 id") }), (p) => article(p.id)),

	raw: get(
		"逃生口：GET 卖家中心的任一接口，回原样的 JSON（只 GET：POST 可能是写）",
		z.object({
			path: str("接口路径，例 /api/v3/general/get_shop_info/"),
			query: z
				.preprocess(parseJson, z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])))
				.default({})
				.describe("查询参数，JSON 对象"),
		}),
		(p) => seller(p.path, z.unknown(), { method: "GET", query: p.query }),
	),
};

export const shopee = {
	name: "shopee",
	title: "Shopee 卖家中心（台湾站）",
	kind: "site",
	tools,
	site: {
		key: "shopee",
		title: "Shopee 卖家中心",
		origin: "https://seller.shopee.tw",
		hosts: (h) => h === "seller.shopee.tw",
		login: {
			identify: async () => {
				const s = await shop();
				return { id: s.shopId, name: s.username };
			},
			each: { flag: "shop" },
		},
	},
	scope: {
		flag: "shop",
		description: "在登录着这家店的浏览器里读（账号名，例 ni1206；也可以给店铺 id）；只有一个浏览器登录着 Shopee 时不用给",
		run: (shop, fn) => inAccount("shopee", shop, fn),
	},
} satisfies Toolkit;
