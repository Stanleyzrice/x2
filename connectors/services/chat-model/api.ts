// 客服建议调用所配置服务商的 OpenAI Chat Completions 兼容接口。
import { z } from "zod";
import { NeedsHuman } from "../../../platform/errors.ts";

const completion = z.looseObject({
	model: z.string().min(1),
	choices: z.array(z.looseObject({ message: z.looseObject({ content: z.string().trim().min(1) }) })).min(1),
	usage: z.looseObject({ total_tokens: z.number().int().nonnegative().optional() }).optional(),
});
const statusDetails: Record<number, string> = { 401: "（请检查 API Key）", 402: "（额度不足）", 403: "（请检查模型访问权限）", 429: "（请求频率或额度受限）" };

type ChatModelConfig = { baseUrl: string; apiKey: string; model: string };
export function chatModelConfig(): ChatModelConfig {
	const baseUrl = process.env.X2_CHAT_BASE_URL?.trim(),
		apiKey = process.env.X2_CHAT_API_KEY?.trim(),
		model = process.env.X2_CHAT_MODEL?.trim();
	if (!baseUrl || !apiKey || !model) throw new NeedsHuman("请在 .env 配置 X2_CHAT_BASE_URL、X2_CHAT_API_KEY 和 X2_CHAT_MODEL，再生成客服建议");
	return { baseUrl, apiKey, model };
}
export function endpoint(base: string): URL {
	const url = URL.parse(base);
	if (
		!url ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
	)
		throw new NeedsHuman("X2_CHAT_BASE_URL 须填写不含凭证、查询参数和片段的 HTTPS 地址，本机也支持 HTTP");
	const path = url.pathname.replace(/\/+$/, "");
	url.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
	return url;
}
export function completionOf(value: unknown) {
	const parsed = completion.safeParse(value);
	if (!parsed.success) throw new Error("客服模型回包变了，无法读取模型名或回复正文");
	const r = parsed.data;
	return { text: r.choices[0]!.message.content, model: r.model, tokens: r.usage?.total_tokens ?? null };
}
export async function suggest(system: string, context: string, config: ChatModelConfig, request: typeof fetch = fetch) {
	const url = endpoint(config.baseUrl);
	let response: Response;
	try {
		response = await request(url, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(180_000),
			headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
			body: JSON.stringify({
				model: config.model,
				stream: false,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: context },
				],
			}),
		});
	} catch {
		throw new Error("客服模型服务连接失败或超时，生成请求未自动重试");
	}
	if (!response.ok) throw new Error(`客服模型服务返回 HTTP ${response.status}${statusDetails[response.status] ?? ""}`);
	const body: unknown = await response.json().catch(() => {
		throw new Error("客服模型服务未返回有效 JSON");
	});
	return completionOf(body);
}
