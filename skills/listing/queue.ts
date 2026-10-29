// 做商品稿时的并发：
// - 问 Gemini、取图同时做，各有上限（limiter）：上品的代码问 Gemini 用这里的 gemini、geminiJson，取图包在 download 里
// - 碰浏览器的步骤在这个进程里按浏览器排队（lanes）：x2 在一个浏览器里每个站点只用一个标签页，两件事同时用会互相打断，所以一个浏览器同一时刻只做一件
// - 读 1688 两次之间隔几秒：读得太密 1688 会跳滑块验证
// - 同一件事同时要几次的只做一次（once：同一张图的筛字、加水印传图）
// 跨进程（两个 x2 同时开）的排队不在这里

import { gemini as ask, geminiJson as askJson, type Image } from "../../connectors/services/gemini/api.ts";
import { inAccount, logins } from "../../platform/browser/accounts.ts";
import { NeedsHuman } from "../../platform/errors.ts";

export type Runner = <T>(fn: () => Promise<T>) => Promise<T>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function limiter(n: number): Runner {
	const max = Math.max(1, Math.floor(n) || 1);
	let running = 0;
	const waiting: (() => void)[] = [];
	return async <T>(fn: () => Promise<T>): Promise<T> => {
		if (running >= max) await new Promise<void>((r) => waiting.push(r));
		else running++;
		try {
			return await fn();
		} finally {
			const next = waiting.shift();
			if (next) next();
			else running--;
		}
	};
}

export function lanes(): <T>(key: string, fn: () => Promise<T>, gapMs?: number) => Promise<T> {
	const tails = new Map<string, Promise<void>>();
	const ended = new Map<string, number>();
	return async <T>(key: string, fn: () => Promise<T>, gapMs = 0): Promise<T> => {
		const prev = tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const mine = new Promise<void>((r) => {
			release = r;
		});
		const tail = prev.then(() => mine);
		tails.set(key, tail);
		await prev;
		try {
			const wait = (ended.get(key) ?? 0) + gapMs - Date.now();
			if (gapMs > 0 && wait > 0) await sleep(wait);
			return await fn();
		} finally {
			ended.set(key, Date.now());
			release();
			if (tails.get(key) === tail) tails.delete(key);
		}
	};
}

const inflight = new Map<string, Promise<unknown>>();
export function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const hit = inflight.get(key);
	if (hit) return hit as Promise<T>;
	const p = fn().finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

export async function each<I, R>(
	items: I[],
	n: number,
	fn: (item: I) => Promise<R>,
): Promise<({ ok: true; value: R } | { ok: false; error: unknown; started: boolean })[]> {
	const gate = limiter(n);
	let stop: NeedsHuman | null = null;
	return Promise.all(
		items.map((item) =>
			gate(async () => {
				if (stop) return { ok: false as const, error: stop, started: false };
				try {
					return { ok: true as const, value: await fn(item) };
				} catch (error) {
					if (error instanceof NeedsHuman) stop ??= error;
					return { ok: false as const, error, started: true };
				}
			}),
		),
	);
}

const lane = lanes();
export const GAP_1688_MS = 3000;

export function browserKey(seen: { site: string; browser: string; account: { id: string } }[], site: string, id: string): string {
	const s = seen.find((x) => x.site === site && x.account.id === id);
	return s ? `浏览器 ${s.browser}` : `${site} ${id}`;
}

const seen = async (site: string) => (await logins(site)).map((l) => ({ ...l, site }));

export async function inShopQueued<T>(shopId: string, fn: () => Promise<T>): Promise<T> {
	return lane(browserKey(await seen("shopee"), "shopee", shopId), () => inAccount("shopee", shopId, fn));
}

export function on1688<T>(account: string, fn: () => Promise<T>): Promise<T> {
	return lane(
		"1688",
		async () => lane(browserKey([...(await seen("shopee")), ...(await seen("1688"))], "1688", account), () => inAccount("1688", account, fn)),
		GAP_1688_MS,
	);
}

export const from1688 = <T>(fn: () => Promise<T>): Promise<T> => lane("1688", fn, GAP_1688_MS);

const fromEnv = (value: string | undefined, fallback: number) => {
	const n = Number(value);
	return Number.isInteger(n) && n > 0 ? n : fallback;
};
let geminiGate: Runner | null = null,
	downloadGate: Runner | null = null;
const askGate = () => {
	geminiGate ??= limiter(fromEnv(process.env.X2_GEMINI_CONCURRENCY, 8));
	return geminiGate;
};
export const gemini = (prompt: string, images: Image[], schema?: object): Promise<string> => askGate()(() => ask(prompt, images, schema));
export const geminiJson = <T>(prompt: string, images: Image[], schema: object): Promise<T> => askGate()(() => askJson<T>(prompt, images, schema));
export const download: Runner = (fn) => {
	downloadGate ??= limiter(fromEnv(process.env.X2_DOWNLOAD_CONCURRENCY, 6));
	return downloadGate(fn);
};
