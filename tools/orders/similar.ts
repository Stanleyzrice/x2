// 店里的规格名和货源的规格名比较：排序用的分数，和「缺」了什么（先例 Google 搜索结果下的「缺少字词」）。
// 中文没有空格，按相邻两个字（bigram）比，不按词。数字和颜色是区分规格的关键（150 和 120、金和白），店里有、对方没有的列出来并扣分。
// Shopee 台湾的规格名是繁体，1688 是简体：先转成简体再比

const T2S: Record<string, string> = {
	貓: "猫",
	藍: "蓝",
	黃: "黄",
	綠: "绿",
	紅: "红",
	銀: "银",
	墊: "垫",
	雙: "双",
	層: "层",
	網: "网",
	輪: "轮",
	鋼: "钢",
	鐵: "铁",
	門: "门",
	衛: "卫",
	間: "间",
	傢: "家",
	臟: "脏",
	號: "号",
	條: "条",
	張: "张",
	個: "个",
	裝: "装",
	組: "组",
	淺: "浅",
	寬: "宽",
	長: "长",
	圓: "圆",
	側: "侧",
	單: "单",
	顏: "颜",
	碼: "码",
	開: "开",
	擴: "扩",
	燈: "灯",
	輕: "轻",
	櫃: "柜",
	盤: "盘",
	爐: "炉",
	鍋: "锅",
	蓋: "盖",
	掛: "挂",
	鉤: "钩",
	釦: "扣",
	環: "环",
	風: "风",
	萬: "万",
	兩: "两",
	對: "对",
	夾: "夹",
	縫: "缝",
	納: "纳",
	絲: "丝",
};
const COLORS = "金银黑白红蓝绿黄灰粉紫棕咖橙";
const UNITS = "cm|mm|kg|ml|g|l|m|管|寸|码|号|个|只|件|层|米|片|套|包|斤|克";

const simple = (s: string) =>
	[...s]
		.map((c) => T2S[c] ?? c)
		.join("")
		.toLowerCase();
const squash = (s: string) => simple(s).replace(/[\s,，/>*×xX（）()【】[\]:：+\-—_·、|。.]+/g, "");

function bigrams(s: string): Set<string> {
	const t = squash(s);
	if (t.length < 2) return new Set(t ? [t] : []);
	return new Set([...t].slice(1).map((c, i) => t[i] + c));
}

const numbers = (s: string) => [...simple(s).matchAll(new RegExp(`(\\d+(?:\\.\\d+)?)(${UNITS})?`, "g"))].map((m) => ({ n: m[1]!, text: m[0] }));
const colors = (s: string) => [...new Set([...simple(s)].filter((c) => COLORS.includes(c)))];

export type Compared = { score: number; missing: string[] };

export function compare(mine: string, theirs: string): Compared {
	const a = bigrams(mine),
		b = bigrams(theirs);
	const shared = [...a].filter((g) => b.has(g)).length;
	const theirNumbers = new Set(numbers(theirs).map((x) => x.n));
	const theirColors = colors(theirs);
	const missing = [
		...new Set(
			numbers(mine)
				.filter((x) => !theirNumbers.has(x.n))
				.map((x) => x.text),
		),
		...colors(mine).filter((c) => !theirColors.includes(c)),
	];
	return { score: (a.size ? shared / a.size : 0) - 0.25 * missing.length, missing };
}

export function rank<T extends { name: string }>(mine: string, items: readonly T[]): (T & Compared)[] {
	return items.map((it) => ({ ...it, ...compare(mine, it.name) })).sort((x, y) => y.score - x.score);
}

export const sameName = (a: string, b: string) => squash(a) === squash(b);

export function exceptionFor(spec: string, exceptions: string | null | undefined): string | undefined {
	for (const line of (exceptions ?? "").split("\n")) {
		const i = line.indexOf("=");
		if (i > 0 && sameName(line.slice(0, i), spec || "（单规格）")) return line.slice(i + 1).trim();
	}
	return undefined;
}

export function matchSku<T extends { name: string }>(spec: string, skus: readonly T[], exceptions?: string | null): T | null {
	const named = exceptionFor(spec, exceptions);
	if (named !== undefined) return skus.find((s) => sameName(s.name, named)) ?? null;
	if (skus.length === 1 && (!spec || !skus[0]!.name)) return skus[0]!;
	const ok = rank(spec, skus).filter((s) => s.missing.length === 0 && (!spec || s.score >= 0.5));
	if (ok.length === 1 || (ok.length > 1 && ok[0]!.score - ok[1]!.score >= 0.2)) return skus.find((s) => s.name === ok[0]!.name) ?? null;
	return null;
}
