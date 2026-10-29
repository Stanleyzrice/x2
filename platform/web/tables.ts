// 网页（x2 web）上的表：每个 skill 在自己的 tables.ts 里声明它的表（toolkit 的 tables），平台的写入表在这里。库里哪些表、哪些列给人看（中文名、顺序），怎么看（筛选、排序、分组、卡片），人能改哪几格。
// 人能改的只有人定的那几格（AGENTS.md「不许做的」）；别的由 x2 写。值的类型从库里读（information_schema），界面照类型显示、照类型收。
// where、order、when 是这里写死的 SQL 片段，不来自网页

import type { Sql } from "../db/index.ts";
import { toolkits } from "../tool.ts";

export type Edit = { options?: readonly string[]; when?: string; set?: (sql: Sql, key: Key, value: unknown) => Promise<void> };
export type View = { title: string; where?: string; order: string; group?: { col: string; values?: readonly string[] }; cards?: boolean; empty?: string };
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

export type Meta = {
	name: string;
	title: string;
	key: string[];
	views: View[];
	columns: { name: string; label: string; type: ColumnType; edit?: { options?: readonly string[] } }[];
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
	views: [{ title: "全部", order: "id desc" }],
};

export const tables = (): Table[] => [...toolkits().flatMap((k) => k.tables ?? []), WRITES];
