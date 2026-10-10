// 一份商品稿的图（docs/listing.md「图」）：收图 → 取字节、量尺寸、剔掉占位图 → 筛字（Gemini）→ 要译的交象寄（写入「译图」）
// → 本店水印 → 看成品（Gemini）→ 传 Shopee。都按字节的 sha256 记在 images、shop_images 表里：重跑不重复付钱、不重复传。
// 在这家店的浏览器里跑（水印在页面的 canvas 里画，传图用页面的 UploadService）
import { type Sql } from "../db/index.ts";
import { run } from "../run.ts";
import { geminiJson, model } from "../service/gemini.ts";
import { type Bytes, fetchImage, inspect } from "../service/image.ts";
import { uploadImages } from "../site/shopee/products.ts";
import { saveTranslation, translationState } from "../site/writes.ts";
import { SCREEN_VERSION, screen, type Verdict } from "./screen.ts";
import { type Mark, markKey, watermark } from "./watermark.ts";

/** 一张图走到哪了。drop 是不用它的原因（给人看） */
export type Pic = { from: string; sha?: string; verdict?: Verdict; simplified?: boolean; translated?: string; final?: string; imageId?: string; width?: number; height?: number; drop?: string };
export type Pics = { main: Pic[]; detail: Pic[]; options: Pic[]; waiting: string[] };

export const MAX_MAIN = 9, MAX_DETAIL = 12;
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
	const check = await finalCheck(out, mark.text);
	await sql`insert into images ${sql({ sha256: out.sha256, kind: "成品", source: key, from_sha: base.sha256, mime: out.mime, width: out.width, height: out.height, checks: sql.json({ [`成品:${CHECK_VERSION}:${model()}`]: check }) })} on conflict (sha256) do nothing`;
	if (!check.supplierMarksAbsent || check.supplierMarks.length) { p.drop = `成品上有供应商痕迹：${check.supplierMarks.join("、") || "（没抄出原文）"}`; return; }
	if (!check.watermarkVisible) { p.drop = "成品上看不见本店水印"; return; }
	if (!check.readable) { p.drop = "成品看不清"; return; }
	const [id] = await uploadImages([{ base64: Buffer.from(out.bytes).toString("base64"), mime: out.mime }]);
	await sql`insert into shop_images ${sql({ shop, sha256: out.sha256, image_id: id!, width: out.width, height: out.height })} on conflict (shop, sha256) do update set image_id = excluded.image_id, uploaded_at = now()`;
	Object.assign(p, { final: out.sha256, imageId: id, width: out.width, height: out.height });
}

/** 把要译的交象寄：一批 5 张记成写入「译图」（不用批准），马上执行 */
async function translateNow(sql: Sql, items: { sha: string; url: string }[]): Promise<void> {
	const [{ batch }] = await sql`select nextval('batch_seq')::text as batch` as any;
	for (let i = 0; i < items.length; i += 5) {
		const chunk = items.slice(i, i + 5);
		const key = `xiangji:${chunk.map((x) => x.sha).sort().join(",")}`;
		await sql`insert into writes (batch, op, target, params, display, key, status) values (${batch}, '译图', ${`xiangji:${chunk.map((x) => x.sha.slice(0, 12)).join(",")}`}, ${sql.json({ items: chunk })}, ${`译图 ${chunk.length} 张`}, ${key}, '已批准')`;
	}
	await run(sql, { batch });
}

/** 做一份商品稿的图。log 写进度（stderr） */
export async function makeImages(sql: Sql, c: { shop: string; mark: Mark; main: string[]; detail: string[]; options: string[] }, log: (s: string) => void = console.error): Promise<Pics> {
	const pics: Pics = { main: c.main.map((from) => ({ from })), detail: c.detail.map((from) => ({ from })), options: [...new Set(c.options)].map((from) => ({ from })), waiting: [] };
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
		if (pics.detail.includes(p) && (p.width! < 700 || p.height! < 32)) { p.drop = `详情图太小（${p.width}×${p.height}，宽要 ≥ 700）`; continue; }
		const s = await screened(sql, bytes.get(p.sha!)!);
		Object.assign(p, s);
		if (s.verdict === "d") p.drop = "有供应商痕迹（工厂、批发、联系方式、人民币价……）";
	}

	// 2. 译图：m 和带简体字的 r。译过的、象寄给过地址的直接用；没拿到答复的等人核对
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
		const still = new Set((await sql`select params from writes where op = '译图' and status in ('已提交', '结果未知', '不一致')`).flatMap((w) => (w.params.items as { sha: string }[]).map((i) => i.sha)));
		for (const p of toTranslate) {
			const t = state.get(p.sha!);
			if (t?.saved) {
				const [row] = await sql`select sha256 from images where kind = '译图' and from_sha = ${p.sha!} limit 1`;
				p.translated = row!.sha256;
			} else if (t?.failed) p.drop = `象寄译不成：${t.failed}`;
			else if (still.has(p.sha!)) { p.drop = "译图结果未知：等人核对"; pics.waiting.push(p.from); }
			else p.drop = "还没译好";
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
