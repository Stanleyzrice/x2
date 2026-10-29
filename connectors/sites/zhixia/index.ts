// x2 zhixia <工具>：知虾（Shopee 的数据平台）的读工具
import { z } from "zod";
import { all, byPage, get, ints, num, parseJson, str, type Toolkit } from "../../../platform/tool.ts";
import {
	api,
	categories,
	categoryDaily,
	competition,
	complaints,
	demandChange,
	hotWordItems,
	hotWords,
	longTail,
	preferences,
	priceLine,
	sellWell,
	similar1688,
} from "./api.ts";

const path = ints("类目路径：一级、二级、三级类目 id，逗号分隔，例 100629,100630");
const hotWord = z.object({ word: num("热搜词 id（hot-words 里的）") });

const tools = {
	categories: all("类目树（三级）", undefined, () => categories()),
	"sell-well": byPage("热销类目榜：path 下一级的各类目，按昨天的销量排；不给 path 是全站的二级类目", z.object({ path: path.default([]) }), async (p, n) => {
		const r = await sellWell(p.path, n);
		return { rows: r.rows, more: n * 100 < r.total };
	}),
	"category-daily": get("一个类目最近 30 天每天的数据（销量、销售额、商品数……）", z.object({ path }), (p) => categoryDaily(p.path)),
	"hot-words": get("一个类目的热搜词（最多 1000 个）；searchVal 是全站搜索量，sales30day 是本类目 30 天销量", z.object({ path }), (p) => hotWords(p.path)),
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

export const zhixia: Toolkit = {
	name: "zhixia",
	title: "知虾（Shopee 的数据平台；限流：每次隔 6～10 秒、每小时 200 次）",
	kind: "site",
	tools,
	site: {
		key: "zhixia",
		title: "知虾",
		origin: "https://shopee.mobduos.com",
		hosts: (h) => h === "shopee.mobduos.com",
		// 读得到类目树就是登录着（知虾不给账号）
		login: {
			identify: async () => {
				await categories();
				return { id: "zhixia", name: "知虾" };
			},
		},
	},
};
