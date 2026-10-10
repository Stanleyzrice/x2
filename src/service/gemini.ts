// Gemini：看图（筛图上的字、译图检查、Gemini 文字检查）。一个请求是一段提示加几张图，temperature 0；要 JSON 时带 schema。
// 上品的代码同时问几个，上限在 src/listing/queue.ts（X2_GEMINI_CONCURRENCY）。
// 依据 lilto 的 legacy/lib/image_workflow.py（快照 1c8a7926）。key 在 GEMINI_API_KEY，放请求头，不进地址和日志；
// GEMINI_BASE 换出口网关（地域被挡时）；GEMINI_MODEL 换模型。gemini-2.5-flash-lite 在这把 key 上回 404，用 3.1
// 只对 429 和 5xx 重试（最多 4 次，隔 1、2、4 秒：同时问的多了，偶尔会碰上限流）；别的出错直接抛。回模型输出的文字

export const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const MAX_BYTES = 20 * 1024 * 1024;

export type Image = { bytes: Uint8Array; mime: string };

export const model = () => process.env.GEMINI_MODEL || DEFAULT_MODEL;

export async function gemini(prompt: string, images: Image[], schema?: object): Promise<string> {
	const key = process.env.GEMINI_API_KEY;
	if (!key) throw new Error("没有设 GEMINI_API_KEY（写在 .env 里）");
	const base = (process.env.GEMINI_BASE || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
	if (!base.startsWith("https://")) throw new Error("GEMINI_BASE 要是 https 地址");
	const parts = [{ text: prompt }, ...images.map((i) => ({ inlineData: { mimeType: i.mime, data: Buffer.from(i.bytes).toString("base64") } }))];
	const generationConfig: Record<string, unknown> = { temperature: 0, ...(schema ? { responseMimeType: "application/json", responseJsonSchema: schema } : {}) };
	const body = JSON.stringify({ contents: [{ parts }], generationConfig });
	if (body.length > MAX_BYTES) throw new Error(`一次送给 Gemini 的图太大（${Math.round(body.length / 1048576)}MB，最多 20MB）`);
	const url = `${base}/v1beta/models/${encodeURIComponent(model())}:generateContent`;
	for (let attempt = 1; ; attempt++) {
		const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body, signal: AbortSignal.timeout(60_000) });
		if (r.ok) {
			const j = (await r.json()) as any;
			return ((j?.candidates?.[0]?.content?.parts ?? []) as { text?: string }[]).map((p) => p.text ?? "").join("");
		}
		if ((r.status === 429 || r.status >= 500) && attempt < 4) { await new Promise((res) => setTimeout(res, 2 ** (attempt - 1) * 1000)); continue; }
		throw new Error(`Gemini 回 HTTP ${r.status}：${(await r.text()).slice(0, 300)}`);
	}
}

/** 要 JSON 的：按 schema 回，解析不了就抛 */
export async function geminiJson<T>(prompt: string, images: Image[], schema: object): Promise<T> {
	const text = await gemini(prompt, images, schema);
	try { return JSON.parse(text) as T; } catch { throw new Error(`Gemini 没有回 JSON：${text.slice(0, 200)}`); }
}
