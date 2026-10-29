// markdown 的参数：一段话
import { z } from "zod";

export const description = "一段话（Markdown，可以有标题、列表、表格、链接）：结论、说明、要人知道的";
export const props = z.strictObject({ text: z.string().min(1) });
export type Props = z.infer<typeof props>;
export const examples: z.input<typeof props>[] = [{ text: "## 今天\n- 待出货 **3** 单，都备好了货源\n- [卖家中心](https://seller.shopee.tw)" }];
