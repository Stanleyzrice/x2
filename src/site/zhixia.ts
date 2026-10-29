// 知虾（shopee.mobduos.com，Shopee 的第三方数据平台）。接口一览和各自的参数在 zhixia.md。
// 请求要签名（x-risk-token 由页面现算），照请求重发会让令牌作废：用页面自己的 axios 发——webpack 模块 b775，
// 注册一个模块拿到 require 再取它（模块 id 每次唯一：同名模块 webpack 不再执行工厂函数）。
// 限流（lilto 2026-08-29 复盘：5 分钟 1150 次，令牌被作废）：两次请求隔 6～10 秒，每小时最多 200 次，都走 api()；
// 次数记在 ~/x2/zhixia-usage.json，几个 x2 进程共用：api() 从等限流到发完请求一直拿着知虾的锁（browser.ts 的 hold），几个进程不会同时算、同时发。
// 回 401、602（没登录、令牌作废）立刻抛错，调用方停下，不换参数重试

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { hold, page } from "../browser.ts";
import { NeedsHuman } from "../errors.ts";
import { all, byPage, get, ints, num, type Ops, parseJson, str } from "./op.ts";

const ORIGIN = "https://shopee.mobduos.com";
const PRO = "/api/shopee-report-service/pro";
const GAP_MS = 6000,
	JITTER_MS = 4000,
	PER_HOUR = 200;

type Usage = { calls: string[] };

// 次数记在本机的文件里（不进库：这是本机这个浏览器的限流，不是店里的数据）。X2_HOME 可以改目录
const USAGE = join(process.env.X2_HOME ?? join(homedir(), "x2"), "zhixia-usage.json");

async function readUsage(): Promise<Usage> {
	const text = await readFile(USAGE, "utf8").catch((e: NodeJS.ErrnoException) => {
		if (e.code === "ENOENT") return null;
		throw e;
	});
	return text === null ? { calls: [] } : (JSON.parse(text) as Usage);
}

/** 先写临时文件再改名：写到一半进程挂了，原来的文件还在 */
async function writeUsage(u: Usage): Promise<void> {
	await mkdir(join(USAGE, ".."), { recursive: true });
	await writeFile(`${USAGE}.tmp`, `${JSON.stringify(u)}\n`);
	await rename(`${USAGE}.tmp`, USAGE);
}

/** 等到可以再发一次：离上一次够 6～10 秒、这一小时没满 200 次；记下这一次 */
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

/** x2 打开知虾标签页时要落在工作台页面上（有 webpackJsonp），不是随便一页 */
export async function ready(): Promise<void> {
	const p = await page(ORIGIN);
	// 首页（/）也有 webpackJsonp，但没有工作台的 store：要在 /workbench/ 下面
	const ok = await p.run(
		() => Boolean((window as any).webpackJsonp) && location.pathname.startsWith("/workbench/") && !location.pathname.startsWith("/workbench/login"),
	);
	if (!ok) await p.goto(`${ORIGIN}/workbench/home`);
}

/** 用页面的 axios 发一个请求，回整个响应体（各接口的外壳不一样：有的在 data，有的在 hotWordList、payload）。
 * path 是 /api/shopee-report-service/pro 之后的一段；siteId 不用给，取页面当前的站点 */
export async function api<T = any>(path: string, params: Record<string, unknown> = {}, method: "get" | "post" = "get"): Promise<T> {
	const body = await hold(ORIGIN, async () => {
		await ready();
		await throttle();
		const p = await page(ORIGIN);
		return p.run(
			async (url: string, params: Record<string, unknown>, method: string) => {
				if (location.pathname.startsWith("/workbench/login")) return { code: 401, msg: "没有登录" };
				const w = window as any;
				if (!w.webpackJsonp) return { code: -1, msg: "页面还没加载好：不是知虾的工作台页面" };
				if (!w.__x2Http) {
					const holder: { req: any } = { req: null };
					const id = `x2-http-${Date.now()}-${Math.random().toString(36).slice(2)}`;
					w.webpackJsonp.push([
						[id],
						{
							[id]: (_m: unknown, _e: unknown, r: any) => {
								holder.req = r;
							},
						},
						[[id]],
					]);
					w.__x2Http = holder.req("b775").a;
				}
				const siteId = document.querySelector<any>("#app")?.__vue__?.$store?.getters?.siteId ?? 1;
				const all = { siteId, ...params };
				return w.__x2Http({ url, method, ...(method === "get" ? { params: all } : { data: all }), validateStatus: () => true });
			},
			`${PRO}${path}`,
			params,
			method,
		);
	});
	const b = body as { code?: number; msg?: string };
	if (b.code === 401 || b.code === 602) throw new NeedsHuman("知虾没有登录（或令牌失效）：在浏览器里登录知虾再试");
	if (b.code !== undefined && Number(b.code) !== 200) throw new Error(`知虾 ${path} 回：${b.code} ${b.msg ?? ""}`);
	return body as T;
}

type Row = Record<string, any>;
/** 类目路径：一级、二级、三级类目 id，例 [100629, 100630]；接口要最后一级的 id 和层数 */
const at = (path: number[]) => (path.length ? { catId: path.at(-1), level: path.length } : {});

// ── 类目 ──

export type Category = { id: string; name: string; children: Category[] };

/** 类目树（三级）。读页面 store 里登录时就载入的 state.user.catList，不发请求 */
export async function categories(): Promise<Category[]> {
	await ready();
	const p = await page(ORIGIN);
	const tree = await p.run(() => {
		const conv = (n: any): any => ({ id: String(n.value), name: String(n.label), children: (n.children ?? []).map(conv) });
		const list = document.querySelector<any>("#app")?.__vue__?.$store?.state?.user?.catList;
		return Array.isArray(list) && list.length ? list.map(conv) : null;
	});
	// 没有类目树就是没登录（或页面没载入工作台）：别当成空的
	if (!tree) throw new NeedsHuman("知虾的工作台没有类目树：在浏览器里登录知虾、打开工作台再试");
	return tree;
}

/** 热销类目榜：path 下一级的各类目，按昨天（DAY）的销量排；path 为空是全站的二级类目（不是一级，2026-10-09 查过） */
export async function sellWell(path: number[] = [], pageNum = 1, pageSize = 100): Promise<{ total: number; rows: Row[] }> {
	const b = await api<{ data: Row[]; total: string }>("/industryAnalysis/sellWell", {
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

/** 一个类目最近 30 天每天的数据（销量、销售额、商品数……） */
export async function categoryDaily(path: number[]): Promise<Row> {
	return (await api<{ data: Row }>("/industryAnalysis/industryInfoOverview", at(path))).data;
}

// ── 热搜词 ──
// 口径（lilto 记下的）：searchVal 是全站的搜索量，sales30day 是本类目 30 天的销量；标题里的片段不等于搜索词

/** 一个类目的热搜词，最多 1000 个；updateTime 是数据的日期 */
export async function hotWords(path: number[]): Promise<{ total: number; updateTime: string | null; rows: Row[] }> {
	const b = await api<{ hotWordList: Row[]; total: string; updateTime?: string }>("/hotWord/hotWordList", {
		field: "",
		orderType: "",
		pageNum: 1,
		pageSize: 1000,
		isBorder: 0,
		...at(path),
	});
	return { total: Number(b.total ?? 0), updateTime: b.updateTime ?? null, rows: b.hotWordList ?? [] };
}

/** 一个词在一个类目里的全部商品（竞品），按 30 天销量（itemDataList[0].sales30Day）从高到低；每个商品带上架时间 ctime。
 * 站点不管 pageNum、pageSize、field、orderType：每次都回全部（2026-10-09：第 1、2 页都是同样的 1680 个，按 itemId 排），
 * 页面自己在浏览器里排序、截前 100 个。所以只发一次，在这里排 */
export async function hotWordItems(hotWordId: number, path: number[]): Promise<{ total: number; rows: Row[] }> {
	const b = await api<{ itemListInfo: Row[]; total: string }>("/hotWordDetail/hotWordItemSalesDetail", {
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

/** 按 30 天销量从高到低排（没有的排最后） */
export const bySales30Day = (rows: Row[]): Row[] => {
	const sales = (r: Row) => Number(r.itemDataList?.[0]?.sales30Day ?? -1) || 0;
	return [...rows].sort((a, b) => sales(b) - sales(a));
};

const word = (hotWordId: number) => ({ hotWordId, updateKey: 1 });
/** 一个词最近 30 天每天的搜索量、销量（charts；顺序不保证，按 timest 排） */
export const demandChange = async (hotWordId: number): Promise<Row> =>
	(await api<{ data: Row }>("/hotWordChopeeProduct/getDemandChange", word(hotWordId))).data;
/** 一个词的竞争环境：商品数、店铺数、集中度…… */
export const competition = async (hotWordId: number): Promise<Row> =>
	(await api<{ data: Row }>("/hotWordChopeeProduct/getCompetitiveEnvironment", word(hotWordId))).data;
/** 一个词的价格带：各价格区间的商品数、销量 */
export const priceLine = async (hotWordId: number): Promise<Row> => (await api<{ data: Row }>("/hotWordChopeeProduct/getPriceLine", word(hotWordId))).data;
/** 买家对这类商品的吐槽点（差评里说得多的） */
export const complaints = async (hotWordId: number): Promise<Row[]> =>
	(await api<{ data: Row[] }>("/hotWordChopeeProduct/tucaoPoint", word(hotWordId))).data ?? [];
/** 买家偏好的规格（颜色、尺寸……） */
export const preferences = async (hotWordId: number): Promise<Row[]> =>
	(await api<{ data: Row[] }>("/hotWordChopeeProduct/preference", word(hotWordId))).data ?? [];
/** 长尾词（参数是小写 w 的 hotwordId，列表在 payload） */
export const longTail = async (hotWordId: number): Promise<Row[]> =>
	(await api<{ payload: Row[] }>("/drainageWords/longTailWords", { hotwordId: hotWordId })).payload ?? [];

// ── 1688 同款 ──

export type Candidate = { offerId: string; url: string; title: string; price: number; monthSold: number; image: string };

/** 用一张图在 1688 上找同款，最多 n 个 */
export async function similar1688(imageUrl: string, n = 4): Promise<Candidate[]> {
	const b = await api<{ data?: any[] }>("/similarProduct/query1688", { imgUrl: imageUrl, beginPage: 1, pageSize: n });
	if (!Array.isArray(b.data)) throw new Error("知虾的 1688 同款没有回列表");
	return b.data.slice(0, n).map((o) => ({
		offerId: String(o.offerId),
		url: `https://detail.1688.com/offer/${o.offerId}.html`,
		title: o.subject ?? "",
		price: Number(o.priceInfo?.price ?? 0),
		monthSold: Number(o.monthSold ?? 0),
		image: o.imageUrl ?? "",
	}));
}

// ── x2 zhixia <操作> ──

const path = ints("类目路径：一级、二级、三级类目 id，逗号分隔，例 100629,100630");
const hotWord = z.object({ word: num("热搜词 id（hot-words 里的）") });

export const ops: Ops = {
	categories: all("类目树（三级）", undefined, () => categories()),
	"sell-well": byPage("热销类目榜：path 下一级的各类目，按昨天的销量排；不给 path 是全站的二级类目", z.object({ path: path.default([]) }), async (p, n) => {
		const r = await sellWell(p.path, n);
		return { rows: r.rows, more: n * 100 < r.total };
	}),
	"category-daily": get("一个类目最近 30 天每天的数据（销量、销售额、商品数……）", z.object({ path }), (p) => categoryDaily(p.path)),
	"hot-words": get("一个类目的热搜词（最多 1000 个）；searchVal 是全站搜索量，sales30day 是本类目 30 天销量", z.object({ path }), (p) => hotWords(p.path)),
	// 站点每次回全部商品、不分页：一次读完（以前按页翻，每页都是同样的全部，翻到底会重复好几遍）
	"hot-word-items": all(
		"一个词在一个类目里的全部商品（竞品），按 30 天销量从高到低",
		z.object({ word: num("热搜词 id"), path }),
		async (p) => (await hotWordItems(p.word, p.path)).rows,
	),
	"demand-change": get("一个词最近 30 天每天的搜索量、销量（按 timest 排）", hotWord, (p) => demandChange(p.word)),
	competition: get("一个词的竞争环境：商品数、店铺数、集中度……", hotWord, (p) => competition(p.word)),
	"price-line": get("一个词的价格带：各价格区间的商品数、销量", hotWord, (p) => priceLine(p.word)),
	complaints: all("买家对这类商品的吐槽点", hotWord, (p) => complaints(p.word)),
	preferences: all("买家偏好的规格（颜色、尺寸……）", hotWord, (p) => preferences(p.word)),
	"long-tail": all("长尾词", hotWord, (p) => longTail(p.word)),
	"similar-1688": all("用一张图在 1688 上找同款", z.object({ image: str("图片地址"), n: num("最多几个").default(4) }), (p) => similar1688(p.image, p.n)),
	raw: get(
		"逃生口：GET 知虾的任一接口（照样限流），回原样的响应体",
		z.object({
			path: str("/api/shopee-report-service/pro 之后的一段，例 /hotWord/hotWordList"),
			params: z.preprocess(parseJson, z.record(z.string(), z.unknown())).default({}).describe("参数，JSON 对象"),
		}),
		(p) => api(p.path, p.params),
	),
};
