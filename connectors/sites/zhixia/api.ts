// 知虾（shopee.mobduos.com，Shopee 的第三方数据平台）。接口一览和各自的参数在同目录的 NOTES.md。
// 请求要签名（x-risk-token 由页面现算），照请求重发会让令牌作废：用页面自己的 axios 发——webpack 模块 b775，
// 注册一个模块拿到 require 再取它（模块 id 每次唯一：同名模块 webpack 不再执行工厂函数）。
// 限流（lilto 2026-08-29 复盘：5 分钟 1150 次，令牌被作废）：两次请求隔 6～10 秒，每小时最多 200 次，都走 api()；
// 次数记在 ~/x2/zhixia-usage.json，几个 x2 进程共用：api() 从等限流到发完请求一直拿着知虾的锁（browser.ts 的 hold），几个进程不会同时算、同时发。
// 回 401、602（没登录、令牌作废）立刻抛错，调用方停下，不换参数重试

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { hold, type Page, page } from "../../../platform/browser/browser.ts";
import { NeedsHuman } from "../../../platform/errors.ts";
import { reply } from "../../../platform/reply.ts";

const ORIGIN = "https://shopee.mobduos.com";
const PRO = "/api/shopee-report-service/pro";
const GAP_MS = 6000,
	JITTER_MS = 4000,
	PER_HOUR = 200;

type Usage = { calls: string[] };

const USAGE = join(process.env.X2_HOME ?? join(homedir(), "x2"), "zhixia-usage.json");

async function readUsage(): Promise<Usage> {
	const text = await readFile(USAGE, "utf8").catch((e: NodeJS.ErrnoException) => {
		if (e.code === "ENOENT") return null;
		throw e;
	});
	return text === null ? { calls: [] } : (JSON.parse(text) as Usage);
}

async function writeUsage(u: Usage): Promise<void> {
	await mkdir(join(USAGE, ".."), { recursive: true });
	await writeFile(`${USAGE}.tmp`, `${JSON.stringify(u)}\n`);
	await rename(`${USAGE}.tmp`, USAGE);
}

async function throttle(): Promise<void> {
	const usage = await readUsage();
	const now = Date.now();
	const recent = usage.calls.filter((t) => now - Date.parse(t) < 3_600_000);
	if (recent.length >= PER_HOUR) {
		const free = Date.parse(recent[0]!) + 3_600_000 - now;
		throw new Error(`知虾这一小时已经请求 ${recent.length} 次（上限 ${PER_HOUR}），${Math.ceil(free / 60_000)} 分钟后再试`);
	}
	const last = recent.at(-1);
	const wait = last ? Date.parse(last) + GAP_MS + Math.random() * JITTER_MS - now : 0;
	if (wait > 0) await new Promise((r) => setTimeout(r, wait));
	await writeUsage({ calls: [...recent, new Date().toISOString()] });
}

// 页面里用到的：webpack 的 jsonp 运行时、Vue 根组件上的 store（站点、类目树）
type WebpackRequire = (id: string) => { a: (config: Record<string, unknown>) => Promise<unknown> };
type ZhixiaWindow = {
	webpackJsonp?: { push: (chunk: [string[], Record<string, (m: unknown, e: unknown, r: WebpackRequire) => void>, string[][]]) => void };
	__x2Http?: (config: Record<string, unknown>) => Promise<unknown>;
};
type VueRoot = HTMLElement & { __vue__?: { $store?: { getters?: { siteId?: unknown; siteName?: unknown }; state?: { user?: { catList?: unknown } } } } };

const expectedSite = new AsyncLocalStorage<number | undefined>();
export const withExpectedSite = <T>(expectedSiteId: number | undefined, run: () => Promise<T>): Promise<T> =>
	expectedSite.run(expectedSiteId ?? expectedSite.getStore(), run);

/** 仅供登录身份探测：认当前会话是否登录，不让市场约束被误当成登录失败；结束后自动恢复。 */
export const probeIdentity = <T>(identify: () => Promise<T>): Promise<T> => expectedSite.run(undefined, identify);

export type SiteContext = { siteId: number; siteName: string | null };

/** 只校验页面原生站点，不推断国家、不切站；缺少站点时不能默认成任何编号。 */
export function siteContextOf(value: unknown, expectedSiteId = expectedSite.getStore()): SiteContext {
	const parsed = z.looseObject({ siteId: z.unknown(), siteName: z.unknown().optional() }).safeParse(value);
	const raw = parsed.success ? parsed.data : null;
	const siteId = typeof raw?.siteId === "number" || (typeof raw?.siteId === "string" && /^\d+$/.test(raw.siteId)) ? Number(raw.siteId) : Number.NaN;
	if (!Number.isSafeInteger(siteId) || siteId <= 0) throw new NeedsHuman("知虾当前站点编号无法确认：在浏览器工作台确认站点后再试，不会默认站点或自动切换");
	if (expectedSiteId !== undefined && siteId !== expectedSiteId)
		throw new NeedsHuman(`知虾当前站点编号${siteId}与期望站点编号${expectedSiteId}不符：请在浏览器确认站点，不会自动切换或读取其他站点数据`);
	return { siteId, siteName: typeof raw?.siteName === "string" && raw.siteName.trim() ? raw.siteName : null };
}

async function readSiteContext(p: Page): Promise<SiteContext> {
	return siteContextOf(
		await p.run(() => {
			const getters = document.querySelector<VueRoot>("#app")?.__vue__?.$store?.getters;
			return { siteId: getters?.siteId ?? null, siteName: getters?.siteName ?? null };
		}),
	);
}

/** 返回页面原生编号与名称；没有名称 getter 时返回 null，不维护国家映射。 */
export async function context(): Promise<SiteContext> {
	return hold(ORIGIN, async () => {
		await ready();
		return readSiteContext(await page(ORIGIN));
	});
}

/** x2 打开知虾标签页时要落在工作台页面上（有 webpackJsonp），不是随便一页 */
export async function ready(): Promise<void> {
	const p = await page(ORIGIN);
	// 首页（/）也有 webpackJsonp，但没有工作台的 store：要在 /workbench/ 下面
	const ok = await p.run(
		() =>
			Boolean((window as unknown as ZhixiaWindow).webpackJsonp) &&
			location.pathname.startsWith("/workbench/") &&
			!location.pathname.startsWith("/workbench/login"),
	);
	if (!ok) await p.goto(`${ORIGIN}/workbench/home`);
}

/** 用页面的 axios 发一个请求，回整个响应体（各接口的外壳不一样：有的在 data，有的在 hotWordList、payload）。
 * path 是 /api/shopee-report-service/pro 之后的一段；默认取当前站点，withExpectedSite 可要求实际站点一致 */
export async function api<S extends z.ZodType>(
	path: string,
	schema: S,
	params: Record<string, unknown> = {},
	method: "get" | "post" = "get",
): Promise<z.output<S>> {
	const body = await hold(ORIGIN, async () => {
		await ready();
		const p = await page(ORIGIN);
		await readSiteContext(p);
		if (expectedSite.getStore() !== undefined && params.siteId !== undefined) siteContextOf({ siteId: params.siteId });
		await throttle();
		const result = await p.run(
			async (url: string, params: Record<string, unknown>, method: string, expectedSiteId: number | null) => {
				if (location.pathname.startsWith("/workbench/login")) return { code: 401, msg: "没有登录" };
				const w = window as unknown as ZhixiaWindow;
				if (!w.webpackJsonp) return { code: -1, msg: "页面还没加载好：不是知虾的工作台页面" };
				// 节流等待期间页面可能换站；在实际请求前同一次页面执行中重新检查。
				const getters = document.querySelector<VueRoot>("#app")?.__vue__?.$store?.getters;
				const current = { siteId: getters?.siteId ?? null, siteName: getters?.siteName ?? null };
				const siteId =
					typeof current.siteId === "number" || (typeof current.siteId === "string" && /^\d+$/.test(current.siteId)) ? Number(current.siteId) : Number.NaN;
				if (!Number.isSafeInteger(siteId) || siteId <= 0 || (expectedSiteId !== null && siteId !== expectedSiteId)) return { x2SiteMismatch: current };
				if (
					expectedSiteId !== null &&
					params.siteId !== undefined &&
					(!(typeof params.siteId === "number" || (typeof params.siteId === "string" && /^\d+$/.test(params.siteId))) ||
						Number(params.siteId) !== expectedSiteId)
				)
					return { x2RequestedSiteMismatch: true };
				if (!w.__x2Http) {
					const holder: { req: WebpackRequire | null } = { req: null };
					const id = `x2-http-${Date.now()}-${Math.random().toString(36).slice(2)}`;
					w.webpackJsonp.push([
						[id],
						{
							[id]: (_m: unknown, _e: unknown, r: WebpackRequire) => {
								holder.req = r;
							},
						},
						[[id]],
					]);
					w.__x2Http = holder.req?.("b775").a;
				}
				if (!w.__x2Http) return { code: -1, msg: "页面里没找到知虾的 axios（webpack 模块 b775）" };
				const all = { siteId, ...params };
				return w.__x2Http({ url, method, ...(method === "get" ? { params: all } : { data: all }), validateStatus: () => true });
			},
			`${PRO}${path}`,
			params,
			method,
			expectedSite.getStore() ?? null,
		);
		if (typeof result === "object" && result !== null && "x2SiteMismatch" in result) siteContextOf(result.x2SiteMismatch);
		if (typeof result === "object" && result !== null && "x2RequestedSiteMismatch" in result)
			throw new NeedsHuman("知虾请求参数的站点与期望站点不符：请核对参数，不会读取其他站点数据");
		return result;
	});
	const b = shell.safeParse(body).data ?? {};
	if (b.code === 401 || b.code === 602) throw new NeedsHuman("知虾没有登录（或令牌失效）：在浏览器里登录知虾再试");
	if (b.code !== undefined && b.code !== null && Number(b.code) !== 200) throw new Error(`知虾 ${path} 回：${b.code} ${b.msg ?? ""}`);
	return reply(schema, body, `知虾 ${path}`);
}

/** 各接口的外壳不一样，只有 code（200 成功；401、602 没登录、令牌作废）、msg 是共有的 */
const shell = z.looseObject({ code: z.union([z.number(), z.string()]).nullish(), msg: z.string().nullish() });

type Row = Record<string, unknown>;
const row = z.looseObject({});
const num = z.union([z.number(), z.string()]).nullish();
/** 类目路径：一级、二级、三级类目 id，例 [100629, 100630]；接口要最后一级的 id 和层数 */
const at = (path: number[]) => (path.length ? { catId: path.at(-1), level: path.length } : {});

export type Category = { id: string; name: string; children: Category[] };

type CatNode = { value: string | number; label: string | number; children?: CatNode[] | null };
const catNode: z.ZodType<CatNode> = z.looseObject({
	value: z.union([z.string(), z.number()]),
	label: z.union([z.string(), z.number()]),
	get children() {
		return z.array(catNode).nullish();
	},
});

/** 类目树（三级）。读页面 store 里登录时就载入的 state.user.catList，不发请求 */
export async function categories(): Promise<Category[]> {
	return hold(ORIGIN, async () => {
		await ready();
		const p = await page(ORIGIN);
		const snapshot = await p.run(() => {
			const store = document.querySelector<VueRoot>("#app")?.__vue__?.$store;
			return { siteId: store?.getters?.siteId ?? null, siteName: store?.getters?.siteName ?? null, list: store?.state?.user?.catList ?? null };
		});
		siteContextOf(snapshot);
		const list = snapshot.list;
		// 没有类目树就是没登录（或页面没载入工作台）：别当成空的
		if (!Array.isArray(list) || !list.length) throw new NeedsHuman("知虾的工作台没有类目树：在浏览器里登录知虾、打开工作台再试");
		const conv = (c: CatNode): Category => ({ id: String(c.value), name: String(c.label), children: (c.children ?? []).map(conv) });
		return reply(z.array(catNode), list, "知虾的类目树（store 的 state.user.catList）").map(conv);
	});
}

/** 热销类目榜：path 下一级的各类目，按昨天（DAY）的销量排；path 为空是全站的二级类目（不是一级，2026-10-09 查过） */
export async function sellWell(path: number[] = [], pageNum = 1, pageSize = 100): Promise<{ total: number; rows: Row[] }> {
	const b = await api("/industryAnalysis/sellWell", z.looseObject({ data: z.array(row).nullish(), total: num }), {
		type: "DAY",
		field: "sales",
		sortType: "DESC",
		isBorder: 0,
		pageNum,
		pageSize,
		...at(path),
	});
	return { total: Number(b.total ?? 0), rows: b.data ?? [] };
}

export async function categoryDaily(path: number[]): Promise<Row> {
	return (await api("/industryAnalysis/industryInfoOverview", z.looseObject({ data: row }), at(path))).data;
}

// 口径（lilto 记下的）：searchVal 是全站的搜索量，sales30day 是本类目 30 天的销量；标题里的片段不等于搜索词

/** 一个热搜词：hotWordId 是别的接口要的 id；searchVal 全站搜索量、sales30day 本类目 30 天销量 */
export const hotWord = z.looseObject({ hotWordId: z.number(), word: z.string(), searchVal: num, sales30day: num });
const hotWordList = z.looseObject({ hotWordList: z.array(hotWord).nullish(), total: num, updateTime: z.string().nullish() });

/** 一个类目的热搜词，最多 1000 个；updateTime 是数据的日期 */
export async function hotWords(path: number[]): Promise<{ total: number; updateTime: string | null; rows: z.output<typeof hotWord>[] }> {
	const b = await api("/hotWord/hotWordList", hotWordList, {
		field: "",
		orderType: "",
		pageNum: 1,
		pageSize: 1000,
		isBorder: 0,
		...at(path),
	});
	return { total: Number(b.total ?? 0), updateTime: b.updateTime ?? null, rows: b.hotWordList ?? [] };
}

/** 一个竞品：itemId、名字、30 天销量在 itemDataList[0].sales30Day；别的格原样 */
export const item = z.looseObject({ itemId: z.union([z.string(), z.number()]), itemDataList: z.array(z.looseObject({ sales30Day: num })).nullish() });
export type Item = z.output<typeof item>;
const hotWordItemList = z.looseObject({ itemListInfo: z.array(item).nullish(), total: num });

/** 一个词在一个类目里的全部商品（竞品），按 30 天销量（itemDataList[0].sales30Day）从高到低；每个商品带上架时间 ctime。
 * 站点不管 pageNum、pageSize、field、orderType：每次都回全部（2026-10-09：第 1、2 页都是同样的 1680 个，按 itemId 排），
 * 页面自己在浏览器里排序、截前 100 个。所以只发一次，在这里排 */
export async function hotWordItems(hotWordId: number, path: number[]): Promise<{ total: number; rows: Item[] }> {
	const b = await api("/hotWordDetail/hotWordItemSalesDetail", hotWordItemList, {
		exampleType: "DAY",
		word: String(hotWordId),
		field: "sales",
		orderType: "DESC",
		pageNum: 1,
		pageSize: 200,
		isBorder: 0,
		...at(path),
	});
	return { total: Number(b.total ?? 0), rows: bySales30Day(b.itemListInfo ?? []) };
}

export const bySales30Day = (rows: Item[]): Item[] => {
	const sales = (r: Item) => Number(r.itemDataList?.[0]?.sales30Day ?? -1) || 0;
	return [...rows].sort((a, b) => sales(b) - sales(a));
};

const word = (hotWordId: number) => ({ hotWordId, updateKey: 1 });
/** 一个词近期需求变化；不同字段可能混用统计窗口，不从字段名推断日值。 */
const one = z.looseObject({ data: row.nullish() });
const rows = z.looseObject({ data: z.array(row).nullish() });
const demandPoint = z.looseObject({
	timest: z
		.union([z.string(), z.number()])
		.transform(String)
		.pipe(z.string().regex(/^(?:\d{8}|\d{4}-\d{2}-\d{2})$/)),
	sales: z.union([z.number(), z.string()]).nullish(),
});
/** 原生DemandSupply将sales绑定销量、timest绑定日期；前10页动态样本、聚合窗口未知，仅作带日期观察值。 */
export function demandSeries(value: unknown) {
	const raw = z.looseObject({ charts: z.array(demandPoint) }).parse(value);
	return {
		metric: "sales" as const,
		basis: "observed" as const,
		source: {
			field: "charts.sales",
			dateField: "charts.timest",
			scope: "该关键词搜索结果前10页样本",
			aggregationWindow: "unknown",
			definitionUrl: "https://shopee.mobduos.com/workbench/big-data-selection/keyword-selection",
			limitations: ["样本成员与排名可能变化，变化可能来自样本替换", "聚合窗口未知，不代表日销量、周成交或全市场需求"],
		},
		points: raw.charts
			.map((point) => ({
				date: point.timest.includes("-") ? point.timest : `${point.timest.slice(0, 4)}-${point.timest.slice(4, 6)}-${point.timest.slice(6, 8)}`,
				value: point.sales ?? null,
			}))
			.sort((a, b) => a.date.localeCompare(b.date)),
	};
}
export const demandChange = async (hotWordId: number): Promise<Row | null | undefined> => {
	const result = (await api("/hotWordChopeeProduct/getDemandChange", one, word(hotWordId))).data;
	demandSeries(result);
	return result;
};
export const competition = async (hotWordId: number): Promise<Row | null | undefined> =>
	(await api("/hotWordChopeeProduct/getCompetitiveEnvironment", one, word(hotWordId))).data;
export const priceLine = async (hotWordId: number): Promise<Row | null | undefined> =>
	(await api("/hotWordChopeeProduct/getPriceLine", one, word(hotWordId))).data;
export const complaints = async (hotWordId: number): Promise<Row[]> => (await api("/hotWordChopeeProduct/tucaoPoint", rows, word(hotWordId))).data ?? [];
export const preferences = async (hotWordId: number): Promise<Row[]> => (await api("/hotWordChopeeProduct/preference", rows, word(hotWordId))).data ?? [];
/** 长尾词（参数是小写 w 的 hotwordId，列表在 payload） */
export const longTail = async (hotWordId: number): Promise<Row[]> =>
	(await api("/drainageWords/longTailWords", z.looseObject({ payload: z.array(row).nullish() }), { hotwordId: hotWordId })).payload ?? [];

export type Candidate = { offerId: string; url: string; title: string; price: number; monthSold: number; image: string };

/** 1688 同款的一个：offerId、subject、priceInfo.price、monthSold、imageUrl */
const sameOffer = z.looseObject({
	offerId: z.union([z.string(), z.number()]),
	subject: z.string().nullish(),
	priceInfo: z.looseObject({ price: num }).nullish(),
	monthSold: num,
	imageUrl: z.string().nullish(),
});

/** 1688 同款的回包 → 候选（纯函数）；没有列表是「回包变了」 */
export function similarOf(body: unknown, n = 4): Candidate[] {
	const b = reply(z.looseObject({ data: z.array(sameOffer) }), body, "知虾 /similarProduct/query1688");
	return b.data.slice(0, n).map((o) => ({
		offerId: String(o.offerId),
		url: `https://detail.1688.com/offer/${o.offerId}.html`,
		title: o.subject ?? "",
		price: Number(o.priceInfo?.price ?? 0),
		monthSold: Number(o.monthSold ?? 0),
		image: o.imageUrl ?? "",
	}));
}

export async function similar1688(imageUrl: string, n = 4): Promise<Candidate[]> {
	return similarOf(await api("/similarProduct/query1688", z.unknown(), { imgUrl: imageUrl, beginPage: 1, pageSize: n }), n);
}
