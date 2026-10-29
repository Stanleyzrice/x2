// stats 的参数：一排关键数字
import { z } from "zod";
import { title } from "../../props.ts";

export const description = "一排关键数字（最多 8 个）：数、说明；hint 是一句补充（例 和上周比、截至哪天）";
export const props = z.object({
	title,
	items: z
		.array(z.object({ label: z.string().min(1), value: z.union([z.string(), z.number()]), hint: z.string().optional() }))
		.min(1)
		.max(8),
});
export type Props = z.infer<typeof props>;
export const examples: z.input<typeof props>[] = [{ items: [{ label: "待出货", value: 12, hint: "截至今天 9 点" }] }];
