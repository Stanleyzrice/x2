// table 的参数：一张小表，数据在组件里
import { z } from "zod";
import { title } from "../../props.ts";

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const description = "一张小表（数据在组件里，几十行以内）：对比、清单。要人改、要现读库里的用 datagrid";
export const props = z
	.object({ title, columns: z.array(z.string().min(1)).min(1), rows: z.array(z.array(cell)) })
	.refine((p) => p.rows.every((r) => r.length === p.columns.length), { message: "每一行的格数要和 columns 一样多", path: ["rows"] });
export type Props = z.infer<typeof props>;
export const examples: z.input<typeof props>[] = [
	{
		title: "两家店这周",
		columns: ["店", "订单", "退货"],
		rows: [
			["ni1206", 42, 1],
			["cheeroutdoor", 17, 0],
		],
	},
];
