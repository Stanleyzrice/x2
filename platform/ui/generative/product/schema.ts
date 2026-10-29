// product 的参数：几张商品卡（比竞品、比货源、看一份商品稿的图），数据在组件里
import { z } from "zod";
import { title } from "../../props.ts";

const price = z
	.object({
		min: z.number().nonnegative(),
		max: z.number().nonnegative().optional().describe("区间的上限；只有一个价不给"),
		currency: z.enum(["TWD", "CNY"]).describe("TWD 写成 NT$，CNY 写成 ¥"),
	})
	.refine((p) => p.max === undefined || p.max >= p.min, { message: "max 要不小于 min", path: ["max"] });

const product = z.object({
	name: z.string().trim().min(1).describe("标题"),
	images: z.array(z.url()).min(1).max(20).describe("图，第一张是封面，多张左右翻"),
	price: price.optional(),
	sold30d: z.number().int().nonnegative().optional().describe("30 天销量"),
	rating: z.number().min(0).max(5).optional().describe("评分（0 到 5）"),
	shop: z.string().min(1).optional().describe("店名"),
	link: z.url().optional().describe("点标题打开的链接"),
	tags: z.array(z.string().trim().min(1).max(12)).max(6).optional().describe("几个短标签，例 本地、跨境、1688、Shopee"),
});

export const description =
	"几张商品卡：图（多张左右翻）、标题、价格（区间）、30 天销量、评分、店名、链接、标签。比竞品、比货源放一个组件里几张卡；只看图（一份商品稿的主图、详情图）也用它，一张卡放几张图";
export const props = z.object({ title, products: z.array(product).min(1).max(24) });
export type Props = z.infer<typeof props>;
export const examples: z.input<typeof props>[] = [
	{
		title: "竞品和货源",
		products: [
			{
				name: "旅行收納袋 五件組",
				images: ["https://down-tw.img.susercontent.com/file/tw-11134207-example"],
				price: { min: 199, max: 259, currency: "TWD" },
				sold30d: 1200,
				rating: 4.9,
				shop: "某某生活館",
				link: "https://shopee.tw/product/1/2",
				tags: ["本地", "Shopee"],
			},
			{
				name: "旅行收纳袋五件套",
				images: ["https://cbu01.alicdn.com/img/ibank/O1CN01example.jpg"],
				price: { min: 8.5, currency: "CNY" },
				link: "https://detail.1688.com/offer/1.html",
				tags: ["1688"],
			},
		],
	},
];
