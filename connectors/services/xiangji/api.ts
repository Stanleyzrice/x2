// 象寄（tosoiot）：图片译字，简体 → 繁体（台湾买家不喜欢简体字）。交一次收一次钱（约 0.025 元一张），所以只由 x2 run 的写入「译图」调。
// 依据 lilto 的 legacy/lib/image_workflow.py（快照 1c8a7926）：GetImageTranslateBatch，同步（Sync=1），一批最多 5 张（51 张一批超过 120 秒）。
// 签名 Sign = md5(CommitTime_UserKey_ImgTransKey)，ImgTransKey 也明文放在表单里：请求体不进日志。
// 图片地址要编码两次：每个地址先 encodeURIComponent、逗号连起来，表单再编码一次（服务端只解一次；少一层，带 & 的地址会散）。
// 结果按 OriginUrl 对回原图（原样比，再解码后比），绝不按位置对。象寄回的地址大约 80 天失效：拿到就转存
import { createHash } from "node:crypto";
import { z } from "zod";
import { reply } from "../../../platform/reply.ts";

export const BATCH = 5;

export type Translated = { origin: string; url: string };
export type Outcome =
	| { kind: "done"; results: Translated[]; failed: { origin: string; why: string }[]; missing: string[]; raw: unknown }
	| { kind: "refused"; why: string; raw: unknown }
	| { kind: "unknown"; why: string };

export const sign = (commitTime: string, userKey: string, imgTransKey: string) =>
	createHash("md5").update(`${commitTime}_${userKey}_${imgTransKey}`).digest("hex");

export function form(urls: string[], keys: { userKey: string; imgTransKey: string }, now = Date.now(), engine?: string): URLSearchParams {
	const commitTime = String(Math.floor(now / 1000));
	return new URLSearchParams({
		Action: "GetImageTranslateBatch",
		SourceLanguage: "CHS",
		TargetLanguage: "CHT",
		Urls: urls.map(encodeURIComponent).join(","),
		ImgTransKey: keys.imgTransKey,
		CommitTime: commitTime,
		Sign: sign(commitTime, keys.userKey, keys.imgTransKey),
		Sync: "1",
		NeedWatermark: "0",
		Qos: "BestQuality",
		...(engine ? { EngineType: engine } : {}),
	});
}

const code = z.union([z.number(), z.string()]).nullish();
const head = z.looseObject({ Code: code, Message: z.string().nullish() });
const content = z.looseObject({
	Data: z
		.looseObject({
			Content: z
				.array(
					z.looseObject({
						Code: code,
						OriginUrl: z.string().nullish(),
						SslUrl: z.string().nullish(),
						Url: z.string().nullish(),
						Message: z.string().nullish(),
					}),
				)
				.nullish(),
		})
		.nullish(),
});

/** 象寄的回包 → 每张图的结果（纯函数）。Code 不是 200 是没翻（不扣钱）；是 200 而结果的样子变了，报「回包变了」（可能扣了钱，调用方当结果未知） */
export function parse(urls: string[], raw: unknown): Outcome {
	const h = head.safeParse(raw).data;
	if (Number(h?.Code) !== 200) return { kind: "refused", why: `象寄没有翻译：Code=${h?.Code} ${h?.Message ?? ""}`.trim(), raw };
	const rows = reply(content, raw, "象寄 GetImageTranslateBatch").Data?.Content ?? [];
	const decode = (s: string) => {
		try {
			return decodeURIComponent(s);
		} catch {
			return s;
		}
	};
	const results: Translated[] = [],
		failed: { origin: string; why: string }[] = [],
		missing: string[] = [];
	for (const u of urls) {
		const hits = rows.filter((c) => c.OriginUrl === u || decode(String(c.OriginUrl ?? "")) === u);
		const hit = hits[0];
		if (hits.length !== 1 || !hit) missing.push(u);
		else if (Number(hit.Code) === 200 && (hit.SslUrl || hit.Url)) results.push({ origin: u, url: String(hit.SslUrl || hit.Url) });
		else failed.push({ origin: u, why: `Code=${hit.Code} ${hit.Message ?? ""}`.trim() });
	}
	return { kind: "done", results, failed, missing, raw };
}

export function translationConfig() {
	const userKey = process.env.XIANGJI_USER_KEY,
		imgTransKey = process.env.XIANGJI_IMG_TRANS_KEY;
	if (!userKey || !imgTransKey) throw new Error("请在 X2 启动配置的「象寄图片翻译」中填写 UserKey 和 ImgTransKey");
	const base = process.env.XIANGJI_BASE || "https://api.tosoiot.com";
	if (!base.startsWith("https://")) throw new Error("XIANGJI_BASE 要是 https 地址");
	return { userKey, imgTransKey, base };
}

export async function translate(urls: string[]): Promise<Outcome> {
	if (urls.length === 0 || urls.length > BATCH) throw new Error(`一批交 1 到 ${BATCH} 张，这批 ${urls.length} 张`);
	const { userKey, imgTransKey, base } = translationConfig();
	let raw: unknown;
	try {
		const r = await fetch(base, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form(urls, { userKey, imgTransKey }, Date.now(), process.env.XIANGJI_ENGINE_TYPE),
			signal: AbortSignal.timeout(120_000),
		});
		raw = await r.json();
	} catch (e) {
		return { kind: "unknown", why: `象寄没有答复（${(e as Error).name === "TimeoutError" ? "超时" : (e as Error).message}）：可能已经扣钱，不要重交` };
	}
	return parse(urls, raw);
}
