// images 的参数：一组图
import { z } from "zod";
import { title } from "../../props.ts";

export const description = "一组图（商品图、货源图、竞品图），可以带说明、点了打开的链接";
export const props = z.object({
	title,
	images: z.array(z.object({ url: z.url(), caption: z.string().optional(), link: z.url().optional() })).min(1),
});
export type Props = z.infer<typeof props>;
export const examples: z.input<typeof props>[] = [
	{ images: [{ url: "https://cbu01.alicdn.com/img/ibank/O1CN01example.jpg", caption: "1688 主图", link: "https://detail.1688.com/offer/1.html" }] },
];
