// 网页和 x2 web 之间：页、表的说明、表的行、改一格、添一行。出错抛人看得懂的原话（x2 web 回的）
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { BrowserAuthorization } from "../web/browser-authorizations.ts";
import type { BrowserConnectionInput, BrowserConnectionResult } from "../web/browser-connection.ts";
import type { HermesRequest, HermesRun } from "../web/hermes.ts";
import type { Conversation, ConversationSummary, HistoryImport } from "../web/hermes-history.ts";
import type { Item, Page, PageSummary } from "../web/pages.ts";
import type { SetupState, XiangjiInput } from "../web/setup.ts";
import type { Grid, Key, Meta, Pic, Shown as Row } from "../web/tables.ts";
import type { HermesTurn } from "./hermes-schema.ts";
import type { SourceDetail, SourceList } from "./interactable/catalog/source-types.ts";
import type { CatalogResult } from "./interactable/catalog/types.ts";
import { preserveMonitor } from "./interactable/procurement/sync.ts";
import type { Monitor } from "./interactable/procurement/types.ts";
import type { Data as ReimbursementData } from "./interactable/reimbursement/types.ts";
import { errorOf } from "./lib/state.ts";
import { readCache } from "./read-cache.ts";

export type {
	BrowserAuthorization,
	BrowserConnectionInput,
	BrowserConnectionResult,
	Conversation,
	ConversationSummary,
	Grid,
	HermesRequest,
	HermesRun,
	HermesTurn,
	Item,
	Key,
	Meta,
	Page,
	PageSummary,
	Pic,
	Row,
	SetupState,
};
export type Column = Meta["columns"][number];
export class ApiError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}
}

async function call<T>(method: string, path: string, body?: unknown, keepalive = false): Promise<T> {
	const r = await fetch(path, {
		method,
		headers: { "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		keepalive,
	});
	const data: unknown = await r.json().catch(() => ({ error: r.ok ? "X2 返回的数据不完整，请重新读取" : `${r.status} ${r.statusText}` }));
	if (!r.ok) {
		const message = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string" ? data.error : `${r.status}`;
		throw new ApiError(message, r.status);
	}
	return data as T;
}
const q = encodeURIComponent;
const pageCache = readCache<Page>();
const catalogCache = readCache<CatalogResult>();
const sourceCache = readCache<SourceList>();
const sourceDetailCache = readCache<SourceDetail>(30_000, 20);
const procurementCache = readCache<Monitor>(15_000, 20);
const procurementEpochs = new Map<string, number>();
const procurementSyncs = new Map<string, number>();
const reimbursementCache = readCache<ReimbursementData>(15_000);
type CatalogQuery = { shop: string; query: string; status: string; stock: string; category?: string; page: number; pageSize: number };
const catalogKey = (item: string, input: CatalogQuery) =>
	`${item}:${JSON.stringify([input.shop, input.query, input.status, input.stock, input.category ?? "all", input.page, input.pageSize])}`;
export type SourceQuery = { targetShop: string; query: string; platform: string; status: string };
type SourceDetailQuery = { targetShop: string; sourceId: string };
const sourceKey = (item: string, input: SourceQuery) => `${item}:${JSON.stringify([input.targetShop, input.query, input.platform, input.status])}`;
const sourceDetailKey = (item: string, input: SourceDetailQuery) => `${item}:${JSON.stringify([input.targetShop, input.sourceId])}`;
const procurementKey = (item: string, shops: string[]) => `${item}:${JSON.stringify([...new Set(shops)].sort())}`;
export type ReimbursementQuery = { accounts?: string[]; account?: string; search: string; paidFrom: string; paidTo: string; offset: number };
const reimbursementKey = (item: string, input: ReimbursementQuery) =>
	`${item}:${JSON.stringify([input.accounts ?? null, input.account ?? null, input.search, input.paidFrom, input.paidTo, input.offset])}`;

export const api = {
	setup: () => call<SetupState>("GET", "/api/setup"),
	setupDatabase: (url: string) => call<SetupState>("POST", "/api/setup/database", { url }),
	setupHermes: (input: { apiKey?: string; model: string; python?: string }) => call<SetupState>("POST", "/api/setup/hermes", input),
	setupShops: () => call<BrowserAuthorization[]>("GET", "/api/setup/shops"),
	setupXiangji: (input: XiangjiInput) => call<SetupState>("POST", "/api/setup/xiangji", input),
	setupShop: (accountId: string) => call<SetupState>("POST", "/api/setup/shop", { accountId }),
	finishSetup: () => call<SetupState>("POST", "/api/setup/finish", {}),
	startHermes: (request: HermesRequest) => call<HermesRun>("POST", "/api/hermes/run", request),
	hermesEvents: (id: string) => `/api/hermes/run/events?id=${q(id)}`,
	hermesConversations: () => call<ConversationSummary[]>("GET", "/api/hermes/conversations"),
	hermesConversation: (id: string) => call<Conversation | null>("GET", `/api/hermes/conversation?id=${q(id)}`),
	deleteHermesConversation: (id: string) => call<{ id: string }>("DELETE", `/api/hermes/conversation?id=${q(id)}`),
	importHermesConversation: (input: HistoryImport) => call<{ id: string }>("POST", "/api/hermes/conversation/import", input),
	connectBrowser: (input: BrowserConnectionInput) => call<BrowserConnectionResult>("POST", "/api/browser/connect", input),
	browserAuthorizations: (site: string) => call<BrowserAuthorization[]>("GET", `/api/browser/authorizations?site=${q(site)}`),
	pages: () => call<PageSummary[]>("GET", "/api/pages"),
	page: (id: string, force = false) => pageCache.read(id, () => call<Page>("GET", `/api/page?id=${q(id)}`), force),
	peekPage: (id: string) => pageCache.peek(id),
	deletePage: async (id: string) => {
		await call<unknown>("DELETE", `/api/page?id=${q(id)}`);
		pageCache.invalidate(id);
	},
	deletePages: async (ids: string[]) => {
		const result = await call<{ deleted: string[] }>("POST", "/api/pages/delete", { ids });
		for (const id of result.deleted) pageCache.invalidate(id);
		return result;
	},
	catalogProducts: (item: string, input: CatalogQuery, force = false) =>
		catalogCache.read(catalogKey(item, input), () => call<CatalogResult>("POST", "/api/page/act", { item, action: "products", input }), force),
	peekCatalogProducts: (item: string, input: CatalogQuery) => catalogCache.peek(catalogKey(item, input)),
	invalidateCatalog: (item: string) => catalogCache.invalidate(`${item}:`),
	sources: (item: string, input: SourceQuery, force = false) =>
		sourceCache.read(sourceKey(item, input), () => call<SourceList>("POST", "/api/page/act", { item, action: "sources", input }), force),
	peekSources: (item: string, input: SourceQuery) => sourceCache.peek(sourceKey(item, input)),
	sourceDetail: (item: string, input: SourceDetailQuery, force = false) =>
		sourceDetailCache.read(sourceDetailKey(item, input), () => call<SourceDetail>("POST", "/api/page/act", { item, action: "sourceDetail", input }), force),
	peekSourceDetail: (item: string, input: SourceDetailQuery) => sourceDetailCache.peek(sourceDetailKey(item, input)),
	invalidateSources: (item?: string) => {
		const prefix = item ? `${item}:` : "";
		sourceCache.invalidate(prefix);
		sourceDetailCache.invalidate(prefix);
	},
	procurementMonitor: (item: string, shops: string[], force = false) => {
		const key = procurementKey(item, shops);
		const cached = procurementCache.peek(key);
		// 同步暂时关闭旧订单的采购资格，保留已显示内容；人工操作失效后仍允许重新核对。
		if (procurementSyncs.has(key) && cached) return Promise.resolve(cached);
		return procurementCache.read(
			key,
			async () => {
				const current = await call<Monitor>("POST", "/api/page/act", { item, action: "monitor", input: {} });
				return preserveMonitor(procurementCache.peek(key), current);
			},
			force,
		);
	},
	peekProcurementMonitor: (item: string, shops: string[]) => procurementCache.peek(procurementKey(item, shops)),
	setProcurementMonitor: (item: string, shops: string[], value: Monitor) => procurementCache.set(procurementKey(item, shops), value),
	beginProcurementSync: (item: string, shops: string[]) => {
		const key = procurementKey(item, shops);
		procurementSyncs.set(key, (procurementSyncs.get(key) ?? 0) + 1);
	},
	endProcurementSync: (item: string, shops: string[]) => {
		const key = procurementKey(item, shops);
		const count = procurementSyncs.get(key) ?? 0;
		if (count > 1) procurementSyncs.set(key, count - 1);
		else procurementSyncs.delete(key);
	},
	procurementMonitorEpoch: (item: string) => procurementEpochs.get(item) ?? 0,
	invalidateProcurementMonitor: (item: string) => {
		procurementEpochs.set(item, (procurementEpochs.get(item) ?? 0) + 1);
		procurementCache.invalidate(`${item}:`);
	},
	reimbursementRecords: (item: string, input: ReimbursementQuery, force = false) =>
		reimbursementCache.read(reimbursementKey(item, input), () => call<ReimbursementData>("POST", "/api/page/act", { item, action: "list", input }), force),
	peekReimbursementRecords: (item: string, input: ReimbursementQuery) => reimbursementCache.peek(reimbursementKey(item, input)),
	invalidateReimbursementRecords: (item: string) => reimbursementCache.invalidate(`${item}:`),
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
export const fail = (error: unknown) => toast.error(errorOf(error));

export function usePoll<T>(read: () => Promise<T>, ms: number, deps: unknown[], initial: T | null = null): [T | null, string | null, () => void] {
	const [value, setValue] = useState<T | null>(initial);
	const [error, setError] = useState<string | null>(null);
	const epoch = useRef(0);
	const sequence = useRef(0);
	const latest = useRef(read);
	latest.current = read;
	const cached = useRef(initial);
	cached.current = initial;
	const load = useRef(() => {
		const generation = epoch.current,
			request = ++sequence.current;
		latest.current().then(
			(v) => {
				if (generation !== epoch.current || request !== sequence.current) return;
				setValue(v);
				setError(null);
			},
			(error: unknown) => {
				if (generation === epoch.current && request === sequence.current) setError(errorOf(error));
			},
		);
	}).current;
	const key = JSON.stringify(deps);
	// biome-ignore lint/correctness/useExhaustiveDependencies: deps（key）变了才清掉重来；读的函数每次渲染都是新的，用 ref 里最新的
	useEffect(() => {
		epoch.current++;
		setValue(cached.current);
		setError(null);
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
