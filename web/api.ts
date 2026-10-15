// 网页和 x2 web 之间：表的说明（meta）、一个视图的行、改一格、添一行。出错抛人看得懂的原话
import { createKumoToastManager } from "@cloudflare/kumo";
import type { Key, Meta, Row } from "../src/web/tables.ts";

export type { Key, Meta, Row };
export type Column = Meta["columns"][number];

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const data = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
	if (!r.ok) throw new Error(data.error ?? `${r.status}`);
	return data as T;
}

export const api = {
	meta: () => call<Meta[]>("GET", "/api/meta"),
	rows: (table: string, view: string) => call<Row[]>("GET", `/api/rows?table=${encodeURIComponent(table)}&view=${encodeURIComponent(view)}`),
	set: (table: string, key: Key, col: string, value: unknown) => call<Row>("PATCH", "/api/rows", { table, key, col, value }),
	add: (table: string, values: Record<string, unknown>) => call<{ key: unknown }>("POST", "/api/rows", { table, values }),
};

export const keyOf = (row: Row) => JSON.stringify(row._key);

/** 提示（存好了、存不进的原话）：整个网页一个 */
export const toast = createKumoToastManager();
export const fail = (e: Error) => toast.add({ title: e.message, variant: "error" });
