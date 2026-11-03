// 逐行选择表：图片、链接和说明跟着同一行；答案以稳定行编号保存，没选的保持待选择。
import { z } from "zod";
import { title } from "../../props.ts";

const url = z.url({ protocol: /^https?$/ });
const row = z.strictObject({
	id: z.string().trim().min(1).max(120).describe("稳定行编号，不用会变的排序号"),
	code: z.string().trim().min(1).max(40).optional().describe("显示的短编号"),
	name: z.string().trim().min(1).max(300),
	image: url.nullable().optional(),
	link: url.nullable().optional().describe("缺失时显示暂定，不猜链接"),
	linkText: z.string().trim().min(1).max(100).optional(),
	description: z.string().trim().max(1200).optional(),
	tags: z.array(z.string().trim().min(1).max(40)).max(4).default([]),
	cells: z
		.array(z.union([z.string(), z.number(), z.null()]))
		.max(8)
		.default([]),
});

export const description =
	"带图片和链接的逐行选择表。每行两个可改标签的选择按钮，点击自动保存；支持搜索、按决定筛选、撤回选择。没有链接显示暂定，答案按行合并，不覆盖其他行。";
export const props = z
	.strictObject({
		title,
		question: z.string().trim().max(1200).optional(),
		positiveLabel: z.string().trim().min(1).max(20).default("选用"),
		negativeLabel: z.string().trim().min(1).max(20).default("不选"),
		linkLabel: z.string().trim().min(1).max(40).default("查看链接"),
		columns: z.array(z.string().trim().min(1).max(50)).max(8).default([]),
		rows: z.array(row).min(1).max(500),
	})
	.refine((p) => new Set(p.rows.map((r) => r.id)).size === p.rows.length, "行编号不能重复")
	.refine((p) => p.rows.every((r) => r.cells.length === p.columns.length), "每行的列数需与columns一致")
	.refine((p) => new Set(p.columns).size === p.columns.length, "列名不能重复");
export type Props = z.infer<typeof props>;

export const decision = z.enum(["yes", "no", "pending"]);
export type Decision = z.infer<typeof decision>;
export const answerMode = "merge";
export const answer = (p: Props) =>
	z.partialRecord(z.enum(p.rows.map((r) => r.id) as [string, ...string[]]), decision).refine((a) => Object.keys(a).length > 0, "至少选择一行");
export type Answer = z.infer<ReturnType<typeof answer>>;

export const examples: z.input<typeof props>[] = [
	{
		title: "商品选择",
		positiveLabel: "上",
		negativeLabel: "不上",
		columns: ["计划价格"],
		rows: [
			{ id: "cup", code: "P001", name: "带盖水杯", link: "https://example.com/cup", cells: ["NT$199"] },
			{ id: "bag", code: "P002", name: "旅行收纳袋", link: null, cells: ["NT$159"] },
		],
	},
];
