// 浏览器连接的 HTTP 边界只接收结构化参数和同源请求，不透传额外认证或调试资料。
import { z } from "zod";
import type { Account } from "../browser/browser.ts";
import { type ConnectionBrowser, type ConnectionInput, type ConnectionResult, connectCurrentBrowser } from "../browser/connection.ts";
import { Usage } from "../errors.ts";

export type { CollectionSession } from "../browser/collection.ts";
export type { ConnectionInput as BrowserConnectionInput, ConnectionResult as BrowserConnectionResult } from "../browser/connection.ts";

const input = z.strictObject({
	url: z.string().min(1),
	marker: z.string().min(1),
	site: z.string().min(1),
	expectedAccount: z.string().min(1).optional(),
	action: z.enum(["check", "open-verification"]).optional(),
});

/** Origin 只能是 HTTP 来源本身；非法请求要报参数错误，而不是服务异常。 */
export function requestOriginUrl(origin: string): URL {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Usage("请求来源地址无效");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
		throw new Usage("请求来源地址无效");
	return url;
}

export async function connectBrowserRequest(
	raw: unknown,
	options: { port: number; origin?: string; authorize?: (site: string, account: Account, browser: ConnectionBrowser) => Promise<void> },
	connect: (input: ConnectionInput, options: { port: number }) => Promise<ConnectionResult> = connectCurrentBrowser,
): Promise<ConnectionResult> {
	const parsed = input.safeParse(raw);
	if (!parsed.success) throw new Usage("连接参数要包含 url、marker、site，以及可选的 expectedAccount 字符串");
	if (options.origin !== undefined) {
		const origin = requestOriginUrl(options.origin);
		let target: URL;
		try {
			target = new URL(parsed.data.url);
		} catch {
			throw new Usage("连接浏览器的 X2 页面地址无效");
		}
		if (origin.origin !== target.origin) throw new Usage("操作必须来自当前 X2 页面");
	}
	const result = await connect(parsed.data, { port: options.port });
	if (parsed.data.action !== "open-verification" && result.status === "connected" && result.account?.id.trim() && result.browser?.id.trim())
		await options.authorize?.(parsed.data.site, result.account, result.browser);
	return {
		status: result.status,
		message: result.message,
		...(result.browser ? { browser: { id: result.browser.id, label: result.browser.label } } : {}),
		...(result.account ? { account: { id: result.account.id, name: result.account.name } } : {}),
		...(result.loginUrl !== undefined ? { loginUrl: result.loginUrl } : {}),
		...(result.canOpenVerification !== undefined ? { canOpenVerification: result.canOpenVerification } : {}),
	};
}
