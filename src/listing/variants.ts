// 规格：1688 的规格 → Shopee 的规格（最多两层）。照 lilto 的 shopee_listing.py（快照 1c8a7926）：docs/listing.md「规格」。
// 规格名、选项名转台湾繁体（OpenCC s2twp）；只留各规格之间取值不同的层；两层而且组合齐全才留两层，否则合成一层「款式」；
// 选项名最多 20 字、重名的加「-2」；尺寸类的层只留字母码（别把「【M碼】」连括号洗掉）；规格图只挂第一层的选项
import * as OpenCC from "opencc-js";
import type { Offer } from "../site/1688.ts";

let converter: ((s: string) => string) | null = null;
/** 简体 → 台湾繁体，带台湾用词（鼠标 → 滑鼠、软件 → 軟體） */
export const toTw = (s: string) => (converter ??= OpenCC.Converter({ from: "cn", to: "twp" }))(s);

/** 去掉 emoji 和括号里 12 个字以内的说明（【爆款】、(新品)），压掉多余空白 */
export const clean = (s: string) =>
	s.replace(/[☀-➿⬀-⯿\u{1F300}-\u{1FAFF}️]/gu, "").replace(/[【[（(][^】\]）)]{0,12}[】\]）)]/g, "").replace(/\s+/g, " ").trim();

export type Spec = { label: string; value: string };
/** 商品稿的一个规格。sku 是货号（LT<货源 id>-<1688 规格 id>，最多 40 字），订单靠它连回 1688 的规格 */
export type Variant = { sku: string; skuId: string; specId: string; specs: Spec[]; costRmb: number; stock: number; weightKg: number | null; image: string | null };

/** 货源 → 商品稿的规格：只要有货的，只留取值不一样的层，规格名和选项转繁体 */
export function variantsOf(offer: Offer): Variant[] {
	const live = offer.skus.filter((s) => s.stock > 0);
	const varying = offer.props.map((p, i) => ({ p, i })).filter(({ i }) => new Set(live.map((s) => s.attrs[i]).filter(Boolean)).size > 1);
	return live.map((s) => ({
		sku: `LT${offer.offerId}-${s.specId || s.skuId}`.slice(0, 40),
		skuId: s.skuId, specId: s.specId,
		specs: varying.map(({ p, i }) => ({ label: toTw(p.name).slice(0, 14), value: toTw(s.attrs[i] ?? "").trim().slice(0, 20) })).filter((x) => x.label && x.value),
		costRmb: s.price, stock: s.stock, weightKg: s.weightKg ?? null, image: s.image || null,
	}));
}

const SIZE_LABEL = /尺[寸码碼]|size/i;
const SIZE_CODE = /(?<![A-Z])(?:[2-6]XL|X{1,4}[SL]|[SML])(?![A-Z])/g;

/** 一个选项的名字：尺寸类的层只留唯一的字母码（不然只去掉括号），别的去掉括号里的短说明 */
function optionName(label: string, raw: string): string {
	if (!SIZE_LABEL.test(label)) return clean(raw) || raw;
	const sizes = new Set(raw.toUpperCase().match(SIZE_CODE) ?? []);
	return sizes.size === 1 ? [...sizes][0]! : raw.replace(/[【】[\]（）()]/g, "");
}

/** 一层的选项名：最多 maxLen 字，重名的加「-2」「-3」。合成的「款式」层在合成时已经按各层取过名 */
export function uniqueNames(values: string[], maxLen: number, label = ""): Map<string, string> {
	const out = new Map<string, string>(), used = new Set<string>();
	for (const raw of values) {
		if (out.has(raw)) continue;
		const cleaned = label === MERGED ? raw : optionName(label, raw);
		const base = cleaned.replace(/\s+/g, " ").slice(0, maxLen).trim();
		let name = base;
		for (let n = 2; used.has(name); n++) name = base.slice(0, Math.max(1, maxLen - `-${n}`.length)) + `-${n}`;
		used.add(name);
		out.set(raw, name);
	}
	return out;
}

const MERGED = "款式";

/** 两层而且组合齐全（每个 A 都有每个 B）才留两层；一层的照旧；别的合成一层「款式」：每层先各自取名再连起来，
 * 不然尺寸会跟着括号一起洗掉（lilto 的雨衣上过「身高」「身高-2」） */
export function axesOf(variants: Variant[]): Spec[][] {
	const raw = variants.map((v) => v.specs);
	const axes = Math.max(0, ...raw.map((s) => s.length));
	if (axes <= 1) return raw;
	const stable = raw.every((s) => s.length === axes) && [...Array(axes).keys()].every((a) => new Set(raw.map((s) => s[a]!.label)).size === 1);
	if (axes === 2 && stable) {
		const first = new Set(raw.map((s) => s[0]!.value)), second = new Set(raw.map((s) => s[1]!.value));
		const pairs = new Set(raw.map((s) => `${s[0]!.value}\u0000${s[1]!.value}`));
		if (pairs.size === raw.length && pairs.size === first.size * second.size) return raw;
	}
	return raw.map((s, i) => [{ label: MERGED, value: s.map((x) => optionName(x.label, x.value)).filter(Boolean).join(" ") || `${MERGED} ${i + 1}` }]);
}

export type Tier = { name: string; options: { name: string; image: string | null }[] };

/** Shopee 的规格层和每个规格在各层的下标。只有一个规格：单层、空名字（9-01 的成功样本） */
export function tiersOf(variants: Variant[]): { tiers: Tier[]; index: number[][] } {
	if (variants.length === 0) throw new Error("没有有货的规格");
	if (variants.length === 1) return { tiers: [{ name: "", options: [{ name: "", image: null }] }], index: [[0]] };
	const specs = axesOf(variants);
	if (specs.some((s) => s.length === 0)) throw new Error("多规格商品缺规格名称");
	const values = specs[0]!.map((_, a) => [...new Set(specs.map((s) => s[a]!.value))]);
	const tiers = values.map((vs, a): Tier => {
		const names = uniqueNames(vs, 20, specs[0]![a]!.label);
		return {
			name: specs[0]![a]!.label.slice(0, 14),
			options: vs.map((v) => {
				if (a > 0) return { name: names.get(v)!, image: null };
				const imgs = new Set(variants.filter((_, i) => specs[i]![0]!.value === v).map((x) => x.image).filter((x): x is string => Boolean(x)));
				if (imgs.size > 1) throw new Error(`同一个「${v}」下的规格图不一样，定不了这个选项用哪张图`);
				return { name: names.get(v)!, image: [...imgs][0] ?? null };
			}),
		};
	});
	return { tiers, index: specs.map((s) => s.map((x, a) => values[a]!.indexOf(x.value))) };
}
