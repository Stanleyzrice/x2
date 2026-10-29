// choice 的参数：让人做一个选择。agent 给问题和几个选项（可以带图、说明、链接），单选或多选，可以请人写一句理由；人选的存进库（page_items 的 answer），x2 page show 读得到
import { z } from "zod";
import { title } from "../../props.ts";

const option = z.object({
	label: z.string().trim().min(1).max(80).describe("选项（一页里不重复，答案记的就是它）"),
	description: z.string().trim().min(1).optional().describe("一句说明"),
	image: z.url().optional(),
	link: z.url().optional().describe("点了打开的链接（例 货源、竞品）"),
});

export const description =
	"让人做一个选择：一个问题、几个选项（可以带图、说明、链接），单选或多选，可以请人写一句理由。人选了存进库，x2 page show 看答案和选的时间";
export const props = z.object({
	title,
	question: z.string().trim().min(1),
	options: z
		.array(option)
		.min(2)
		.max(12)
		.refine((o) => new Set(o.map((x) => x.label)).size === o.length, { message: "选项的 label 不能重复" }),
	multiple: z.boolean().default(false).describe("可以选几个"),
	reason: z.boolean().default(false).describe("请人写一句理由（可以不写）"),
});
export type Props = z.infer<typeof props>;

/** 人的答案：选了哪几个（label）、理由。照这一个组件的参数查：只认它的选项，单选只能一个 */
export const answer = (p: Props) =>
	z
		.object({
			picked: z
				.array(z.enum(p.options.map((o) => o.label) as [string, ...string[]]))
				.min(1, "要选一个")
				.refine((x) => new Set(x).size === x.length, "选重了")
				.refine((x) => p.multiple || x.length === 1, "只能选一个"),
			reason: z.string().trim().max(500).optional(),
		})
		.strict()
		.transform(({ picked, reason }) => (p.reason && reason ? { picked, reason } : { picked }));
export type Answer = z.infer<ReturnType<typeof answer>>;

export const examples: z.input<typeof props>[] = [
	{
		question: "这个规格用哪个货源？",
		options: [
			{ label: "A 店 ¥8.5", description: "起批 2 件，48 小时发货", link: "https://detail.1688.com/offer/1.html" },
			{ label: "B 店 ¥7.9", description: "起批 10 件" },
		],
		reason: true,
	},
];
