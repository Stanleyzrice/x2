// 做商品稿时的并发：
// - 问 Gemini、取图同时做，各有上限（limiter）：上品的代码问 Gemini 用这里的 gemini、geminiJson，取图包在 download 里
// - 碰浏览器的步骤在这个进程里按浏览器排队（lanes）：x2 在一个浏览器里每个站点只用一个标签页，两件事同时用会互相打断，所以一个浏览器同一时刻只做一件
// - 读 1688 两次之间隔几秒：读得太密 1688 会跳滑块验证
// - 同一件事同时要几次的只做一次（once：同一张图的筛字、加水印传图）
// 跨进程（两个 x2 同时开）的排队不在这里

import { gemini as ask, geminiJson as askJson, type Image } from "../../connectors/services/gemini/api.ts";
import { in1688, inShop, scan } from "../../platform/browser/accounts.ts";
import { NeedsHuman } from "../../platform/errors.ts";

/** 在某处做 fn（例 在这家店的浏览器里排队做） */
export type Runner = <T>(fn: () => Promise<T>) => Promise<T>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 同时最多 n 件，多的排队，先来先做 */
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

/** 按 key 排队：同一个 key 同一时刻只做一件，先来先做；gapMs：上一件做完到下一件开始至少隔这么久 */
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
/** 同一个 key 正在做的，等它的结果，不再做一次（做完就忘：下次再要照常做，结果靠库里的缓存） */
export function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const hit = inflight.get(key);
	if (hit) return hit as Promise<T>;
	const p = fn().finally(() => inflight.delete(key));
	inflight.set(key, p);
	return p;
}

/** 几件事同时做（最多 n 件），结果照 items 的顺序。一件要人处理（NeedsHuman）以后，没开始的不再开始（要人处理的多半是登录、滑块，接着做也是一样） */
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

/** 一个进程里的浏览器队：key 是浏览器 */
const lane = lanes();
/** 两次读 1688 之间隔多久 */
export const GAP_1688_MS = 3000;

/** 浏览器队的 key：登录着这家店（shopId）或这个 1688 账号（account）的浏览器（seen 是 accounts.ts 的 scan）。同一个浏览器里登录着店和 1688 的，是同一个队 */
export function browserKey(
	seen: { browser: string; shop: { shopId: string } | null; alibaba: string | null }[],
	who: { shopId: string } | { account: string },
): string {
	const s = "shopId" in who ? seen.find((x) => x.shop?.shopId === who.shopId) : seen.find((x) => x.alibaba === who.account);
	return s ? `浏览器 ${s.browser}` : "shopId" in who ? `店铺 ${who.shopId}` : `1688 ${who.account}`;
}

/** 在登录着这家店的浏览器里做 fn（加水印、传图、新增商品页、类目、属性、备货天数），排在这个浏览器的队里 */
export async function inShopQueued<T>(shopId: string, fn: () => Promise<T>): Promise<T> {
	return lane(browserKey(await scan(), { shopId }), () => inShop(shopId, fn));
}

/** 读 1688 的页面（货源）：在登录着这个账号的浏览器里做，排在这个浏览器的队里；两次读 1688 之间隔几秒 */
export function on1688<T>(account: string, fn: () => Promise<T>): Promise<T> {
	return lane("1688", async () => lane(browserKey(await scan(), { account }), () => in1688(account, fn)), GAP_1688_MS);
}

/** 不经浏览器从 1688 取的（详情图的地址）：也算读 1688，和读页面一起隔几秒 */
export const from1688 = <T>(fn: () => Promise<T>): Promise<T> => lane("1688", fn, GAP_1688_MS);

/** 上限从环境变量读（第一次用时）：X2_GEMINI_CONCURRENCY 同时问 Gemini 几个（默认 8），X2_DOWNLOAD_CONCURRENCY 同时取几张图（默认 6） */
const fromEnv = (name: string, fallback: number) => {
	const n = Number(process.env[name]);
	return Number.isInteger(n) && n > 0 ? n : fallback;
};
let geminiGate: Runner | null = null,
	downloadGate: Runner | null = null;
const askGate = () => {
	geminiGate ??= limiter(fromEnv("X2_GEMINI_CONCURRENCY", 8));
	return geminiGate;
};
/** 问 Gemini（不排队，同时最多 X2_GEMINI_CONCURRENCY 个请求） */
export const gemini = (prompt: string, images: Image[], schema?: object): Promise<string> => askGate()(() => ask(prompt, images, schema));
export const geminiJson = <T>(prompt: string, images: Image[], schema: object): Promise<T> => askGate()(() => askJson<T>(prompt, images, schema));
/** 取图（同时最多 X2_DOWNLOAD_CONCURRENCY 张） */
export const download: Runner = (fn) => {
	downloadGate ??= limiter(fromEnv("X2_DOWNLOAD_CONCURRENCY", 6));
	return downloadGate(fn);
};
