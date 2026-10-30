// datagrid 的引用怎么变成查询：agent 在 props 里写 table、columns、filter、sort、group（结构化的，只认 tables.ts 里给人看的列和主键），不写 SQL。
// 这里查引用对不对、拼成一句 SQL：纯函数，不碰库。值都走参数（$1…）；列名只取 tables.ts 里声明过的，再加双引号；when 是 tables.ts 写死的 SQL 片段。
// 算出来的列（computed）在 JS 里算，不能拿来筛、排、分组，只能给人看
import type { Props as Ref } from "../ui/interactable/datagrid/schema.ts";
import type { Table } from "./tables.ts";

export type { Ref };

/** 能筛、能排、能分组的列：主键和给人看的列里不是算出来的 */
export const queryable = (t: Table): Set<string> => new Set([...t.key, ...Object.keys(t.columns).filter((c) => !t.computed?.[c])]);

/** 引用哪里不对，一格一句；没有错回空的 */
export function checkRef(all: readonly Table[], ref: Ref): string[] {
	const t = all.find((x) => x.name === ref.table);
	if (!t) return [`table：没有表 ${ref.table}（有：${all.map((x) => x.name).join("、")}）`];
	const can = queryable(t);
	const canList = [...can].join("、");
	const bad: string[] = [];
	for (const c of ref.columns ?? []) if (!(c in t.columns)) bad.push(`columns：${t.title}没有给人看的列「${c}」（有：${Object.keys(t.columns).join("、")}）`);
	for (const c of Object.keys(ref.filter ?? {})) if (!can.has(c)) bad.push(`filter.${c}：${t.title}不能按「${c}」筛（能：${canList}）`);
	for (const s of ref.sort ?? []) if (!can.has(s.col)) bad.push(`sort：${t.title}不能按「${s.col}」排（能：${canList}）`);
	if (ref.group && !can.has(ref.group.col)) bad.push(`group：${t.title}不能按「${ref.group.col}」分组（能：${canList}）`);
	return bad;
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** 一个（查过的）引用拼成一句 SQL：现在的行，加上每个有 when 的人能改的格这一行能不能改（_can_<列>）。不给 sort 按主键排 */
export function refQuery(t: Table, ref: Ref, limit: number): { text: string; values: string[] } {
	const values: string[] = [];
	const guards = Object.entries(t.edit ?? {})
		.filter(([, e]) => e.when)
		.map(([c, e]) => `, (${e.when}) as ${ident(`_can_${c}`)}`)
		.join("");
	const where = Object.entries(ref.filter ?? {}).map(([c, v]) => {
		const list = Array.isArray(v) ? v : [v];
		const at = list.map((x) => {
			values.push(x);
			return `$${values.length}`;
		});
		return `${ident(c)}::text in (${at.join(", ")})`;
	});
	const sort = ref.sort?.length ? ref.sort : t.key.map((col) => ({ col, desc: false }));
	const order = sort.map((s) => `${ident(s.col)} ${s.desc ? "desc" : "asc"} nulls last`);
	return {
		text: `select *${guards} from ${ident(t.name)}${where.length ? ` where ${where.join(" and ")}` : ""} order by ${order.join(", ")} limit ${limit}`,
		values,
	};
}
