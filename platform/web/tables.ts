// 网页（x2 web）上的表：每个 skill 在自己的 tables.ts 里声明它的表（toolkit 的 tables），平台的写入表在这里。库里哪些表、哪些列给人看（中文名、顺序），怎么看（筛选、排序、分组、卡片），人能改哪几格。
// 人能改的只有人定的那几格（AGENTS.md「不许做的」）；别的由 x2 写。值的类型从库里读（information_schema），界面照类型显示、照类型收。
// where、order、when 是这里写死的 SQL 片段，不来自网页

import type { Sql } from "../db/index.ts";
import { toolkits } from "../tool.ts";

/** 人能改的一格：options 是可选的值；when 是这一行能改的条件（例 结果未知的写入才能改状态）；set 不是改一列（例 删图） */
export type Edit = { options?: readonly string[]; when?: string; set?: (sql: Sql, key: Key, value: unknown) => Promise<void> };
/** 一个视图：where 筛选，order 排序，group 按这一列分组（values 是组的顺序），cards 一行一张卡片（不给是表格），empty 是空的时候说的话 */
export type View = { title: string; where?: string; order: string; group?: { col: string; values?: readonly string[] }; cards?: boolean; empty?: string };
/** 人填一行新的：fields 是列和它的说明，insert 不是直接插一行（例 添加货源） */
export type Form = {
	title: string;
	fields: Record<string, string>;
	required: string[];
	options?: Record<string, (sql: Sql) => Promise<string[]>>;
	insert?: (sql: Sql, values: Record<string, string>) => Promise<string>;
};
/** 一张表：key 是主键的列；columns 是给人看的列 → 中文名（也是顺序），computed 是算出来的列（库里没有）；images、links 显示成图、链接；
 * edit 是人能改的；recheck 是人改之前、改之后 x2 马上重算这一行（例 商品稿的当前步骤） */
export type Table = {
	name: string;
	title: string;
	key: string[];
	columns: Record<string, string>;
	views: View[];
	computed?: Record<string, { type: ColumnType; of: (row: Row) => unknown }>;
	images?: string[];
	links?: string[];
	edit?: Record<string, Edit>;
	recheck?: (sql: Sql, key: Key) => Promise<unknown>;
	form?: Form;
};
export type Row = Record<string, any>;
export type Key = Record<string, string>;
export type ColumnType = "bool" | "number" | "time" | "text" | "json" | "image" | "link" | "pics" | "specs";

/** 给网页的：一张表的列（类型、能不能改、可选的值）、视图、表单 */
export type Meta = {
	name: string;
	title: string;
	key: string[];
	views: View[];
	columns: { name: string; label: string; type: ColumnType; edit?: { options?: readonly string[] } }[];
	form?: { title: string; fields: { name: string; label: string; hint: string; type: ColumnType; required: boolean; options?: readonly string[] }[] };
};

/** 商品稿的图（算出来的「图」，界面照它画）：主图、详情图（号和 x2 listing keep 认的一样）、规格图；state：用的、人删了的、x2 去掉的（drop 写着原因）、超出张数的 */
export type Pic = { id: string; url: string; label: string; role: "main" | "detail" | "option"; state: "used" | "removed" | "dropped" | "extra"; why?: string };

/** 写入：结果未知、不一致的，人到站点上看过改成已核对（做成了）或被拒（没做成） */
const WRITES: Table = {
	name: "writes",
	title: "写入",
	key: ["id"],
	columns: {
		id: "编号",
		batch: "批次",
		op: "操作",
		display: "内容",
		status: "状态",
		error: "原因",
		host: "执行电脑",
		created_at: "准备时间",
		finished_at: "结束时间",
		cost: "费用",
	},
	// 结果未知、不一致的：人到站点上看过，改成已核对（做成了）或被拒（没做成）
	edit: { status: { options: ["已核对", "被拒"], when: "status in ('结果未知', '不一致')" } },
	views: [{ title: "全部", order: "id desc" }],
};

/** 全部的表：注册了的 skill 的，加写入 */
export const tables = (): Table[] => [...toolkits().flatMap((k) => k.tables ?? []), WRITES];
