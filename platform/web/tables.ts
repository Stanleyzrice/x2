// 网页（x2 web）上的表：每个业务工具在自己的 tables.ts 里声明它的表（toolkit 的 tables），平台的写入表在这里。库里哪些表、哪些列给人看（中文名、顺序）、算出来的列、图和链接的列，人能改哪几格，表单。
// 怎么看（要哪些行、哪几列、怎么排、分组、表格还是卡片）不写在这里：agent 在 datagrid 的参数里拼（platform/web/grid.ts）。
// 人能改的只有人定的那几格（AGENTS.md「不许做的」）；别的由 x2 写。值的类型从库里读（information_schema），界面照类型显示、照类型收。
// when（这一行现在能不能改这一格）是这里写死的 SQL 片段：业务规则和安全线，agent、网页都放不开

import type { Sql } from "../db/index.ts";
import { toolkits } from "../tool.ts";

export type Edit = { options?: readonly string[]; when?: string; set?: (sql: Sql, key: Key, value: unknown) => Promise<void> };
export type Form = {
	title: string;
	fields: Record<string, string>;
	required: string[];
	options?: Record<string, (sql: Sql) => Promise<string[]>>;
	insert?: (sql: Sql, values: Record<string, string>) => Promise<string>;
};
export type Table = {
	name: string;
	title: string;
	key: string[];
	columns: Record<string, string>;
	/** 算出来的列：of 拿到的是这张表库里的一行（照这张表的列；业务工具按自己的行的类型写，server.ts 原样传给它） */
	computed?: Record<string, { type: ColumnType; of: (row: never) => unknown }>;
	images?: string[];
	links?: string[];
	edit?: Record<string, Edit>;
	/** 一列的值的先后（例 当前步骤照流程排）：网页按这一列分组时，agent 没给 values 就照它 */
	order?: Record<string, readonly string[]>;
	recheck?: (sql: Sql, key: Key) => Promise<unknown>;
	form?: Form;
};
export type Row = Record<string, unknown>;
/** 给网页的一行：主键（_key）、这一行现在不能改的列（_readonly），和给人看的列 */
export type Shown = Row & { _key: Key; _readonly: string[] };
export type Key = Record<string, string>;
export type ColumnType = "bool" | "number" | "time" | "text" | "json" | "image" | "link" | "pics" | "grid";

/** 一格里的小表格（例 商品稿的规格和价格）：业务工具把自己的数据转成它，网页照通用的画。表格里一格只显示 summary，展开是 caption、表、note */
export type Grid = {
	summary: string;
	caption: string;
	columns: { label: string; numeric?: boolean }[];
	/** 每行带图时，图那一列的表头 */
	imageLabel?: string;
	rows: { key: string; image: string | null; cells: string[] }[];
	note: string | null;
};

export type Meta = {
	name: string;
	title: string;
	key: string[];
	columns: { name: string; label: string; type: ColumnType; edit?: { options?: readonly string[] }; order?: readonly string[] }[];
	form?: { title: string; fields: { name: string; label: string; hint: string; type: ColumnType; required: boolean; options?: readonly string[] }[] };
};

export type Pic = { id: string; url: string; label: string; role: "main" | "detail" | "option"; state: "used" | "removed" | "dropped" | "extra"; why?: string };

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
	edit: { status: { options: ["已核对", "被拒"], when: "status in ('结果未知', '不一致')" } },
};

export const tables = (): Table[] => [...toolkits().flatMap((k) => k.tables ?? []), WRITES];
