// 网页的服务（x2 web）：照 tables.ts 读写库，发打好的界面（platform/ui/dist）。只读写库，不碰站点。
// GET /api/meta：每张表的列（类型从库里读）、视图、表单；GET /api/rows?table=&view=&filter=：一个视图的行（filter 是 JSON，只认 sessions.ts 的 filterable 的列）；
// PATCH /api/rows { table, key, col, value }：人改一格（只收 tables.ts 里人能改的）；POST /api/rows { table, values }：表单添一行；
// GET /api/sessions：会话列表；GET /api/session?id=：一个会话和它的组件；DELETE /api/session?id=：删会话；DELETE /api/session/item?id=：关掉右边的一个 tab

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { z } from "zod";
import type { Sql } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { closeItem, deleteSession, filterable, listSessions, showSession } from "./sessions.ts";
import { type ColumnType, type Key, type Meta, type Row, TABLES, type Table } from "./tables.ts";

/** 一个视图最多给几行 */
const LIMIT = 1000;
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".png": "image/png",
};

/** 库里的类型 → 网页的类型 */
function typeOf(dataType: string): ColumnType {
	if (dataType === "boolean") return "bool";
	if (/int|numeric|double|real/.test(dataType)) return "number";
	if (/timestamp|date/.test(dataType)) return "time";
	if (/json/.test(dataType)) return "json";
	return "text";
}

/** 每张表每一列的类型：库里的，图、链接、算出来的照 tables.ts */
async function types(sql: Sql): Promise<Map<string, Map<string, ColumnType>>> {
	const rows = await sql`select table_name, column_name, data_type from information_schema.columns where table_schema = current_schema()`;
	const out = new Map<string, Map<string, ColumnType>>();
	for (const t of TABLES) {
		const cols = new Map(rows.filter((r) => r.table_name === t.name).map((r) => [r.column_name as string, typeOf(r.data_type)]));
		for (const c of t.images ?? []) cols.set(c, "image");
		for (const c of t.links ?? []) cols.set(c, "link");
		for (const [c, x] of Object.entries(t.computed ?? {})) cols.set(c, x.type);
		out.set(t.name, cols);
	}
	return out;
}

/** 人填的一格 → 存进库的值（照类型；空的是 null） */
function cellValue(type: ColumnType, options: readonly string[] | undefined, v: unknown): unknown {
	const schema = options
		? z.enum(options as [string, ...string[]]).nullable()
		: type === "bool"
			? z.boolean()
			: type === "number"
				? z.number().nullable()
				: z
						.string()
						.nullable()
						.transform((s) => (s?.trim() ? s : null));
	const r = schema.safeParse(v === "" ? null : v);
	if (!r.success) throw new Usage(`值不对：${JSON.stringify(v)}`);
	if (type === "time" && r.data && Number.isNaN(Date.parse(String(r.data)))) throw new Usage(`不是时间：${r.data}`);
	return r.data;
}

/** 有条件才能改的列（tables.ts 的 when） */
const guarded = (t: Table) =>
	Object.entries(t.edit ?? {})
		.filter(([, e]) => e.when)
		.map(([c, e]) => [c, e.when!] as const);

/** 一行给网页的样子：给人看的列、算出来的列；_key 是主键，_readonly 是这一行现在不能改的列 */
function shape(t: Table, cols: Map<string, ColumnType>, row: Row): Row {
	const out: Row = {
		_key: Object.fromEntries(t.key.map((k) => [k, String(row[k])])),
		_readonly: guarded(t)
			.filter(([c]) => !row[`_can_${c}`])
			.map(([c]) => c),
	};
	for (const c of Object.keys(t.columns)) {
		const computed = t.computed?.[c];
		const v = computed ? computed.of(row) : row[c];
		out[c] = cols.get(c) === "number" && v !== null && v !== undefined ? Number(v) : v;
	}
	return out;
}

/** 开服务：回地址和关掉它的函数（port 0 是随便一个空着的口） */
export async function serve(
	sql: Sql,
	{ host, port, dist }: { host: string; port: number; dist: string },
): Promise<{ port: number; stop: () => Promise<void> }> {
	const colTypes = await types(sql);
	const table = (name: unknown) => {
		const t = TABLES.find((x) => x.name === name);
		if (!t) throw new Usage(`没有表 ${String(name)}`);
		return t;
	};
	const where = (t: Table, key: Key) => {
		if (!key || t.key.some((k) => typeof key[k] !== "string")) throw new Usage(`${t.title}：要主键 ${t.key.join("、")}`);
		return t.key.map((k) => sql`${sql(k)} = ${key[k]!}`).reduce((a, b) => sql`${a} and ${b}`);
	};
	// 每一列，加上有条件的列这一行能不能改（_can_列名）
	const select = (t: Table) =>
		sql`select *${sql.unsafe(
			guarded(t)
				.map(([c, when]) => `, (${when}) as "_can_${c}"`)
				.join(""),
		)} from ${sql(t.name)}`;
	const one = async (t: Table, key: Key) => {
		const [row] = await sql`${select(t)} where ${where(t, key)}`;
		return row ? shape(t, colTypes.get(t.name)!, row) : null;
	};

	const api: Record<string, (body: any, url: URL) => Promise<unknown>> = {
		"GET /api/meta": async () =>
			Promise.all(
				TABLES.map(async (t): Promise<Meta> => {
					const cols = colTypes.get(t.name)!;
					return {
						name: t.name,
						title: t.title,
						key: t.key,
						views: t.views,
						columns: Object.entries(t.columns).map(([name, label]) => ({
							name,
							label,
							type: cols.get(name) ?? "text",
							...(t.edit?.[name] ? { edit: { options: t.edit[name].options } } : {}),
						})),
						...(t.form
							? {
									form: {
										title: t.form.title,
										fields: await Promise.all(
											Object.entries(t.form.fields).map(async ([name, hint]) => ({
												name,
												label: t.columns[name] ?? name,
												hint,
												type: cols.get(name) ?? "text",
												required: t.form!.required.includes(name),
												options: (await t.form!.options?.[name]?.(sql)) ?? t.edit?.[name]?.options,
											})),
										),
									},
								}
							: {}),
					};
				}),
			),

		"GET /api/rows": async (_, url) => {
			const t = table(url.searchParams.get("table"));
			const v = t.views.find((x) => x.title === url.searchParams.get("view")) ?? t.views[0]!;
			// 按列筛（会话里的 datagrid 引用的）：只认能筛的列，值都当文字比
			let filter: Record<string, string | string[]> = {};
			try {
				filter = JSON.parse(url.searchParams.get("filter") ?? "{}");
			} catch {
				throw new Usage("filter 要是 JSON");
			}
			const can = filterable(t.name);
			const conds = [
				...(v.where ? [sql`(${sql.unsafe(v.where)})`] : []),
				...Object.entries(filter).map(([c, x]) => {
					if (!can.has(c)) throw new Usage(`${t.title}不能按「${c}」筛`);
					return sql`${sql(c)}::text in ${sql((Array.isArray(x) ? x : [x]).map(String))}`;
				}),
			];
			const where = conds.length ? sql`where ${conds.reduce((a, b) => sql`${a} and ${b}`)}` : sql``;
			const rows = await sql`${select(t)} ${where} order by ${sql.unsafe(v.order)} limit ${LIMIT}`;
			return rows.map((r) => shape(t, colTypes.get(t.name)!, r));
		},

		"GET /api/sessions": async () => listSessions(sql),
		"GET /api/session": async (_, url) => showSession(sql, url.searchParams.get("id") ?? ""),
		"DELETE /api/session": async (_, url) => {
			await deleteSession(sql, url.searchParams.get("id") ?? "");
			return { ok: true };
		},
		"DELETE /api/session/item": async (_, url) => {
			await closeItem(sql, url.searchParams.get("id") ?? "");
			return { ok: true };
		},

		"PATCH /api/rows": async (b) => {
			const t = table(b?.table);
			const col = String(b?.col);
			const edit = t.edit?.[col];
			if (!edit) throw new Usage(`${t.title}的「${t.columns[col] ?? col}」不是人改的`);
			const key = b.key as Key;
			await t.recheck?.(sql, key);
			if (edit.when) {
				const [ok] = await sql`select 1 from ${sql(t.name)} where ${where(t, key)} and ${sql.unsafe(edit.when)}`;
				if (!ok) throw new Usage(`这一行现在不能改「${t.columns[col]}」`);
			}
			if (edit.set) await edit.set(sql, key, b.value);
			else {
				const value = cellValue(colTypes.get(t.name)!.get(col)!, edit.options, b.value);
				const r = await sql`update ${sql(t.name)} set ${sql({ [col]: value } as Record<string, any>)} where ${where(t, key)} returning 1`;
				if (!r.length) throw new Usage(`${t.title}里没有这一行`);
			}
			await t.recheck?.(sql, key);
			return one(t, key);
		},

		"POST /api/rows": async (b) => {
			const t = table(b?.table);
			const f = t.form;
			if (!f) throw new Usage(`${t.title}不能在网页上添加`);
			const values: Record<string, string> = {};
			for (const name of Object.keys(f.fields)) {
				const v = b.values?.[name];
				if (v === undefined || v === null || String(v).trim() === "") {
					if (f.required.includes(name)) throw new Usage(`要填「${t.columns[name] ?? name}」`);
					continue;
				}
				values[name] = String(v).trim();
			}
			if (f.insert) return { key: await f.insert(sql, values) };
			const cols = colTypes.get(t.name)!;
			const row = Object.fromEntries(Object.entries(values).map(([c, v]) => [c, cellValue(cols.get(c)!, undefined, cols.get(c) === "number" ? Number(v) : v)]));
			const [r] = await sql`insert into ${sql(t.name)} ${sql(row as Record<string, any>)} returning *`;
			return { key: shape(t, cols, r!)._key };
		},
	};

	const send = (res: ServerResponse, status: number, type: string, body: string | Buffer) => {
		res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
		res.end(body);
	};
	const handle = async (req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://x");
		const route = api[`${req.method} ${url.pathname}`];
		if (route) {
			try {
				let raw = "";
				for await (const c of req) raw += c;
				send(res, 200, "application/json", JSON.stringify(await route(raw ? JSON.parse(raw) : null, url)));
			} catch (e) {
				// 用法不对、库里的约束（例 比例在 0–1）：告诉人；别的是 x2 的错
				const told = e instanceof Usage || (e as { code?: string }).code?.startsWith("23") || (e as { code?: string }).code === "22P02";
				if (!told) console.error(e);
				send(res, told ? 400 : 500, "application/json", JSON.stringify({ error: (e as Error).message }));
			}
			return;
		}
		// 界面：打好的文件，别的地址都给 index.html
		const file = normalize(join(dist, url.pathname)).startsWith(dist) && extname(url.pathname) ? join(dist, url.pathname) : join(dist, "index.html");
		try {
			send(res, 200, MIME[extname(file)] ?? "application/octet-stream", await readFile(file));
		} catch {
			send(res, 404, "text/plain", "没有这个文件");
		}
	};

	const server = createServer((req, res) => void handle(req, res));
	await new Promise<void>((ok, fail) => server.once("error", fail).listen(port, host, ok));
	return { port: (server.address() as { port: number }).port, stop: () => new Promise<void>((ok) => server.close(() => ok())) };
}
