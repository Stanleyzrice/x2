// page 的声明：agent 写一份 JSON，x2 渲染成网页（先例 Vercel 的 json-render：组件目录当护栏；MCP 的 elicitation）。
// 组件只取需求用得上的最大公约数：文字、图片、表格（格可以是输入框、下拉；行可以勾选）、输入框、选项、规格选择。
// 加组件的规矩：已有的组件表达不了的需求才加；加的是一个标准的界面模式（例 规格选择 = 电商商品页的 SKU picker），不认识具体站点，不为某一页专做。
// 加一个组件改两处：这里的格式，web/render.js 的画法
// 校验不过的声明不渲染，错误原样交回 agent，它自己改
import { z } from "zod";

export const Input = z.discriminatedUnion("type", [
	z.object({ type: z.literal("text"), placeholder: z.string().optional() }),
	z.object({ type: z.literal("url"), placeholder: z.string().optional() }),
	z.object({ type: z.literal("number") }),
	z.object({ type: z.literal("select"), options: z.array(z.object({ value: z.string(), label: z.string() })) }),
]);

const Column = z.object({
	key: z.string(),
	label: z.string(),
	/** image：这一列的值是图片地址；link：值是链接 */
	show: z.enum(["text", "image", "link"]).optional(),
	/** 有 input 的列是人填的：答案里这一列是人填的值 */
	input: Input.optional(),
});

export const Block = z.discriminatedUnion("type", [
	z.object({ type: z.literal("heading"), text: z.string() }),
	z.object({ type: z.literal("text"), text: z.string() }),
	z.object({ type: z.literal("image"), src: z.string(), caption: z.string().optional() }),
	z.object({
		type: z.literal("table"),
		id: z.string().optional().describe("有 id 的表格进答案：每一行连同人填的格，select 时带 _selected"),
		columns: z.array(Column),
		rows: z.array(z.record(z.string(), z.unknown())).optional(),
		from: z.string().optional().describe("数据从哪个 x2 命令来（例 buy todo），show 时现跑它的 --json；和 rows 二选一"),
		select: z.boolean().optional().describe("每一行前面一个勾选框"),
	}),
	z.object({ type: z.literal("input"), id: z.string(), label: z.string(), input: Input, value: z.union([z.string(), z.number()]).optional() }),
	z.object({
		type: z.literal("choice"),
		id: z.string(),
		label: z.string(),
		multiple: z.boolean().optional(),
		options: z.array(z.object({ value: z.string(), label: z.string(), image: z.string().optional(), note: z.string().optional() })),
	}),
	z.object({
		type: z.literal("variants"),
		id: z.string().describe("答案是 { 行的 key: 选中的 option 的 value 或 null }"),
		attrs: z.array(z.object({ name: z.string(), values: z.array(z.object({ name: z.string(), image: z.string().optional() })) }))
			.describe("规格的属性（例 颜色、尺寸）；有图的取值画成图块，没图的画成按钮"),
		options: z.array(z.object({ value: z.string(), attrs: z.array(z.string()), label: z.string(), image: z.string().optional(), note: z.string().optional() }))
			.describe("每个规格：attrs 是各属性的取值，顺序同 attrs"),
		rows: z.array(z.object({ key: z.string(), label: z.string(), image: z.string().optional(), note: z.string().optional(), value: z.string().optional() }))
			.describe("每一行要选一个规格（例 店里的一个规格）；value 是预选的 option"),
	}).describe("规格选择（先例 电商商品页的规格选择：颜色用图块、尺寸用按钮）：每一行选一个规格，行的图和选中规格的图并排"),
]);

export const Page = z.object({
	title: z.string(),
	blocks: z.array(Block),
	/** 有 submit 的是 ask：人按了提交或取消，答案交回 agent；没有的是 show：只展示 */
	submit: z.object({ label: z.string(), cancel: z.string().optional() }).optional(),
});
export type Page = z.infer<typeof Page>;

/** 人提交的答案：values 按块的 id；按了取消时 submitted 是 false */
export type Answer = { submitted: boolean; values: Record<string, unknown> };
