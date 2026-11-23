import * as OpenCC from "opencc-js";
import { type Image, model } from "../../connectors/services/gemini/api.ts";
import { type Bytes, fetchImage, inspect } from "../../connectors/services/image/api.ts";
import { BATCH } from "../../connectors/services/xiangji/api.ts";
import { uploadImages } from "../../connectors/sites/shopee/products.ts";
import type { Sql } from "../../platform/db/index.ts";
import type { ImageMode, Mark, Pic, Pics, Verdict } from "./pics.ts";
import { detailFits, MAX_DETAIL, MAX_MAIN } from "./product.ts";
import { download, geminiJson, limiter, once, type Runner } from "./queue.ts";
import { SCREEN_VERSION, screen } from "./screen.ts";
import { saveTranslation, translate, translationState } from "./translations.ts";
import { markKey, watermark } from "./watermark.ts";

const fetched = new Map<string, Promise<Bytes>>();
export async function original(sql: Sql, url: string, options?: Pick<RequestInit, "redirect">): Promise<Bytes> {
	const key = options?.redirect ? `${options.redirect}:${url}` : url;
	let got = fetched.get(key);
	if (!got) {
		got = download(() => fetchImage(url, options));
		fetched.set(key, got);
		got.catch(() => fetched.delete(key));
	}
	const b = await got;
	await sql`insert into images ${sql({ sha256: b.sha256, kind: "原图", source: url, mime: b.mime, width: b.width, height: b.height })} on conflict (sha256) do nothing`;
	return b;
}

function screened(sql: Sql, b: Bytes): Promise<{ verdict: Verdict; simplified?: boolean }> {
	const key = `筛字:${SCREEN_VERSION}:${model()}`;
	return once(`${key}:${b.sha256}`, async () => {
		const [row] = await sql`select checks->${key} as c from images where sha256 = ${b.sha256}`;
		if (row?.c) return row.c;
		const r = await screen(b);
		const c = { verdict: r.verdict, ...(r.simplified === undefined ? {} : { simplified: r.simplified }) };
		await sql`update images set verdict = ${r.verdict}, checks = checks || ${sql.json({ [key]: c })} where sha256 = ${b.sha256}`;
		return c;
	});
}

// 译图检查：分两次问 Gemini。第一问只给译图：后加的文案还有没有简体字（象寄漏译的，和简转繁选错的字，例 易干 → 易幹）；
// 两张一起给时，模型会把原图的字当成译图上的。默认模型也分不清繁简（会把繁体当简体），所以先让它照抄译图上的字，
// 它说的简体字、错字由代码用 OpenCC 把关：要在它抄的字里，而且真是简体、真是同一个简体字选错了繁体（不是异体字、不是换了说法）。
// 第二问给原图和译图：商品本体上印的字有没有被象寄改动（象寄的接口没有「商品上的字不译」的选项，一张图上两样都有时它会连商品上的字一起改，
// 照片里的商品就和买家收到的不一样了）。只取 productText；照抄、简体字、错字这几栏照样问、不用：只问商品上的字时，模型把圆圈里的标签也当成商品上的字。
// 任何一样有，这张不用
export const TRANSLATED_VERSION = 2;
export const TRANSLATED_TEXT_PROMPT = `这是一张电商详情图，图上的简体中文刚由象寄译成繁体。只返回JSON：
text：图上后加的文案（标题、卖点、说明、参数、标签、角标），一段一段照图上的原样抄，不要顺手改字；商品本体上印的字不抄。
simplified：text 里还是简体的字所在的词（例 「工艺」的「艺」是简体，繁体是「藝」）。繁简写法一样的字不算（例 打理方便、科技）；繁体、日文、英文、数字不算。没有则[]。
wrong：text 里简转繁选错的字所在的词：同一个简体字对应几个繁体字，按意思选错了（例 「易干」是容易乾，要写成「易乾」，写成「易幹」是错的）。每条写「错的词 → 对的词」，两边只差选错的字；异体字（例 汙和污、裡和裏）、用词的不同、英文、数字、符号都不算。没有则[]。
数组为空才算没有。`;
export const TRANSLATED_PRODUCT_PROMPT = `第一张是原图，第二张是译图（要上架的图）：象寄把原图上的简体中文译成繁体，得到第二张。只返回JSON：
text：第二张（译图）上后加的文案（标题、卖点、说明、参数、标签、角标），一段一段照第二张上的原样抄；不要抄第一张，不要顺手改字，商品本体上印的字不抄。
simplified：text 里还是简体的字所在的词（例 「工艺」的「艺」是简体，繁体是「藝」）。繁简写法一样的字不算（例 打理方便、科技）；繁体、日文、英文、数字不算。没有则[]。
wrong：text 里简转繁选错的字所在的词：同一个简体字对应几个繁体字，按意思选错了（例 「易干」是容易乾，要写成「易乾」，写成「易幹」是错的）。每条写「错的词 → 对的词」，两边只差选错的字；异体字（例 汙和污、裡和裏）、用词的不同、英文、数字、符号都不算。没有则[]。
productText：商品本体上印的字被象寄改动的地方，每处写「原图的字 → 译图的字」（被涂掉写「原图的字 → 涂掉」，字没变、被重画的写「原图的字 → 重画」）。商品本体上印的字是印在实物表面、跟着实物的形状和材质走的字：地垫印花图案里的字、瓶身标签、包装印刷、表盘铭牌。后加在图上的圆圈、方框、色块里的说明标签、角标、标题不是商品本体，它们译成繁体是对的，不要列。商品上的字和原图一模一样（字、字体、位置都没变）则[]。
数组为空才算没有。`;
const strings = (keys: readonly string[]) => ({
	type: "object",
	properties: Object.fromEntries(keys.map((k) => [k, { type: "array", items: { type: "string" } }])),
	required: keys,
});
const TEXT_FIELDS = ["text", "simplified", "wrong"] as const;
const PRODUCT_FIELDS = [...TEXT_FIELDS, "productText"] as const;
export type TranslatedCheck = Record<(typeof PRODUCT_FIELDS)[number], string[]>;

let cc: { traditional: ((s: string) => string)[]; simplified: (s: string) => string; variant: ((s: string) => string)[] } | null = null;
const opencc = () =>
	(cc ??= {
		traditional: (["t", "tw", "hk"] as const).map((to) => OpenCC.Converter({ from: "cn", to })),
		simplified: OpenCC.Converter({ from: "t", to: "cn" }),
		variant: [OpenCC.Converter({ from: "t", to: "tw" }), OpenCC.Converter({ from: "tw", to: "t" })],
	});
const hasSimplified = (w: string) => opencc().traditional.every((f) => f(w) !== w);
const misconverted = (a: string, b: string) =>
	a !== b && opencc().simplified(a) === opencc().simplified(b) && !opencc().variant.some((f) => f(a) === b || f(b) === a);
const han = (s: string) => [...s].filter((c) => /\p{Script=Han}/u.test(c));

export function translatedDrop(c: TranslatedCheck): string | null {
	const bare = (s: string) => s.replace(/\s/g, "");
	const seen = bare(c.text.join(""));
	const on = (w: string) => bare(w) !== "" && seen.includes(bare(w));
	const simplified = c.simplified.filter((w) => on(w) && hasSimplified(w));
	const wrong = c.wrong.filter((x) => {
		const [a = "", b = ""] = x.split(/→|->/).map((t) => t.trim());
		const p = han(a),
			q = han(b),
			diff = p.map((ch, i) => [ch, q[i] ?? ""] as const).filter(([u, v]) => u !== v);
		return on(a) && p.length === q.length && diff.length > 0 && diff.every(([u, v]) => misconverted(u, v));
	});
	const product = c.productText.map((x) => x.trim()).filter(Boolean);
	const why = [
		product.length ? `象寄改了商品上印的字：${product.join("、")}` : "",
		simplified.length ? `译图还有简体字：${simplified.join("、")}` : "",
		wrong.length ? `译图有转错的字：${wrong.join("、")}` : "",
	].filter(Boolean);
	return why.join("；") || null;
}

export async function checkTranslated(original: Image, translated: Image): Promise<TranslatedCheck> {
	const [t, p] = await Promise.all([
		geminiJson<Pick<TranslatedCheck, (typeof TEXT_FIELDS)[number]>>(TRANSLATED_TEXT_PROMPT, [translated], strings(TEXT_FIELDS)),
		geminiJson<TranslatedCheck>(TRANSLATED_PRODUCT_PROMPT, [original, translated], strings(PRODUCT_FIELDS)),
	]);
	return { text: t.text, simplified: t.simplified, wrong: t.wrong, productText: p.productText };
}

function translatedChecked(sql: Sql, original: Bytes, translated: string): Promise<TranslatedCheck> {
	const key = `译图检查:${TRANSLATED_VERSION}:${model()}`;
	return once(`${key}:${translated}`, async () => {
		const [seen] = await sql`select checks->${key} as c from images where sha256 = ${translated}`;
		if (seen?.c) return seen.c;
		const [row] = await sql`select bytes from images where sha256 = ${translated}`;
		const c = await checkTranslated(original, inspect(new Uint8Array(row!.bytes), "译图"));
		await sql`update images set checks = checks || ${sql.json({ [key]: c })} where sha256 = ${translated}`;
		return c;
	});
}

export async function finish(
	sql: Sql,
	shop: string,
	mark: Mark | null,
	p: Pic,
	base: Bytes,
	browser: Runner,
	minWidth = 0,
	upload = uploadImages,
): Promise<void> {
	if (!mark) return finishOriginal(sql, shop, p, base, browser, upload);
	const key = markKey(mark, minWidth);
	const done = await once(`成品:${shop}:${key}:${base.sha256}`, async () => {
		const [hit] = await sql`select f.sha256, s.image_id, s.width, s.height from images f join shop_images s on s.sha256 = f.sha256 and s.shop = ${shop}
			where f.kind = '成品' and f.from_sha = ${base.sha256} and f.source = ${key} order by s.uploaded_at desc limit 1`;
		if (hit) return { final: hit.sha256 as string, imageId: hit.image_id as string, width: hit.width as number, height: hit.height as number };
		const { out, id } = await browser(async () => {
			const out = await watermark(base, mark, minWidth);
			const [id] = await upload([{ base64: Buffer.from(out.bytes).toString("base64"), mime: out.mime }]);
			return { out, id: id! };
		});
		await sql`insert into images ${sql({ sha256: out.sha256, kind: "成品", source: key, from_sha: base.sha256, mime: out.mime, width: out.width, height: out.height })} on conflict (sha256) do nothing`;
		await sql`insert into shop_images ${sql({ shop, sha256: out.sha256, image_id: id, width: out.width, height: out.height })} on conflict (shop, sha256) do update set image_id = excluded.image_id, uploaded_at = now()`;
		return { final: out.sha256, imageId: id, width: out.width, height: out.height };
	});
	Object.assign(p, done);
}

/** 原图上传输入保留来源字节和格式；Shopee 的上传服务仍可能做平台压缩。 */
export const originalImageUpload = (base: Bytes) => ({
	file: { base64: Buffer.from(base.bytes).toString("base64"), mime: base.mime },
	final: base.sha256,
	width: base.width,
	height: base.height,
});

async function finishOriginal(sql: Sql, shop: string, p: Pic, base: Bytes, browser: Runner, upload = uploadImages): Promise<void> {
	const done = await once(`原图:${shop}:${base.sha256}`, async () => {
		const [hit] = await sql<{ image_id: string; width: number; height: number }[]>`select image_id, width, height from shop_images
			where shop = ${shop} and sha256 = ${base.sha256} order by uploaded_at desc limit 1`;
		if (hit) return { final: base.sha256, imageId: hit.image_id, width: hit.width, height: hit.height };
		const { file, ...identity } = originalImageUpload(base);
		const [imageId] = await browser(() => upload([file]));
		if (!imageId) throw new Error("原图上传没有返回图片 id");
		await sql`insert into shop_images ${sql({ shop, sha256: base.sha256, image_id: imageId, width: base.width, height: base.height })}
			on conflict (shop, sha256) do update set image_id = excluded.image_id, uploaded_at = now()`;
		return { ...identity, imageId };
	});
	Object.assign(p, done);
}

export async function unmarked(sql: Sql, pics: Partial<Pics>, id: string): Promise<Bytes> {
	const p = [...(pics.main ?? []), ...(pics.detail ?? []), ...(pics.options ?? [])].find((x) => x.imageId === id);
	if (!p) throw new Error(`图 ${id} 不在商品稿的图里：重做商品稿（x2 listing make）`);
	if (p.review) {
		const [row] = await sql`select bytes from images where sha256 = ${p.review.processedSha256}`;
		if (!row?.bytes) throw new Error("已审图片的处理文件未保存，请重新导入");
		const bytes = inspect(new Uint8Array(row.bytes), "已审处理图");
		if (bytes.sha256 !== p.review.processedSha256) throw new Error("已审图片的处理文件 SHA 已变化");
		return bytes;
	}
	if (!p.translated && p.sha) {
		const [cached] = await sql`select source, bytes from images where sha256 = ${p.sha}`;
		if (cached?.bytes) {
			const saved = inspect(new Uint8Array(cached.bytes), "已保存的原图");
			if (saved.sha256 === p.sha) return saved;
		}
		if (typeof cached?.source === "string" && /^(https?:|data:)/.test(cached.source) && cached.source !== p.from) {
			const saved = await original(sql, cached.source).catch(() => null);
			if (saved?.sha256 === p.sha) return saved;
		}
	}
	if (!p.translated) return original(sql, p.from);
	const [row] = await sql`select bytes from images where sha256 = ${p.translated}`;
	if (!row?.bytes) throw new Error(`库里没有译图 ${p.translated.slice(0, 12)} 的字节：重做商品稿（x2 listing make）`);
	return inspect(new Uint8Array(row.bytes), "译图");
}

async function translateNow(sql: Sql, items: { sha: string; url: string }[]): Promise<void> {
	for (let i = 0; i < items.length; i += BATCH) await translate(sql, items.slice(i, i + BATCH)).catch((e: Error) => console.error(`译图：${e.message}`));
}

const translating = new Map<string, Promise<void>>();
const deciding = limiter(1);

/** 处理图只把合规比例的窄详情等比放到700；原图照原尺寸校验，不救占位图或坏比例。 */
export function detailImagePlan(width: number, height: number, imageMode: ImageMode) {
	if (width <= 10 || height <= 10 || width / height < 0.5 || width / height > 32) return null;
	const minWidth = imageMode === "processed" && width < 700 ? 700 : 0;
	const finalWidth = Math.max(width, minWidth),
		finalHeight = Math.round((height * finalWidth) / width);
	if (!detailFits(finalWidth, finalHeight)) return null;
	if (imageMode === "processed" && (width * height > 40_000_000 || finalWidth * finalHeight > 40_000_000)) return null;
	return { minWidth, width: finalWidth, height: finalHeight };
}

export async function makeImages(
	sql: Sql,
	c: { shop: string; mark: Mark | null; main: string[]; detail: string[]; options: string[]; browser: Runner; imageMode?: ImageMode },
	log: (s: string) => void = console.error,
): Promise<Pics> {
	const imageMode = c.imageMode ?? "processed";
	if (imageMode === "reviewed") throw new Error("已审图片须通过 listing reviewed-images 导入，不能按普通取图流程处理");
	if (imageMode === "processed" && !c.mark) throw new Error("处理图片模式缺少水印设置");
	const pics: Pics = {
		imageMode,
		main: c.main.map((from) => ({ from })),
		detail: c.detail.map((from) => ({ from })),
		options: [...new Set(c.options)].map((from) => ({ from })),
	};
	const bytes = new Map<string, Bytes>();
	const all = [...pics.main, ...pics.detail, ...pics.options];

	log(`${imageMode === "original" ? "取原图、检查尺寸" : "取图、筛字"}（${all.length} 张）`);
	await Promise.all(
		all.map(async (p) => {
			try {
				const b = await original(sql, p.from);
				Object.assign(p, { sha: b.sha256, width: b.width, height: b.height });
				bytes.set(b.sha256, b);
			} catch (e) {
				p.drop = `取不到：${(e as Error).message}`;
				return;
			}
			if (p.width! <= 10 || p.height! <= 10) {
				p.drop = `占位图（${p.width}×${p.height}）`;
				return;
			}
			if (pics.detail.includes(p) && !detailImagePlan(p.width!, p.height!, imageMode)) {
				p.drop = `详情图尺寸不合 Shopee 的要求（${p.width}×${p.height}：宽 ≥ 700、高 ≥ 32、宽高比 0.5–32）`;
				return;
			}
			if (imageMode === "original") return;
			const s = await screened(sql, bytes.get(p.sha!)!).catch((e: Error) => {
				p.drop = `筛字出错：${e.message}`;
				return null;
			});
			if (!s) return;
			Object.assign(p, s);
			if (s.verdict === "d") p.drop = "有供应商痕迹或写给 1688 买家的说明（工厂、批发、联系方式、人民币价、售后、定制……）";
		}),
	);

	const toTranslate = imageMode === "original" ? [] : all.filter((p) => !p.drop && (p.verdict === "m" || (p.verdict === "r" && p.simplified)));
	const shas = [...new Set(toTranslate.map((p) => p.sha!))];
	if (shas.length) {
		let job = null as Promise<void> | null;
		const { fresh, others } = await deciding(async () => {
			const state = await translationState(sql, shas);
			const others = [...new Set(shas.flatMap((s) => (translating.has(s) ? [translating.get(s)!] : [])))];
			const fresh = shas.filter((s) => (!state.has(s) || state.get(s)?.retryable) && !translating.has(s));
			if (fresh.length) {
				job = translateNow(
					sql,
					fresh.map((s) => ({ sha: s, url: toTranslate.find((p) => p.sha === s)!.from })),
				);
				const settled = job.then(
					() => {},
					() => {},
				);
				for (const s of fresh) translating.set(s, settled);
				void settled.then(() => {
					for (const s of fresh) if (translating.get(s) === settled) translating.delete(s);
				});
			}
			return { fresh, others };
		});
		if (job) {
			log(`交象寄译图（${fresh.length} 张）`);
			await job;
		}
		await Promise.all(others);
		let state = await translationState(sql, shas);
		await Promise.all(
			shas.map(async (s) => {
				const t = state.get(s);
				if (t && !t.saved && t.url) await download(() => saveTranslation(sql, s, t.url!)).catch((e) => log(`取译图：${(e as Error).message}`));
			}),
		);
		state = await translationState(sql, shas);
		await Promise.all(
			toTranslate.map(async (p) => {
				const t = state.get(p.sha!);
				if (t?.saved) {
					const [row] = await sql`select sha256 from images where kind = '译图' and from_sha = ${p.sha!} limit 1`;
					p.translated = row!.sha256;
				} else if (t?.failed) p.drop = `象寄译不成：${t.failed}`;
				else p.drop = "还没译好";
			}),
		);
		const check = toTranslate.filter((p) => p.translated && !p.drop);
		if (check.length) log(`检查译图（${new Set(check.map((p) => p.translated)).size} 张）`);
		await Promise.all(
			check.map(async (p) => {
				const c = await translatedChecked(sql, bytes.get(p.sha!)!, p.translated!).catch((e: Error) => {
					p.drop = `译图检查出错：${e.message}`;
					return null;
				});
				const why = c && translatedDrop(c);
				if (why) p.drop = why;
			}),
		);
	}

	const use = (list: Pic[], max: number) => list.filter((p) => !p.drop).slice(0, max);
	const keep = [...use(pics.main, MAX_MAIN), ...use(pics.detail, MAX_DETAIL), ...pics.options.filter((p) => !p.drop)];
	log(`${imageMode === "original" ? "上传原图" : "加水印、传图"}（${keep.length} 张）`);
	await Promise.all(
		keep.map(async (p) => {
			let base = bytes.get(p.sha!)!;
			if (imageMode === "original") {
				await finishOriginal(sql, c.shop, p, base, c.browser);
				return;
			}
			if (p.translated) {
				const [row] = await sql`select bytes from images where sha256 = ${p.translated}`;
				base = inspect(new Uint8Array(row!.bytes), "译图");
			}
			await finish(sql, c.shop, c.mark!, p, base, c.browser, pics.detail.includes(p) && base.width < 700 ? 700 : 0);
		}),
	);
	for (const p of [...pics.main, ...pics.detail]) if (!p.drop && !p.imageId && !keep.includes(p)) p.drop = "超过张数，不用";
	return pics;
}
