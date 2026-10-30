// 网页和 x2 web 之间：页、表的说明、表的行、改一格、添一行。出错抛人看得懂的原话（x2 web 回的）
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Item, Page, PageSummary } from "../web/pages.ts";
import type { Grid, Key, Meta, Pic, Shown as Row } from "../web/tables.ts";

export type { Grid, Item, Key, Meta, Page, PageSummary, Pic, Row };
export type Column = Meta["columns"][number];

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const r = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
	const data = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
	if (!r.ok) throw new Error(data.error ?? `${r.status}`);
	return data as T;
}
const q = encodeURIComponent;

export const api = {
	pages: () => call<PageSummary[]>("GET", "/api/pages"),
	page: (id: string) => call<Page>("GET", `/api/page?id=${q(id)}`),
	deletePage: (id: string) => call<unknown>("DELETE", `/api/page?id=${q(id)}`),
	answer: (item: string, answer: unknown) => call<unknown>("POST", "/api/page/answer", { item, answer }),
	act: <T>(item: string, action: string, input: Record<string, unknown> = {}) => call<T>("POST", "/api/page/act", { item, action, input }),
	closeItem: (id: string) => call<unknown>("DELETE", `/api/page/item?id=${q(id)}`),
	rows: (ref: unknown) => call<Row[]>("GET", `/api/rows?ref=${q(JSON.stringify(ref))}`),
	set: (table: string, key: Key, col: string, value: unknown) => call<Row | null>("PATCH", "/api/rows", { table, key, col, value }),
	add: (table: string, values: Record<string, unknown>) => call<{ key: unknown }>("POST", "/api/rows", { table, values }),
};

let metas: Promise<Meta[]> | null = null;
export const meta = (table: string) => {
	metas ??= call<Meta[]>("GET", "/api/meta");
	return metas.then((all) => {
		const m = all.find((x) => x.name === table);
		if (!m) throw new Error(`没有表 ${table}`);
		return m;
	});
};

export const keyOf = (row: Row) => JSON.stringify(row._key);
export const fail = (e: Error) => toast.error(e.message);

export function usePoll<T>(read: () => Promise<T>, ms: number, deps: unknown[]): [T | null, string | null, () => void] {
	const [value, setValue] = useState<T | null>(null);
	const [error, setError] = useState<string | null>(null);
	const latest = useRef(read);
	latest.current = read;
	const load = useRef(() => {
		latest.current().then(
			(v) => {
				setValue(v);
				setError(null);
			},
			(e: Error) => setError(e.message),
		);
	}).current;
	const key = JSON.stringify(deps);
	// biome-ignore lint/correctness/useExhaustiveDependencies: deps（key）变了才清掉重来；读的函数每次渲染都是新的，用 ref 里最新的
	useEffect(() => {
		setValue(null);
		load();
		const t = setInterval(load, ms);
		window.addEventListener("focus", load);
		return () => {
			clearInterval(t);
			window.removeEventListener("focus", load);
		};
	}, [key, ms]);
	return [value, error, load];
}
