import { Converter } from "opencc-js";
import { z } from "zod";
import { zhixia } from "../../connectors/sites/zhixia/index.ts";
import { get, runReadTool } from "../../platform/tool.ts";
import type { PriceBandSource, PriceBandWord } from "../../platform/ui/interactable/selection/price-band-data.ts";
import { categoryPaths } from "./runs.ts";

const read = (name: "categories" | "hot-words" | "hot-word-items", input: Record<string, unknown> = {}) =>
	runReadTool(`zhixia.${name}`, zhixia.tools[name], { ...input, expectedSiteId: 1 });

const simplify = Converter({ from: "t", to: "cn" });
const wordKey = (word: string) => simplify(word.normalize("NFKC").replace(/\s+/g, "").toLowerCase());
const wordSchema = z.object({ hotWordId: z.number().int().positive(), word: z.string() });
const dateSchema = z.iso.date();
const itemSchema = z.object({
	itemId: z.union([z.string(), z.number()]),
	itemName: z.string().nullish(),
	shopId: z.union([z.string(), z.number()]).nullish(),
	siteId: z.union([z.string(), z.number()]).nullish(),
	minPrice: z.unknown(),
	maxPrice: z.unknown(),
	itemDataList: z.array(z.object({ sales30Day: z.unknown(), timest: z.unknown() })).nullish(),
});

function numeric(value: unknown): number | null {
	if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

export function priceBandSource(keyword: string, raw: unknown[]): PriceBandSource {
	const unique = new Map<string, z.output<typeof itemSchema>>();
	for (const row of raw) {
		const parsed = itemSchema.safeParse(row);
		if (parsed.success && (parsed.data.siteId == null || Number(parsed.data.siteId) === 1)) {
			const id = String(parsed.data.itemId);
			if (!unique.has(id)) unique.set(id, parsed.data);
		}
	}
	const candidates = [...unique.values()].map((item) => {
		const snapshot = item.itemDataList?.[0];
		const date = dateSchema.safeParse(String(snapshot?.timest ?? "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"));
		const sales = numeric(snapshot?.sales30Day);
		const price = numeric(item.minPrice);
		return {
			date: date.success && sales !== null && Number.isSafeInteger(sales) && sales >= 0 ? date.data : null,
			price: price !== null && price > 0 && price === numeric(item.maxPrice) ? price : null,
			sales,
			title: item.itemName ?? "",
			shop: item.shopId == null || !/^\d+$/.test(String(item.shopId)) || Number(item.shopId) <= 0 ? null : String(item.shopId),
		};
	});
	const date = candidates.reduce<string | null>((latest, row) => (row.date && (!latest || row.date > latest) ? row.date : latest), null);
	const dated = candidates.filter((row) => date !== null && row.date === date);
	return {
		kind: "samples",
		keyword,
		date,
		received: unique.size,
		dated: dated.length,
		rows: dated.flatMap(({ price, sales, title, shop }) => (price === null || sales === null ? [] : [{ price, sales, title, shop }])),
	};
}

export const priceBandCategories = get("读取知虾台湾站类目，供价格带限定比较范围", undefined, async () => categoryPaths(await read("categories")));

const input = z.object({
	path: z.array(z.number().int().positive()).min(1).max(3).describe("知虾类目路径"),
	keyword: z.string().trim().min(1).max(120),
	wordId: z.number().int().positive().optional().describe("用户选中的知虾原生词编号"),
});

export const priceBand = get("查询知虾台湾站近30天价格带样本，只读取关键词和竞品", input, async ({ path, keyword, wordId }) => {
	let word: PriceBandWord | undefined = wordId === undefined ? undefined : { hotWordId: wordId, word: keyword };
	if (!word) {
		const { rows } = z.object({ rows: z.array(wordSchema) }).parse(await read("hot-words", { path }));
		const key = wordKey(keyword);
		const exact = rows.filter((row) => wordKey(row.word) === key);
		if (exact.length === 1) word = exact[0];
		if (!word) {
			const nearby = rows.filter((row) => {
				const candidate = wordKey(row.word);
				return key.length >= 2 && candidate.length >= 2 && (candidate.includes(key) || key.includes(candidate));
			});
			return { kind: "words", words: [...new Map([...exact, ...nearby].map((row) => [row.hotWordId, row])).values()].slice(0, 8) } as const;
		}
	}
	const { rows } = z.object({ rows: z.array(z.unknown()) }).parse(await read("hot-word-items", { path, word: word.hotWordId }));
	return priceBandSource(word.word, rows);
});
