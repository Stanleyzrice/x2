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
	規: "规",
	製: "制",
};
const COLORS = "金银黑白红蓝绿黄灰粉紫棕咖橙";
const UNITS = "cm|mm|kg|ml|g|l|m|管|寸|码|号|个|只|件|层|米|片|套|包|斤|克";

const simple = (s: string) =>
	[...s]
		.map((c) => T2S[c] ?? c)
		.join("")
		.toLowerCase();
const squash = (s: string) =>
	simple(s.normalize("NFKC"))
		.replace(/(?<=\d)\s*[x×*]\s*(?=\d)/g, "×")
		.replace(/[\s,，/>（）()【】[\]:：+_·、|。]+/g, "");

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

export const sameName = (a: string, b: string) =>
	squash(a) === squash(b) &&
	numbers(a)
		.map((n) => n.n)
		.join("|") ===
		numbers(b)
			.map((n) => n.n)
			.join("|");

export function exceptionFor(spec: string, exceptions: string | null | undefined): string | undefined {
	for (const line of (exceptions ?? "").split("\n")) {
		const i = line.indexOf("=");
		if (i > 0 && sameName(line.slice(0, i), spec || "（单规格）")) return line.slice(i + 1).trim();
	}
	return undefined;
}

const attributes = (name: string, attrs?: readonly string[]) => (attrs?.length ? attrs : name.split(/[,，/＞>;；]/)).map((a) => a.trim()).filter(Boolean);
const sameAttributes = (a: string[], b: string[]) => {
	if (a.length !== b.length) return false;
	const left = [...b];
	for (const value of a) {
		const i = left.findIndex((other) => sameName(value, other));
		if (i < 0) return false;
		left.splice(i, 1);
	}
	return a.length > 0;
};
const dimension = (text: string) => {
	const source = simple(text);
	const values = [...source.matchAll(/(?<![\d.])(\d+(?:\.\d+)?(?:\s*[x×*]\s*\d+(?:\.\d+)?){1,})(?:\s*(cm|mm|m))?(?![\d.a-z])/g)];
	if (values.length !== 1) return null;
	const value = values[0]!;
	const before = source.slice(0, value.index),
		after = source.slice(value.index + value[0].length);
	if (/\d\s*[-–—~～至到]\s*$/.test(before) || /^\s*[-–—~～至到]\s*\d/.test(after) || /^[a-z\u4e00-\u9fff]/i.test(after.trimStart())) return null;
	const valuesInOrder = value[1]!.split(/\s*[x×*]\s*/).map(Number);
	if (!valuesInOrder.every((n) => Number.isFinite(n) && n > 0)) return null;
	return { text: value[0].trim(), numbers: valuesInOrder, unit: value[2] ?? "" };
};
type Dimension = NonNullable<ReturnType<typeof dimension>>;
const sameDimension = (a: Dimension, b: Dimension) =>
	a.numbers.length === b.numbers.length && a.numbers.every((n, i) => n === b.numbers[i]) && (!a.unit || !b.unit || a.unit === b.unit);
const kind = (text: string, steel = false) => simple(text.normalize("NFKC")).match(steel ? /^(?:钢制-?)?(加厚|常规)(?:款)?$/ : /^(加厚|常规)(?:款)?$/)?.[1];

/** 仅解释完整尺寸链与独立明确款式；其他订单属性不能被忽略。供应商附带营销字不参与匹配。 */
function dimensionStyle(parts: string[], source = false) {
	const d = dimension(parts.join(" / "));
	if (!d) return null;
	const labels = parts
		.flatMap((part) => [part, ...[...part.matchAll(/[【[(]([^】\])]+)[】\])]/g)].map((m) => m[1]!)])
		.map((label) => kind(label, source))
		.filter((value) => value !== undefined);
	const kinds = new Set(labels);
	if (kinds.size !== 1) return null;
	const style = labels[0]!;
	if (source) {
		const text = simple(parts.join(" / "));
		if (/(?:非|不)(?:加厚|常规)/.test(text) || [...text.matchAll(/加厚|常规/g)].some((m) => m[0] !== style)) return null;
	} else if (
		parts.length !== 2 ||
		!parts.some((part) => simple(part).replace(/\s/g, "") === d.text.replace(/\s/g, "")) ||
		!parts.some((part) => kind(part) === style)
	)
		return null;
	return { ...d, style };
}

export function matchSku<T extends { name: string; attrs?: readonly string[] }>(spec: string, skus: readonly T[], exceptions?: string | null): T | null {
	const named = (exceptions ?? "").split("\n").flatMap((line) => {
		const i = line.indexOf("=");
		return i > 0 && sameName(line.slice(0, i), spec || "（单规格）") ? [line.slice(i + 1).trim()] : [];
	});
	if (named.length) {
		if (named.some((name) => !sameName(name, named[0]!))) return null;
		const found = skus.filter((s) => sameName(s.name, named[0]!));
		return found.length === 1 ? found[0]! : null;
	}
	if (!spec.trim()) return skus.length === 1 && !skus[0]!.name.trim() ? skus[0]! : null;
	const parts = attributes(spec);
	const shape = dimensionStyle(parts);
	const found = skus.filter((sku) => {
		const theirs = attributes(sku.name, sku.attrs);
		if (sameName(spec, sku.name) || sameAttributes(parts, theirs)) return true;
		const other = shape ? dimensionStyle(theirs, true) : null;
		return Boolean(shape && other && shape.style === other.style && sameDimension(shape, other));
	});
	// 同尺寸但无法解释的复合款式仍是潜在竞争项，不能静默排除后制造唯一结果。
	if (
		shape &&
		found.length === 1 &&
		skus.some((sku) => {
			const theirs = attributes(sku.name, sku.attrs),
				d = dimension(theirs.join(" / "));
			return d && sameDimension(shape, d) && !dimensionStyle(theirs, true);
		})
	)
		return null;
	return found.length === 1 ? found[0]! : null;
}

/** 人写的规格例外「店里的规格名 = 货源的规格名」：两边都要对得上（繁简、空格不算）；同一个店里的规格写过的换掉。回新的规格例外 */
export function addException<T extends { name: string }>(
	text: string,
	sold: string[],
	source: { title: string; skus: readonly T[]; exceptions: string | null },
): { spec: string; sku: string; exceptions: string } | { error: string } {
	const i = text.indexOf("=");
	if (i <= 0) return { error: `--spec 写成「店里的规格名 = 货源的规格名」：${text}` };
	const spec = text.slice(0, i).trim(),
		named = text.slice(i + 1).trim();
	const mine = sold.find((s) => sameName(s || "（单规格）", spec));
	if (mine === undefined) return { error: `最近 60 天卖过的规格里没有「${spec}」。卖过的：${sold.map((s) => s || "（单规格）").join("、")}` };
	const matching = source.skus.filter((k) => sameName(k.name, named));
	if (matching.length > 1) return { error: `货源「${source.title}」里有多个同名规格「${named}」，请先核对具体 SKU` };
	const sku = matching[0];
	if (!sku)
		return {
			error: `货源「${source.title}」里没有「${named}」。最像的：${rank(mine, source.skus)
				.slice(0, 5)
				.map((k) => k.name)
				.join("、")}`,
		};
	const left = mine || "（单规格）";
	const lines = String(source.exceptions ?? "")
		.split("\n")
		.filter((l) => l.trim() && exceptionFor(mine, l) === undefined);
	return { spec: left, sku: sku.name, exceptions: [...lines, `${left} = ${sku.name}`].join("\n") };
}
