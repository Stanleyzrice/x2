// chart 的参数：一张图
import { z } from "zod";
import { title } from "../../props.ts";

export const description = "一张图：bar 比大小，line、area 看变化，pie 看占比。data 一行一个点，x 是横轴的列，y 是画的列（最多 8 个）";
export const props = z
	.object({
		title,
		type: z.enum(["bar", "line", "area", "pie"]),
		data: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))).min(1),
		x: z.string(),
		y: z.array(z.string()).min(1).max(8),
	})
	.refine((p) => p.data.some((r) => p.x in r), { message: "data 里没有 x 这一列", path: ["x"] })
	.refine((p) => p.type !== "pie" || p.y.length === 1, { message: "pie 只画一列", path: ["y"] })
	.refine((p) => p.type !== "pie" || p.data.length <= 8, { message: "pie 最多 8 块（颜色不循环）：小的并进「其他」", path: ["data"] });
export type Props = z.infer<typeof props>;
export const examples: z.input<typeof props>[] = [
	{
		title: "每天的订单",
		type: "line",
		data: [
			{ 日期: "10-27", ni1206: 6, cheeroutdoor: 2 },
			{ 日期: "10-28", ni1206: 9, cheeroutdoor: 3 },
		],
		x: "日期",
		y: ["ni1206", "cheeroutdoor"],
	},
];
