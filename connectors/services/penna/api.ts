// Penna DeepSeek gateway 接入：只经已配置的网关和 Penna Bearer token，不直连厂商、不自动重试付费请求。
import { z } from "zod";
import { NeedsHuman } from "../../../platform/errors.ts";
import { reply } from "../../../platform/reply.ts";

const completion = z.looseObject({
	model: z.string(),
	choices: z.array(z.looseObject({ message: z.looseObject({ content: z.string().min(1) }) })).min(1),
	usage: z.looseObject({ total_tokens: z.number().int().nonnegative().optional() }).optional(),
});
export type GatewayConfig = { url: string; token: string; model: string };
export function gatewayConfig(): GatewayConfig {
	const url = process.env.X2_PENNA_URL,
		token = process.env.X2_PENNA_TOKEN;
	if (!url || !token) throw new NeedsHuman("Chat 需要配置 X2_PENNA_URL 和 X2_PENNA_TOKEN（Penna token，不能用 DeepSeek key）");
	return { url, token, model: process.env.X2_CHAT_MODEL || "deepseek-flash" };
}
export function endpoint(base: string): URL {
	const url = new URL(base);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
	)
		throw new Error("Penna gateway 必须是 HTTPS 或 loopback HTTP，不能在 URL 中放凭证");
	url.pathname = `${url.pathname.replace(/\/$/, "")}/deepseek/chat/completions`;
	return url;
}
export function completionOf(value: unknown) {
	const r = reply(completion, value, "Penna DeepSeek");
	return { text: r.choices[0]!.message.content.trim(), model: r.model, tokens: r.usage?.total_tokens ?? null };
}
export async function suggest(system: string, context: string, config = gatewayConfig(), request: typeof fetch = fetch) {
	let response: Response;
	try {
		response = await request(endpoint(config.url), {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(180_000),
			headers: { "content-type": "application/json", authorization: `Bearer ${config.token}`, "x-penna-what": "x2-chat" },
			body: JSON.stringify({
				model: config.model,
				stream: false,
				thinking: { type: "disabled" },
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: context },
				],
			}),
		});
	} catch {
		throw new Error("Penna gateway 连接失败或超时；未自动重试生成请求");
	}
	if (!response.ok)
		throw new Error(`Penna gateway 回 HTTP ${response.status}${response.status === 401 ? "：Penna token 无效" : response.status === 402 ? "：额度不足" : ""}`);
	return completionOf(await response.json());
}
