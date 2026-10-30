// datagrid 的参数：引用库里的一张表，agent 拼出要哪些行、哪几列、怎么排、怎么分组、表格还是卡片。这里只管形状；表、列对不对，服务端照 tables.ts 查（platform/web/grid.ts）
import { z } from "zod";
import { title } from "../../props.ts";

export const description =
	"库里的一张表（引用，不是数据）：人看现在的行、改人能改的格（照 tables.ts）。只认这张表给人看的列和主键，不写 SQL；同一页上同一个引用只开一个 tab";
export const props = z.strictObject({
	title,
	table: z.string().describe("表名（每个业务工具的 tables.ts，和写入 writes；不对会说有哪些）"),
	columns: z.array(z.string()).min(1).optional().describe("给人看哪几列、什么顺序；不给是这张表给人看的全部列"),
	filter: z
		.record(z.string(), z.union([z.string(), z.array(z.string()).min(1)]))
		.optional()
		.describe("按列筛：{ 列名: 值 或 [值…] }，几列之间是「而且」；例 { id: ['3', '5'] }"),
	sort: z
		.array(z.strictObject({ col: z.string(), desc: z.boolean().optional() }))
		.min(1)
		.optional()
		.describe("怎么排：[{ col, desc? }]，前面的先排，空的排最后；不给按主键排"),
	group: z
		.object({ col: z.string(), values: z.array(z.string()).min(1).optional().describe("组的先后；不给照值在行里先出现的先后") })
		.optional()
		.describe("按一列分组"),
	layout: z.enum(["table", "cards"]).default("table").describe("table：表格，点一行在右边看整行、改格；cards：一行一张卡片，格都摊开（要人逐份看、逐份改时）"),
});
export type Props = z.infer<typeof props>;
export const examples: z.input<typeof props>[] = [
	{ title: "审稿", table: "listings", filter: { step: ["待批准", "待补充"] }, sort: [{ col: "id" }], layout: "cards" },
	{
		table: "sources",
		filter: { item_id: ["123"] },
		sort: [
			{ col: "chosen", desc: true },
			{ col: "score", desc: true },
		],
		group: { col: "item_name" },
	},
];
