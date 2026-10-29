// 网页的服务（x2 web）：照 tables.ts 读写库，发打好的界面（platform/ui/dist）。
// 碰站点只有一条路：组件在 schema.ts 里声明网页能替它调哪几个工具（actions，例 chat 读聊聊、写回复草稿），这里经注册表（platform/tool.ts 的 invoke）调；platform 仍然不 import connectors、tools，只认工具的 id。只调读工具
// GET /api/meta：每张表的列（类型从库里读）、表单；GET /api/rows?ref=：一个 datagrid 引用的行（ref 是它的 props 的 JSON，照组件的校验查过、grid.ts 拼成 SQL，只给要的列）；
// PATCH /api/rows { table, key, col, value }：人改一格（只收 tables.ts 里人能改的）；POST /api/rows { table, values }：表单添一行；
// GET /api/pages：页列表；GET /api/page?id=：一页和它的组件；DELETE /api/page?id=：删页；DELETE /api/page/item?id=：关掉右边的一个 tab；POST /api/page/answer { item, answer }：人在组件上回答（例 choice 选了），照组件的 answer 查；
// POST /api/page/act { item, action, input }：替组件调它声明的工具

import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { z } from "zod";
import type { Sql } from "../db/index.ts";
import { NeedsHuman, Usage } from "../errors.ts";
import { type Ref, refQuery } from "./grid.ts";
import { act, answer, closeItem, deletePage, listPages, parseProps, showPage } from "./pages.ts";
import { type ColumnType, type Key, type Meta, type Row, type Table, tables } from "./tables.ts";

const LIMIT = 1000;
const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".png": "image/png",
};

function typeOf(dataType: string): ColumnType {
	if (dataType === "boolean") return "bool";
	if (/int|numeric|double|real/.test(dataType)) return "number";
	if (/timestamp|date/.test(dataType)) return "time";
	if (/json/.test(dataType)) return "json";
	return "text";
}

async function types(sql: Sql): Promise<Map<string, Map<string, ColumnType>>> {
	const rows = await sql`select table_name, column_name, data_type from information_schema.columns where table_schema = current_schema()`;
	const out = new Map<string, Map<string, ColumnType>>();
	for (const t of tables()) {
		const cols = new Map(rows.filter((r) => r.table_name === t.name).map((r) => [r.column_name as string, typeOf(r.data_type)]));
		for (const c of t.images ?? []) cols.set(c, "image");
		for (const c of t.links ?? []) cols.set(c, "link");
		for (const [c, x] of Object.entries(t.computed ?? {})) cols.set(c, x.type);
		out.set(t.name, cols);
	}
	return out;
}

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

const guarded = (t: Table) =>
	Object.entries(t.edit ?? {})
		.filter(([, e]) => e.when)
		.map(([c, e]) => [c, e.when!] as const);

function shape(t: Table, cols: Map<string, ColumnType>, row: Row, only: readonly string[] = Object.keys(t.columns)): Row {
	const out: Row = {
		_key: Object.fromEntries(t.key.map((k) => [k, String(row[k])])),
		_readonly: guarded(t)
			.filter(([c]) => !row[`_can_${c}`])
			.map(([c]) => c),
	};
	for (const c of only) {
		const computed = t.computed?.[c];
		const v = computed ? computed.of(row) : row[c];
		out[c] = cols.get(c) === "number" && v !== null && v !== undefined ? Number(v) : v;
	}
	return out;
}

export async function serve(
	sql: Sql,
	{ host, port, dist }: { host: string; port: number; dist: string },
): Promise<{ port: number; stop: () => Promise<void> }> {
	const colTypes = await types(sql);
	const table = (name: unknown) => {
		const t = tables().find((x) => x.name === name);
		if (!t) throw new Usage(`没有表 ${String(name)}`);
		return t;
	};
	const where = (t: Table, key: Key) => {
		if (!key || t.key.some((k) => typeof key[k] !== "string")) throw new Usage(`${t.title}：要主键 ${t.key.join("、")}`);
		return t.key.map((k) => sql`${sql(k)} = ${key[k]!}`).reduce((a, b) => sql`${a} and ${b}`);
	};
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
				tables().map(async (t): Promise<Meta> => {
					const cols = colTypes.get(t.name)!;
					return {
						name: t.name,
						title: t.title,
						key: t.key,
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
			let raw: unknown;
			try {
				raw = JSON.parse(url.searchParams.get("ref") ?? "");
			} catch {
				throw new Usage("ref 要是 datagrid 的 props 的 JSON");
			}
			const ref = parseProps("datagrid", raw) as Ref;
			const t = table(ref.table);
			const q = refQuery(t, ref, LIMIT);
			const rows = await sql.unsafe(q.text, q.values);
			const only = [...new Set([...(ref.columns ?? Object.keys(t.columns)), ...(ref.group ? [ref.group.col] : [])])];
			return rows.map((r) => shape(t, colTypes.get(t.name)!, r, only));
		},

		"GET /api/pages": async () => listPages(sql),
		"GET /api/page": async (_, url) => showPage(sql, url.searchParams.get("id") ?? ""),
		"DELETE /api/page": async (_, url) => {
			await deletePage(sql, url.searchParams.get("id") ?? "");
			return { ok: true };
		},
		"POST /api/page/answer": async (b) => {
			await answer(sql, String(b?.item ?? ""), b?.answer);
			return { ok: true };
		},
		"POST /api/page/act": async (b) => act(sql, String(b?.item ?? ""), String(b?.action ?? ""), b?.input),
		"DELETE /api/page/item": async (_, url) => {
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
				const told =
					e instanceof Usage || e instanceof NeedsHuman || (e as { code?: string }).code?.startsWith("23") || (e as { code?: string }).code === "22P02";
				if (!told) console.error(e);
				send(res, told ? 400 : 500, "application/json", JSON.stringify({ error: (e as Error).message }));
			}
			return;
		}
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
