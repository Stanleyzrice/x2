// 一份商品稿的图（docs/listing.md「图」）：收图 → 取字节、量尺寸、剔掉占位图 → 筛字（Gemini）→ 要译的交象寄（写入「译图」）
// → 译图检查（Gemini 分两次问）→ 本店水印 → 看成品（Gemini）→ 传 Shopee。都按字节的 sha256 记在 images、shop_images 表里：重跑不重复付钱、不重复传。
// 在这家店的浏览器里跑（水印在页面的 canvas 里画，传图用页面的 UploadService）
import * as OpenCC from "opencc-js";
import { type Sql } from "../db/index.ts";
import { run } from "../run.ts";
import { geminiJson, type Image, model } from "../service/gemini.ts";
import { type Bytes, fetchImage, inspect } from "../service/image.ts";
import { uploadImages } from "../site/shopee/products.ts";
import { saveTranslation, translationState } from "../site/writes.ts";
import { detailFits, MAX_DETAIL, MAX_MAIN } from "./product.ts";
import { SCREEN_VERSION, screen, type Verdict } from "./screen.ts";
import { type Mark, markKey, watermark } from "./watermark.ts";

/** 一张图走到哪了。drop 是不用它的原因（给人看） */
export type Pic = { from: string; sha?: string; verdict?: Verdict; simplified?: boolean; translated?: string; final?: string; imageId?: string; width?: number; height?: number; drop?: string };
export type Pics = { main: Pic[]; detail: Pic[]; options: Pic[] };

const CHECK_VERSION = 2;

/** 原图：取字节，记一行（来源、宽高）；同一个进程里取过的不再取 */
const fetched = new Map<string, Bytes>();
async function original(sql: Sql, url: string): Promise<Bytes> {
	let b = fetched.get(url);
	if (!b) { b = await fetchImage(url); fetched.set(url, b); }
	await sql`insert into images ${sql({ sha256: b.sha256, kind: "原图", source: url, mime: b.mime, width: b.width, height: b.height })} on conflict (sha256) do nothing`;
	return b;
}

/** 筛字，按「筛字:版本:模型」记在这张图上 */
async function screened(sql: Sql, b: Bytes): Promise<{ verdict: Verdict; simplified?: boolean }> {
	const key = `筛字:${SCREEN_VERSION}:${model()}`;
	const [row] = await sql`select checks->${key} as c from images where sha256 = ${b.sha256}`;
	if (row?.c) return row.c;
	const r = await screen(b);
	const c = { verdict: r.verdict, ...(r.simplified === undefined ? {} : { simplified: r.simplified }) };
	await sql`update images set verdict = ${r.verdict}, checks = checks || ${sql.json({ [key]: c })} where sha256 = ${b.sha256}`;
	return c;
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
const strings = (keys: readonly string[]) => ({ type: "object", properties: Object.fromEntries(keys.map((k) => [k, { type: "array", items: { type: "string" } }])), required: keys });
const TEXT_FIELDS = ["text", "simplified", "wrong"] as const;
const PRODUCT_FIELDS = [...TEXT_FIELDS, "productText"] as const;
/** 译图检查的结果：text、simplified、wrong 来自第一问（只看译图），productText 来自第二问（比原图和译图） */
export type TranslatedCheck = Record<(typeof PRODUCT_FIELDS)[number], string[]>;

let cc: { traditional: ((s: string) => string)[]; simplified: (s: string) => string; variant: ((s: string) => string)[] } | null = null;
const opencc = () => (cc ??= {
	traditional: (["t", "tw", "hk"] as const).map((to) => OpenCC.Converter({ from: "cn", to })),
	simplified: OpenCC.Converter({ from: "t", to: "cn" }),
	variant: [OpenCC.Converter({ from: "t", to: "tw" }), OpenCC.Converter({ from: "tw", to: "t" })],
});
/** 词里有简体字：三种繁体（OpenCC 标准、台湾、香港）都要改它。台湾也用的字（台、群）、异体字不算 */
const hasSimplified = (w: string) => opencc().traditional.every((f) => f(w) !== w);
/** 两个字是简转繁选错：同一个简体字的两个繁体字（幹、乾 都是 干），又不是台湾的异体字（汙、污） */
const misconverted = (a: string, b: string) => a !== b && opencc().simplified(a) === opencc().simplified(b) && !opencc().variant.some((f) => f(a) === b || f(b) === a);
const han = (s: string) => [...s].filter((c) => /\p{Script=Han}/u.test(c));

/** 译图检查的结果 → 不用这张的原因；没问题回 null。简体字、错字要在模型抄的字里，还要过 OpenCC 这一关 */
export function translatedDrop(c: TranslatedCheck): string | null {
	const bare = (s: string) => s.replace(/\s/g, "");
	const seen = bare(c.text.join(""));
	const on = (w: string) => bare(w) !== "" && seen.includes(bare(w));
	const simplified = c.simplified.filter((w) => on(w) && hasSimplified(w));
	const wrong = c.wrong.filter((x) => {
		const [a = "", b = ""] = x.split(/→|->/).map((t) => t.trim());
		const p = han(a), q = han(b), diff = p.map((ch, i) => [ch, q[i] ?? ""] as const).filter(([u, v]) => u !== v);
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

/** 译图检查：分两次问 Gemini（简体字、错字只给译图；商品上印的字给原图和译图） */
export async function checkTranslated(original: Image, translated: Image): Promise<TranslatedCheck> {
	const [t, p] = await Promise.all([
		geminiJson<Pick<TranslatedCheck, (typeof TEXT_FIELDS)[number]>>(TRANSLATED_TEXT_PROMPT, [translated], strings(TEXT_FIELDS)),
		geminiJson<TranslatedCheck>(TRANSLATED_PRODUCT_PROMPT, [original, translated], strings(PRODUCT_FIELDS)),
	]);
	return { text: t.text, simplified: t.simplified, wrong: t.wrong, productText: p.productText };
}

/** 译图检查，按「译图检查:版本:模型」记在译图那一行 */
async function translatedChecked(sql: Sql, original: Bytes, translated: string): Promise<TranslatedCheck> {
	const key = `译图检查:${TRANSLATED_VERSION}:${model()}`;
	const [seen] = await sql`select checks->${key} as c from images where sha256 = ${translated}`;
	if (seen?.c) return seen.c;
	const [row] = await sql`select bytes from images where sha256 = ${translated}`;
	const c = await checkTranslated(original, inspect(new Uint8Array(row!.bytes), "译图"));
	await sql`update images set checks = checks || ${sql.json({ [key]: c })} where sha256 = ${translated}`;
	return c;
}

const FINAL_PROMPT = (mark: string) => `检查这张零售上架图片。只返回JSON：watermarkVisible（指定本店水印是否可见）、supplierMarksAbsent（是否没有明确的供应商身份或采购促销）、readable（图片和说明是否清楚可读）、supplierMarks（命中的供应商身份或采购促销的具体原文数组，没有则[]）。
指定本店水印是我们主动添加的，不属于供应商标记，绝不把它列入supplierMarks。
供应商标记仅指明确的工厂/供应商公司或店铺名称、电话网址二维码等联系方式、工厂直供/批发/代发等采购用语、人民币低价促销。
商品品牌、商标、产品本体和包装文字、英文商品宣传、参数尺码表可以保留。仅有品牌字样而无供应商身份依据时，不能当作供应商公司或店名；普通零售卖点和笼统温馨提示也不是采购促销。
先逐一抄录符合上述定义的供应商原文，再确定supplierMarksAbsent，数组为空才为true。指定本店水印：${mark}`;
const FINAL_SCHEMA = {
	type: "object",
	properties: { watermarkVisible: { type: "boolean" }, supplierMarksAbsent: { type: "boolean" }, readable: { type: "boolean" }, supplierMarks: { type: "array", items: { type: "string" } } },
	required: ["watermarkVisible", "supplierMarksAbsent", "readable", "supplierMarks"],
};
type Final = { watermarkVisible: boolean; supplierMarksAbsent: boolean; readable: boolean; supplierMarks: string[] };

/** 看成品（照 lilto 第 2 版提示：先抄出供应商原文，数组为空才算没有；本店水印不算） */
async function finalCheck(b: Bytes, mark: string): Promise<Final> {
	return geminiJson<Final>(FINAL_PROMPT(mark), [b], FINAL_SCHEMA);
}

/** 一张要用的图：本店水印 → 看成品 → 传 Shopee。做过的（同一张底图、同一套水印、这家店传过）直接用 */
async function finish(sql: Sql, shop: string, mark: Mark, p: Pic, base: Bytes): Promise<void> {
	const key = markKey(mark);
	const [done] = await sql`select f.sha256, s.image_id, s.width, s.height from images f join shop_images s on s.sha256 = f.sha256 and s.shop = ${shop}
		where f.kind = '成品' and f.from_sha = ${base.sha256} and f.source = ${key} order by s.uploaded_at desc limit 1`;
	if (done) { Object.assign(p, { final: done.sha256, imageId: done.image_id, width: done.width, height: done.height }); return; }
	const out = await watermark(base, mark);
	// 同一张成品看过的不再看（同一个浏览器画出来的字节一样）
	const checkKey = `成品:${CHECK_VERSION}:${model()}`;
	const [seen] = await sql`select checks->${checkKey} as c from images where sha256 = ${out.sha256}`;
	const check: Final = seen?.c ?? await finalCheck(out, mark.text);
	await sql`insert into images ${sql({ sha256: out.sha256, kind: "成品", source: key, from_sha: base.sha256, mime: out.mime, width: out.width, height: out.height, checks: sql.json({ [checkKey]: check }) })}
		on conflict (sha256) do update set checks = images.checks || excluded.checks`;
	if (!check.supplierMarksAbsent || check.supplierMarks.length) { p.drop = `成品上有供应商痕迹：${check.supplierMarks.join("、") || "（没抄出原文）"}`; return; }
	if (!check.watermarkVisible) { p.drop = "成品上看不见本店水印"; return; }
	if (!check.readable) { p.drop = "成品看不清"; return; }
	const [id] = await uploadImages([{ base64: Buffer.from(out.bytes).toString("base64"), mime: out.mime }]);
	await sql`insert into shop_images ${sql({ shop, sha256: out.sha256, image_id: id!, width: out.width, height: out.height })} on conflict (shop, sha256) do update set image_id = excluded.image_id, uploaded_at = now()`;
	Object.assign(p, { final: out.sha256, imageId: id, width: out.width, height: out.height });
}

/** 一张图加水印之前的那张（Gemini 文字检查看它：水印会挡住字）：译过的是译图（库里存着字节），没译的是原图 */
export async function unmarked(sql: Sql, pics: Partial<Pics>, id: string): Promise<Bytes> {
	const p = [...(pics.main ?? []), ...(pics.detail ?? []), ...(pics.options ?? [])].find((x) => x.imageId === id);
	if (!p) throw new Error(`图 ${id} 不在商品稿的图里：重做商品稿（x2 listing make）`);
	if (!p.translated) return original(sql, p.from);
	const [row] = await sql`select bytes from images where sha256 = ${p.translated}`;
	if (!row?.bytes) throw new Error(`库里没有译图 ${p.translated.slice(0, 12)} 的字节：重做商品稿（x2 listing make）`);
	return inspect(new Uint8Array(row.bytes), "译图");
}

/** 把要译的交象寄：一批 5 张记成写入「译图」（不用批准），马上执行。同一批图交过、核清了还没有结果的（人核对成已核对，象寄的地址没拿到），
 * 防重复的 key 后面加次数，重交 */
async function translateNow(sql: Sql, items: { sha: string; url: string }[]): Promise<void> {
	const [{ batch }] = await sql`select nextval('batch_seq')::text as batch` as any;
	for (let i = 0; i < items.length; i += 5) {
		const chunk = items.slice(i, i + 5);
		const base = `xiangji:${chunk.map((x) => x.sha).sort().join(",")}`;
		const [{ n }] = await sql`select count(*)::int as n from writes where key = ${base} or key like ${`${base}#%`}` as any;
		const key = n > 0 ? `${base}#${n + 1}` : base;
		await sql`insert into writes (batch, op, target, params, display, key, status) values (${batch}, '译图', ${`xiangji:${chunk.map((x) => x.sha.slice(0, 12)).join(",")}`}, ${sql.json({ items: chunk })}, ${`译图 ${chunk.length} 张`}, ${key}, '已批准')`;
	}
	await run(sql, { batch });
}

/** 做一份商品稿的图。log 写进度（stderr） */
export async function makeImages(sql: Sql, c: { shop: string; mark: Mark; main: string[]; detail: string[]; options: string[] }, log: (s: string) => void = console.error): Promise<Pics> {
	const pics: Pics = { main: c.main.map((from) => ({ from })), detail: c.detail.map((from) => ({ from })), options: [...new Set(c.options)].map((from) => ({ from })) };
	const bytes = new Map<string, Bytes>();
	const all = [...pics.main, ...pics.detail, ...pics.options];

	// 1. 取图、量尺寸、筛字
	log(`取图、筛字（${all.length} 张）`);
	for (const p of all) {
		try {
			const b = await original(sql, p.from);
			Object.assign(p, { sha: b.sha256, width: b.width, height: b.height });
			bytes.set(b.sha256, b);
		} catch (e) { p.drop = `取不到：${(e as Error).message}`; continue; }
		if (p.width! <= 10 || p.height! <= 10) { p.drop = `占位图（${p.width}×${p.height}）`; continue; }
		if (pics.detail.includes(p) && !detailFits(p.width!, p.height!)) { p.drop = `详情图尺寸不合 Shopee 的要求（${p.width}×${p.height}：宽 ≥ 700、高 ≥ 32、宽高比 0.5–32）`; continue; }
		const s = await screened(sql, bytes.get(p.sha!)!);
		Object.assign(p, s);
		if (s.verdict === "d") p.drop = "有供应商痕迹或写给 1688 买家的说明（工厂、批发、联系方式、人民币价、售后、定制……）";
	}

	// 2. 译图：m 和带简体字的 r。译过的、象寄给过地址的直接用；结果未知的这张先不用（不挡商品稿），人核清以后再做商品稿就用上
	const toTranslate = all.filter((p) => !p.drop && (p.verdict === "m" || (p.verdict === "r" && p.simplified)));
	const shas = [...new Set(toTranslate.map((p) => p.sha!))];
	if (shas.length) {
		let state = await translationState(sql, shas);
		const flying = new Set((await sql`select params from writes where op = '译图' and status in ('已批准', '已提交', '结果未知', '不一致')`).flatMap((w) => (w.params.items as { sha: string }[]).map((i) => i.sha)));
		const fresh = shas.filter((s) => !state.has(s) && !flying.has(s));
		if (fresh.length) {
			log(`交象寄译图（${fresh.length} 张）`);
			await translateNow(sql, fresh.map((s) => ({ sha: s, url: toTranslate.find((p) => p.sha === s)!.from })));
			state = await translationState(sql, shas);
		}
		for (const s of shas) {
			const t = state.get(s);
			if (t && !t.saved && t.url) await saveTranslation(sql, s, t.url).catch((e) => log(`取译图：${(e as Error).message}`));
		}
		state = await translationState(sql, shas);
		const still = new Map((await sql`select id::text, params from writes where op = '译图' and status in ('已提交', '结果未知', '不一致') order by id`).flatMap((w) => (w.params.items as { sha: string }[]).map((i) => [i.sha, w.id as string] as const)));
		for (const p of toTranslate) {
			const t = state.get(p.sha!);
			if (t?.saved) {
				const [row] = await sql`select sha256 from images where kind = '译图' and from_sha = ${p.sha!} limit 1`;
				p.translated = row!.sha256;
			} else if (t?.failed) p.drop = `象寄译不成：${t.failed}`;
			else if (still.has(p.sha!)) p.drop = `译图结果未知（写入 #${still.get(p.sha!)}）：先不用，在「写入」里核清以后再做商品稿就会用上`;
			else p.drop = "还没译好";
		}
		// 译图检查：还有简体字、象寄改了商品上印的字，这张不用（主图、详情图的张数在下一步才截，后面的图补上来）
		const check = toTranslate.filter((p) => p.translated && !p.drop);
		if (check.length) log(`检查译图（${new Set(check.map((p) => p.translated)).size} 张）`);
		for (const p of check) {
			const why = translatedDrop(await translatedChecked(sql, bytes.get(p.sha!)!, p.translated!));
			if (why) p.drop = why;
		}
	}

	// 3. 水印、看成品、传图：主图最多 9 张、详情图最多 12 张、规格图都要
	const use = (list: Pic[], max: number) => list.filter((p) => !p.drop).slice(0, max);
	const keep = [...use(pics.main, MAX_MAIN), ...use(pics.detail, MAX_DETAIL), ...pics.options.filter((p) => !p.drop)];
	log(`加水印、看成品、传图（${keep.length} 张）`);
	for (const p of keep) {
		let base = bytes.get(p.sha!)!;
		if (p.translated) {
			const [row] = await sql`select bytes from images where sha256 = ${p.translated}`;
			base = inspect(new Uint8Array(row!.bytes), "译图");
		}
		await finish(sql, c.shop, c.mark, p, base);
	}
	for (const p of [...pics.main.slice(0), ...pics.detail]) if (!p.drop && !p.imageId && !keep.includes(p)) p.drop = "超过张数，不用";
	return pics;
}
