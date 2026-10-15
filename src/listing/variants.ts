// 规格（docs/listing.md「规格」）：商品稿存着 Shopee 要的规格——层（最多两层，例 款式、尺寸）和规格（每层一个选项的下标），一起存在商品稿的 variants 里。
// 做商品稿时从货源生成一次（specsFrom），以后都改它：写文案的 agent 改名字（renameSpecs），人说了 x2 listing drop 去掉规格（dropSpecs）。
// 核价、组 product_info、Gemini 文字检查、「规格和价格」都只读这一份。认东西靠 1688 的规格 id 和原值（层记着 1688 的层名，选项记着 1688 的原值），
// 名字只是给人看的：重做商品稿时按（1688 层名，原值）把上一版的名字对回去。
// 自动的名字照 lilto 的 shopee_listing.py（快照 1c8a7926）：转台湾繁体（OpenCC s2twp）、去 emoji 和括号里的短说明，
// 尺寸类的层只留字母码（别把「【M碼】」连括号洗掉）；最多 20 字，同一层撞名加「-2」
import * as OpenCC from "opencc-js";
import { z } from "zod";
import type { Offer, Sku } from "../site/1688.ts";

let converter: ((s: string) => string) | null = null;
/** 简体 → 台湾繁体，带台湾用词（鼠标 → 滑鼠、软件 → 軟體） */
export const toTw = (s: string) => (converter ??= OpenCC.Converter({ from: "cn", to: "twp" }))(s);

const EMOJI = /[☀-➿⬀-⯿\u{1F300}-\u{1FAFF}️]/gu;
/** 去掉 emoji 和括号里 12 个字以内的说明（【爆款】、(新品)），压掉多余空白 */
export const clean = (s: string) => s.replace(EMOJI, "").replace(/[【[（(][^】\]）)]{0,12}[】\]）)]/g, "").replace(/\s+/g, " ").trim();

const tierOption = z.object({
	source: z.string(), // 1688 的原值（转繁体前的原文）；合成的「款式」是各层的原值连起来
	name: z.string(),
	image: z.string().nullable().optional(), // 规格图：1688 的图片地址，只第一层有
});
const tier = z.object({
	source: z.string(), // 1688 的层名；合成的「款式」是各层的层名连起来
	name: z.string(),
	options: z.array(tierOption),
});
const variant = z.object({
	sku: z.string().min(1), // 货号：LT<货源 id>-<1688 规格 id>（最多 40 字），订单靠它连回 1688 的规格
	skuId: z.string(),
	specId: z.string(),
	options: z.array(z.number().int()), // 每层一个选项的下标
	costRmb: z.number(),
	stock: z.number(),
	weightKg: z.number().nullable(),
	priceTwd: z.number().nullable(), // 核价出的售价（台币）；缺重量、缺国内运费的是 null
});
/** 商品稿的规格：层和规格一起存，就是 Shopee 的 std_tier_variation_list 和 model_list */
export const specsSchema = z.object({ tiers: z.array(tier), variants: z.array(variant) });
export type TierOption = z.infer<typeof tierOption>;
export type Tier = z.infer<typeof tier>;
export type Variant = z.infer<typeof variant>;
export type Specs = z.infer<typeof specsSchema>;

/** 存着的规格。旧的格式（规格的数组，选项名每次现算）认不出，回 null：要重做商品稿 */
export const specsOf = (raw: unknown): Specs | null => specsSchema.safeParse(raw).data ?? null;
export const OLD_SPECS = "规格：旧格式，待重做商品稿（x2 listing make）";

/** 只有一个规格的商品：单层、空名字（9-01 的成功样本），不写规格名 */
export const isSingle = (s: Specs) => s.variants.length === 1 && s.tiers.length === 1 && s.tiers[0]!.options.length === 1 && !s.tiers[0]!.name && !s.tiers[0]!.options[0]!.name;

/** 货号：LT<货源 id>-<1688 规格 id>，最多 40 字 */
export const skuOf = (offerId: string, s: Sku) => `LT${offerId}-${s.specId || s.skuId}`.slice(0, 40);

export const MERGED = "款式";
/** 合成「款式」时，各层的层名、原值用它连起来 */
const JOIN = " / ";
const MAX_TIER = 14, MAX_OPTION = 20, MAX_VARIANTS = 50;

const SIZE_LABEL = /尺[寸码碼]|size/i;
const SIZE_CODE = /(?<![A-Z])(?:[2-6]XL|X{1,4}[SL]|[SML])(?![A-Z])/g;

/** 一个选项的自动名字（value 已转繁体）：尺寸类的层只留唯一的字母码（不然只去掉括号），别的去掉括号里的短说明 */
function optionName(label: string, value: string): string {
	const v = value.replace(EMOJI, "");
	if (!SIZE_LABEL.test(label)) return clean(v) || v.trim();
	const sizes = new Set(v.toUpperCase().match(SIZE_CODE) ?? []);
	return sizes.size === 1 ? [...sizes][0]! : v.replace(/[【】[\]（）()]/g, "").replace(/\s+/g, " ").trim();
}

/** 一层的名字：上一版有的照用（kept），没有的用自动的（auto，截到 max 字），同一层撞名加「-2」「-3」；空的用 fallback */
function uniqueNames(auto: string[], kept: (string | undefined)[], max: number, fallback: (k: number) => string): string[] {
	const used = new Set<string>();
	const out = auto.map((_, k) => {
		const n = kept[k];
		if (!n || used.has(n)) return null;
		used.add(n);
		return n;
	});
	return auto.map((a, k) => {
		const n = out[k];
		if (n) return n;
		const base = (a.replace(/\s+/g, " ").trim() || fallback(k)).slice(0, max).trim();
		let name = base;
		for (let i = 2; used.has(name); i++) name = `${base.slice(0, Math.max(1, max - `-${i}`.length)).trimEnd()}-${i}`;
		used.add(name);
		return name;
	});
}

/** 按每层的下标排，第一层优先 */
const compare = (x: number[], y: number[]) => {
	for (let a = 0; a < Math.max(x.length, y.length); a++) if ((x[a] ?? -1) !== (y[a] ?? -1)) return (x[a] ?? -1) - (y[a] ?? -1);
	return 0;
};

/** 货源 → 商品稿的规格：有货的、没移除的（removed：货号）规格 → 只留取值不一样的层 → 两层而且组合齐全才留两层，否则合成一层「款式」
 * → 起名字：prev 是上一版，按（1688 层名，原值）把名字对回去，新的选项自动起。售价留给核价。problems：要人处理的（规格图定不了） */
export function specsFrom(offer: Offer, removed: Iterable<string> = [], prev: Specs | null = null): { specs: Specs; problems: string[] } {
	const gone = new Set(removed);
	const live = offer.skus.filter((s) => s.stock > 0 && !gone.has(skuOf(offer.offerId, s)));
	const variant = (s: Sku, options: number[]): Variant => ({ sku: skuOf(offer.offerId, s), skuId: s.skuId, specId: s.specId, options, costRmb: s.price, stock: s.stock, weightKg: s.weightKg ?? null, priceTwd: null });
	if (live.length <= 1) return { specs: { tiers: live.length ? [{ source: "", name: "", options: [{ source: "", name: "", image: null }] }] : [], variants: live.map((s) => variant(s, [0])) }, problems: [] };

	const value = (s: Sku, i: number) => (s.attrs[i] ?? "").trim();
	const layers = offer.props.map((_, i) => i).filter((i) => new Set(live.map((s) => value(s, i))).size > 1);
	const props = layers.map((i) => ({ source: offer.props[i]!.name.trim(), label: clean(toTw(offer.props[i]!.name)) }));
	// 每层的取值照 1688 列的顺序，没列出的排在后面
	const values = layers.map((i) => {
		const listed = (offer.props[i]!.values ?? []).map((v) => v.name.trim());
		const seen = [...new Set(live.map((s) => value(s, i)))];
		const rank = (v: string) => (listed.includes(v) ? listed.indexOf(v) : listed.length + seen.indexOf(v));
		return seen.sort((a, b) => rank(a) - rank(b));
	});
	const at = (s: Sku) => layers.map((i, a) => values[a]!.indexOf(value(s, i)));
	const sorted = [...live].sort((x, y) => compare(at(x), at(y)));
	const cells = new Set(sorted.map((s) => at(s).join(",")));
	const grid = layers.length >= 1 && layers.length <= 2 && live.every((s) => layers.every((i) => value(s, i)))
		&& cells.size === live.length && cells.size === values.reduce((n, v) => n * v.length, 1);
	const before = new Map((prev?.tiers ?? []).map((t) => [t.source, t]));
	const keptName = (t: string, o: string) => before.get(t)?.options.find((x) => x.source === o)?.name;
	const problems: string[] = [];

	if (!grid) {
		// 合成一层「款式」：一个组合一个选项。每层先各自起名再连起来，不然尺寸会跟着括号一起洗掉（lilto 的雨衣上过「身高」「身高-2」）
		const source = props.map((p) => p.source).join(JOIN);
		const sources = sorted.map((s) => layers.map((i) => value(s, i)).filter(Boolean).join(JOIN) || s.specId || s.skuId);
		const auto = sorted.map((s) => layers.map((i, a) => optionName(props[a]!.label, toTw(value(s, i)))).filter(Boolean).join(" "));
		const names = uniqueNames(auto, sources.map((o) => keptName(source, o)), MAX_OPTION, (k) => `${MERGED} ${k + 1}`);
		const options = sorted.map((s, k): TierOption => ({ source: sources[k]!, name: names[k]!, image: s.image || null }));
		return { specs: { tiers: [{ source, name: before.get(source)?.name || MERGED, options }], variants: sorted.map((s, k) => variant(s, [k])) }, problems };
	}

	const labels = uniqueNames(props.map((p) => p.label), props.map((p) => before.get(p.source)?.name), MAX_TIER, (a) => `規格${a + 1}`);
	const tiers = props.map((p, a): Tier => {
		const names = uniqueNames(values[a]!.map((v) => optionName(p.label, toTw(v))), values[a]!.map((v) => keptName(p.source, v)), MAX_OPTION, (k) => `${labels[a]} ${k + 1}`);
		return {
			source: p.source, name: labels[a]!,
			options: values[a]!.map((v, k): TierOption => {
				if (a > 0) return { source: v, name: names[k]! };
				// 规格图只挂第一层；同一个选项下 1688 的图不一样，定不了用哪张
				const imgs = new Set(sorted.filter((s) => at(s)[0] === k).map((s) => s.image).filter(Boolean));
				if (imgs.size > 1) problems.push(`规格：「${names[k]}」下的规格图不一样，定不了这个选项用哪张图`);
				return { source: v, name: names[k]!, image: imgs.size === 1 ? [...imgs][0]! : null };
			}),
		};
	});
	return { specs: { tiers, variants: sorted.map((s) => variant(s, at(s))) }, problems };
}

/** 两层时缺的组合（第一层、第二层的下标） */
const missingCells = (s: Specs): [number, number][] => {
	if (s.tiers.length !== 2) return [];
	const have = new Set(s.variants.map((v) => v.options.join(",")));
	return s.tiers[0]!.options.flatMap((_, i) => s.tiers[1]!.options.map((_, j): [number, number] => [i, j])).filter((c) => !have.has(c.join(",")));
};
const cellName = (s: Specs, options: number[]) => options.map((k, a) => s.tiers[a]?.options[k]?.name ?? "?").join(" × ");
const cellsText = (s: Specs, cells: number[][]) => `${cells.slice(0, 3).map((c) => `「${cellName(s, c)}」`).join("、")}${cells.length > 3 ? ` 等 ${cells.length} 个` : ""}`;

/** 规格的结构对不对（Shopee 的规矩、x2 认规格靠的规矩），错在哪层哪个选项写清楚。存之前、组 product_info 之前都核一遍 */
export function structureProblems(s: Specs): string[] {
	const { tiers, variants } = s;
	if (!variants.length) return ["规格：无有货的规格"];
	if (tiers.length < 1 || tiers.length > 2) return [`规格：${tiers.length} 层，要 1–2 层`];
	const p: string[] = [];
	const single = isSingle(s);
	const tierAt = (a: number) => `第 ${a + 1} 层${tiers[a]!.name.trim() ? `「${tiers[a]!.name}」` : ""}`;
	const optionAt = (a: number, k: number) => `${tierAt(a)}第 ${k + 1} 个选项${tiers[a]!.options[k]!.name.trim() ? `「${tiers[a]!.options[k]!.name}」` : ""}`;
	tiers.forEach((t, a) => {
		if (!t.options.length) p.push(`规格：${tierAt(a)}没有选项`);
		if (a > 0) t.options.forEach((o, k) => { if (o.image) p.push(`规格：${optionAt(a, k)}有规格图，规格图只挂第一层`); });
		if (single) return;
		if (!t.name.trim()) p.push(`规格：第 ${a + 1} 层缺层名`);
		else if (t.name.length > MAX_TIER) p.push(`规格：${tierAt(a)}的层名 ${t.name.length} 字，最多 ${MAX_TIER} 字`);
		const same = new Map<string, number[]>();
		t.options.forEach((o, k) => {
			if (!o.name.trim()) p.push(`规格：${optionAt(a, k)}缺名字`);
			else if (o.name.length > MAX_OPTION) p.push(`规格：${optionAt(a, k)} ${o.name.length} 字，最多 ${MAX_OPTION} 字`);
			else same.set(o.name, [...(same.get(o.name) ?? []), k + 1]);
		});
		for (const [name, ks] of same) if (ks.length > 1) p.push(`规格：${tierAt(a)}的第 ${ks.join("、")} 个选项都叫「${name}」，同一层不能重名`);
	});
	if (!single && tiers.length === 2 && tiers[0]!.name.trim() && tiers[0]!.name === tiers[1]!.name) p.push(`规格：两层都叫「${tiers[0]!.name}」`);
	const skus = new Set<string>(), cells = new Map<string, string>(), used = tiers.map((t) => t.options.map(() => 0));
	let indexed = true;
	for (const v of variants) {
		if (skus.has(v.sku)) p.push(`规格：货号 ${v.sku} 重复`);
		skus.add(v.sku);
		if (v.options.length !== tiers.length) { p.push(`规格：规格 ${v.sku} 有 ${v.options.length} 个选项下标，要每层一个（${tiers.length} 个）`); indexed = false; continue; }
		const bad = v.options.findIndex((k, a) => !(k >= 0 && k < tiers[a]!.options.length));
		if (bad >= 0) { p.push(`规格：规格 ${v.sku} 在${tierAt(bad)}的选项下标 ${v.options[bad]} 不存在（这一层有 ${tiers[bad]!.options.length} 个选项）`); indexed = false; continue; }
		v.options.forEach((k, a) => { used[a]![k]!++; });
		const cell = v.options.join(","), other = cells.get(cell);
		if (other) p.push(`规格：规格 ${other} 和 ${v.sku} 是同一格（${cellName(s, v.options)}）`);
		else cells.set(cell, v.sku);
	}
	used.forEach((counts, a) => counts.forEach((n, k) => { if (!n) p.push(`规格：${optionAt(a, k)}没有规格`); }));
	const missing = indexed ? missingCells(s) : [];
	if (missing.length) p.push(`规格：两层的组合不齐，缺${cellsText(s, missing)}（两层要每个组合都有，不然合成一层「款式」）`);
	return p;
}

/** 规格的上限（核价以后算，没过的写成问题给人）：最高价不超过最低价 5 倍，最多 50 个 */
export function limitProblems(s: Specs): string[] {
	const p: string[] = [];
	const prices = s.variants.map((v) => v.priceTwd).filter((x): x is number => x !== null);
	if (prices.length && Math.max(...prices) > Math.min(...prices) * 5) p.push("规格：最高价超过最低价的 5 倍，Shopee 不收（去掉太贵或太便宜的规格，或分成两个商品）");
	if (s.variants.length > MAX_VARIANTS) p.push(`规格：有货的规格 ${s.variants.length} 个，最多 ${MAX_VARIANTS} 个`);
	return p;
}

/** 规格的全部问题：结构和上限 */
export const specsProblems = (s: Specs) => [...structureProblems(s), ...limitProblems(s)];

/** agent 交的规格名：每层的层名和选项名，个数、顺序照 x2 listing show */
export const tierNames = z.array(z.object({ name: z.string(), options: z.array(z.string()) }));
export type TierNames = z.infer<typeof tierNames>;

/** 改规格名（第几层第几个选项，不按字配）：回改好名字的规格；交得不对回问题，规格不变 */
export function renameSpecs(s: Specs, names: TierNames): { specs?: Specs; problems: string[] } {
	if (isSingle(s)) return names.length ? { problems: ["规格名：单规格的商品不写规格名（tiers 交 []）"] } : { specs: s, problems: [] };
	if (names.length !== s.tiers.length) return { problems: [`规格名：要 ${s.tiers.length} 层（照 x2 listing show），交了 ${names.length} 层`] };
	const counts = s.tiers.flatMap((t, a) => (names[a]!.options.length === t.options.length ? [] : [`规格名：第 ${a + 1} 层「${t.name}」要 ${t.options.length} 个选项名，交了 ${names[a]!.options.length} 个`]));
	if (counts.length) return { problems: counts };
	const tidy = (x: string) => x.replace(/\s+/g, " ").trim();
	const specs: Specs = { ...s, tiers: s.tiers.map((t, a) => ({ ...t, name: tidy(names[a]!.name), options: t.options.map((o, k) => ({ ...o, name: tidy(names[a]!.options[k]!) })) })) };
	const problems = structureProblems(specs);
	return problems.length ? { problems } : { specs, problems };
}

/** 两层合成一层「款式」：一个组合一个选项，名字是两层的名字连起来（最多 20 字，撞名加「-2」），原值是两层的原值连起来，规格图照第一层的 */
export function mergeTiers(s: Specs): Specs {
	if (s.tiers.length !== 2) return s;
	const [t0, t1] = s.tiers as [Tier, Tier];
	const sorted = [...s.variants].sort((x, y) => compare(x.options, y.options));
	const pick = (v: Variant) => [t0.options[v.options[0]!]!, t1.options[v.options[1]!]!] as const;
	const names = uniqueNames(sorted.map((v) => pick(v).map((o) => o.name).join(" ")), [], MAX_OPTION, (k) => `${MERGED} ${k + 1}`);
	return {
		tiers: [{ source: `${t0.source}${JOIN}${t1.source}`, name: MERGED, options: sorted.map((v, k) => ({ source: pick(v).map((o) => o.source).join(JOIN), name: names[k]!, image: pick(v)[0].image ?? null })) }],
		variants: sorted.map((v, k) => ({ ...v, options: [k] })),
	};
}

/** 去掉人不要的：整个选项（选项名；两层有同名的写成「层名:选项名」）或一个规格（货号）。去掉单个规格让两层的组合不齐时不做，
 * 除非 merge（合成一层「款式」）。回去掉以后的规格、去掉的货号；做不了回 error */
export function dropSpecs(s: Specs, args: string[], merge = false): { specs: Specs; skus: string[]; merged: boolean } | { error: string } {
	const bySku = new Set<string>(), picked: [number, number][] = [], unknown: string[] = [];
	for (const arg of args) {
		if (s.variants.some((v) => v.sku === arg)) { bySku.add(arg); continue; }
		const m = /^(.+?)[:：](.+)$/.exec(arg);
		const a = m ? s.tiers.findIndex((t) => t.name === m[1]!.trim()) : -1;
		const hits = a >= 0
			? s.tiers[a]!.options.flatMap((o, k): [number, number][] => (o.name === m![2]!.trim() ? [[a, k]] : []))
			: s.tiers.flatMap((t, b) => t.options.flatMap((o, k): [number, number][] => (o.name === arg ? [[b, k]] : [])));
		if (!hits.length) unknown.push(arg);
		else if (hits.length > 1) return { error: `两层都有「${arg}」：写成「层名:选项名」（${hits.map(([b]) => `${s.tiers[b]!.name}:${arg}`).join(" 或 ")}）` };
		else picked.push(hits[0]!);
	}
	if (unknown.length) return { error: `规格里没有：${unknown.join("、")}（选项名照 x2 listing show；两层有同名的写成「层名:选项名」；单个规格写货号）` };
	const drop = new Set(s.variants.filter((v) => bySku.has(v.sku) || picked.some(([a, k]) => v.options[a] === k)).map((v) => v.sku));
	const left = s.variants.filter((v) => !drop.has(v.sku));
	if (!left.length) return { error: "规格都去掉了：不上这个货源就在「商品稿」里勾「放弃」" };
	// 没有规格了的选项去掉，下标跟着重排
	const keep = s.tiers.map((t, a) => t.options.map((_, k) => left.some((v) => v.options[a] === k)));
	const index = keep.map((ks) => { let n = 0; return ks.map((x) => (x ? n++ : -1)); });
	let specs: Specs = {
		tiers: s.tiers.map((t, a) => ({ ...t, options: t.options.filter((_, k) => keep[a]![k]) })),
		variants: left.map((v) => ({ ...v, options: v.options.map((k, a) => index[a]![k]!) })),
	};
	const missing = missingCells(specs);
	if (missing.length && !merge) {
		const whole = [...new Set(s.variants.filter((v) => bySku.has(v.sku)).flatMap((v) => v.options.map((k, a) => `${s.tiers[a]!.name}:${s.tiers[a]!.options[k]!.name}`)))];
		return { error: `去掉以后两层的组合不齐（缺${cellsText(specs, missing)}）：要么去掉整个选项（例 ${whole.slice(0, 4).join("、")}），要么人说了加 --merge 合成一层「款式」` };
	}
	if (missing.length) specs = mergeTiers(specs);
	return { specs, skus: s.variants.filter((v) => drop.has(v.sku)).map((v) => v.sku), merged: missing.length > 0 };
}

const money = (p: number | null) => (p === null ? "未定价" : `NT$${p}`);
const kg = (w: number | null) => (w === null ? "缺重量" : `${w} kg`);

/** 一个数跟着哪层变：都一样（same）、只跟着第几层、两层都影响（both） */
function follows(s: Specs, f: (v: Variant) => string): "same" | "both" | number {
	if (new Set(s.variants.map(f)).size <= 1) return "same";
	const a = s.tiers.findIndex((_, a) => {
		const seen = new Map<number, string>();
		return s.variants.every((v) => {
			const k = v.options[a]!, x = f(v);
			if (!seen.has(k)) seen.set(k, x);
			return seen.get(k) === x;
		});
	});
	return a >= 0 ? a : "both";
}

/** 「规格和价格」（给人看）：按层写，数字由代码算。价格、重量只跟着一层变的，写在那一层的选项后面；两层都影响的，第一层每个选项一行；
 * 都一样的写「各 N」。removed：已移除的（removedOf） */
export function specsText(s: Specs, removed: { name: string; count: number }[] = []): string {
	const lines: string[] = [];
	if (!s.variants.length) lines.push("无有货的规格");
	else if (isSingle(s)) {
		const v = s.variants[0]!;
		lines.push(`单规格：${money(v.priceTwd)}，库存 ${v.stock}，${kg(v.weightKg)}`);
	} else {
		const price = follows(s, (v) => money(v.priceTwd)), weight = follows(s, (v) => kg(v.weightKg));
		if (price === "both" || weight === "both") {
			// 两层都影响：第一层每个选项一行，写第二层每个选项的价格、重量
			const [t0, t1] = s.tiers as [Tier, Tier];
			lines.push(`${t0.name}（${t0.options.length}）× ${t1.name}（${t1.options.length}）：`);
			t0.options.forEach((o, i) => {
				const cells = t1.options.flatMap((o1, j) => {
					const v = s.variants.find((x) => x.options[0] === i && x.options[1] === j);
					return v ? [[o1.name, price === "same" ? "" : money(v.priceTwd), weight === "same" ? "" : kg(v.weightKg)].filter(Boolean).join(" ")] : [];
				});
				lines.push(`${o.name}：${cells.join(" · ")}`);
			});
		} else s.tiers.forEach((t, a) => {
			const items = t.options.map((o, k) => {
				const v = s.variants.find((x) => x.options[a] === k);
				return [o.name, v && price === a ? money(v.priceTwd) : "", v && weight === a ? kg(v.weightKg) : ""].filter(Boolean).join(" ");
			});
			lines.push(`${t.name}（${t.options.length}）：${items.join(price === a || weight === a ? " · " : "、")}`);
		});
		const stocks = s.variants.map((v) => v.stock), low = Math.min(...stocks), high = Math.max(...stocks);
		lines.push([
			`共 ${s.variants.length} 个规格`, price === "same" ? `售价各 ${money(s.variants[0]!.priceTwd)}` : "",
			low === high ? `库存各 ${low}` : `库存 ${low}–${high}`, weight === "same" ? `重量各 ${kg(s.variants[0]!.weightKg)}` : "",
		].filter(Boolean).join("，"));
	}
	if (removed.length) lines.push(`已移除：${removed.map((r) => `${r.name}（${r.count} 个规格）`).join("、")}`);
	return lines.join("\n");
}

/** 规格表（网页上给人看）：每层的名字；一个规格一行（每层的选项、规格图、进价、售价、库存、重量、货号），按选项排；已移除的 */
export type SpecsTable = {
	tiers: string[];
	rows: { options: string[]; image: string | null; costRmb: number; priceTwd: number | null; stock: number; weightKg: number | null; sku: string }[];
	removed: { name: string; count: number }[];
};

/** image：第一层选项的 1688 图片地址 → 给人看的地址（传好了是 Shopee 的） */
export function specsTable(s: Specs, removed: { name: string; count: number }[], image: (from: string) => string | null): SpecsTable {
	const rows = [...s.variants].sort((x, y) => x.options.reduce((d, o, a) => d || o - (y.options[a] ?? 0), 0)).map((v) => {
		const first = s.tiers[0]?.options[v.options[0] ?? -1];
		return {
			options: v.options.map((o, a) => s.tiers[a]?.options[o]?.name ?? ""), image: first?.image ? image(first.image) : null,
			costRmb: v.costRmb, priceTwd: v.priceTwd, stock: v.stock, weightKg: v.weightKg, sku: v.sku,
		};
	});
	return { tiers: s.tiers.map((t) => t.name), rows, removed };
}

/** 已移除的规格（货号）→ 给人看的：整个取值都移除了的（例 定製 的每个尺寸）写这个取值，别的写各层的取值；名字照 1688 的转繁体 */
export function removedOf(offer: Offer | null | undefined, removed: string[] | null | undefined): { name: string; count: number }[] {
	if (!offer?.skus || !removed?.length) return [];
	const gone = new Set(removed);
	const isGone = (s: Sku) => gone.has(skuOf(offer.offerId, s));
	const value = (s: Sku, i: number) => (s.attrs[i] ?? "").trim();
	const tw = (v: string) => clean(toTw(v)) || toTw(v);
	let left = offer.skus.filter(isGone);
	const out = new Map<string, number>();
	const add = (name: string, n: number) => out.set(name, (out.get(name) ?? 0) + n);
	offer.props.forEach((_, i) => {
		for (const v of new Set(left.map((s) => value(s, i)).filter(Boolean))) {
			const all = offer.skus.filter((s) => value(s, i) === v);
			// 每个规格都有的取值（这一层只有它）不算；没移除的都没货了也算整个移除了
			if (all.length === offer.skus.length || !all.every((s) => isGone(s) || s.stock <= 0)) continue;
			const mine = left.filter((s) => value(s, i) === v);
			add(tw(v), mine.length);
			left = left.filter((s) => !mine.includes(s));
		}
	});
	for (const s of left) add(s.attrs.map((v) => v.trim()).filter(Boolean).map(tw).join(" ") || s.specId || s.skuId, 1);
	return [...out].map(([name, count]) => ({ name, count }));
}

/** 一组规格的售价范围（x2 listing show 用）：NT$133、NT$133–253；没定价的写未定价 */
export function priceRange(variants: Variant[]): string {
	const prices = variants.map((v) => v.priceTwd);
	if (!prices.length || prices.some((p) => p === null)) return "未定价";
	const low = Math.min(...(prices as number[])), high = Math.max(...(prices as number[]));
	return low === high ? `NT$${low}` : `NT$${low}–${high}`;
}
