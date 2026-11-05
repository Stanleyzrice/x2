// 网页和 x2 web 之间：页、表的说明、表的行、改一格、添一行。出错抛人看得懂的原话（x2 web 回的）
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Item, Page, PageSummary } from "../web/pages.ts";
import type { Grid, Key, Meta, Pic, Shown as Row } from "../web/tables.ts";

export type { Grid, Item, Key, Meta, Page, PageSummary, Pic, Row };
export type Column = Meta["columns"][number];

async function call<T>(method: string, path: string, body?: unknown, keepalive = false): Promise<T> {
	const r = await fetch(path, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		keepalive,
	});
	const data = await r.json().catch(() => ({ error: `${r.status} ${r.statusText}` }));
	if (!r.ok) throw new Error(data.error ?? `${r.status}`);
	return data as T;
}
const q = encodeURIComponent;

export const api = {
	pages: () => call<PageSummary[]>("GET", "/api/pages"),
	page: (id: string) => call<Page>("GET", `/api/page?id=${q(id)}`),
	deletePage: (id: string) => call<unknown>("DELETE", `/api/page?id=${q(id)}`),
	deletePages: async (ids: string[]) => {
		const result = await call<{ deleted: string[] }>("POST", "/api/pages/delete", { ids });
		return result;
	},
	answer: (item: string, answer: unknown) => call<unknown>("POST", "/api/page/answer", { item, answer }),
	note: (item: string, rowId: string, text: string) => call<{ updatedAt: string }>("POST", "/api/page/note", { item, note: { rowId, text } }, true),
	act: <T>(item: string, action: string, input: Record<string, unknown> = {}) => call<T>("POST", "/api/page/act", { item, action, input }),
	prepare: (item: string, action: string, input: Record<string, unknown>) =>
		call<{ token: string; display: string; expiresAt: string; trialRequired: boolean }>("POST", "/api/page/prepare", { item, action, input }),
	confirm: <T>(token: string, trial = false) => call<T>("POST", "/api/page/confirm", { token, trial, confirmed: true }),
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
	const epoch = useRef(0);
	const sequence = useRef(0);
	const latest = useRef(read);
	latest.current = read;
	const load = useRef(() => {
		const generation = epoch.current,
			request = ++sequence.current;
		latest.current().then(
			(v) => {
				if (generation !== epoch.current || request !== sequence.current) return;
				setValue(v);
				setError(null);
			},
			(e: Error) => {
				if (generation === epoch.current && request === sequence.current) setError(e.message);
			},
		);
	}).current;
	const key = JSON.stringify(deps);
	// biome-ignore lint/correctness/useExhaustiveDependencies: deps（key）变了才清掉重来；读的函数每次渲染都是新的，用 ref 里最新的
	useEffect(() => {
		epoch.current++;
		setValue(null);
		load();
		const t = setInterval(load, ms);
		window.addEventListener("focus", load);
		return () => {
			epoch.current++;
			clearInterval(t);
			window.removeEventListener("focus", load);
		};
	}, [key, ms]);
	return [value, error, load];
}
