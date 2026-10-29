// datagrid 的参数：引用库里的一张表。这里只管形状；表、列对不对，服务端照 tables.ts 查（platform/web/pages.ts）
import { z } from "zod";
import { title } from "../../props.ts";

export const description = "库里的一张表（引用，不是数据）：人看现在的行、改人能改的格（照 tables.ts）。同一页上同一个引用只开一个 tab";
export const props = z.object({
	title,
	table: z.string().describe("表名（每个业务工具的 tables.ts，和写入 writes；不对会说有哪些）"),
	view: z.string().optional().describe("表的视图（tables.ts 的 views 的 title）；不给用第一个"),
	filter: z
		.record(z.string(), z.union([z.string(), z.array(z.string()).min(1)]))
		.optional()
		.describe("按列筛：{ 列名: 值 或 [值…] }，只认这张表给人看的列和主键；例 { id: ['3', '5'] }"),
});
export type Props = z.infer<typeof props>;
export const examples: z.input<typeof props>[] = [{ table: "listings", view: "审稿", filter: { id: ["3", "5"] } }];
