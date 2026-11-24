// 当前 X2 页用一次性 URL 标记确认浏览器；只读 tabs 元数据，绝不 attach/eval 这个用户页。
import { RelayClient } from "@wuwe1/booey";
import { Challenge, NeedsHuman, Usage } from "../errors.ts";
import { type Account, allSites, browsers, browserTabs, canOpenVerification, focusVerification, refreshLogin, siteDef } from "./browser.ts";

export type ConnectionInput = { url: string; marker: string; site: string; expectedAccount?: string; action?: "check" | "open-verification" };
export type ConnectionBrowser = { id: string; label: string };
export type ConnectionResult = {
	status: "connected" | "login_required" | "wrong_account" | "not_connected" | "challenge" | "ambiguous" | "error";
	browser?: ConnectionBrowser;
	account?: Account;
	message: string;
	loginUrl?: string;
	canOpenVerification?: boolean;
};
export type ConnectionDriver = {
	browsers: () => Promise<ConnectionBrowser[]>;
	tabs: (browser: string) => Promise<{ url: string }[]>;
	identify: (site: string, browser: string) => Promise<Account | null>;
	canOpenVerification: (site: string, browser: string) => boolean | Promise<boolean>;
	openVerification: (site: string, browser: string) => Promise<void>;
};

const driver: ConnectionDriver = {
	browsers,
	tabs: (browser) => browserTabs(new RelayClient({ browser })),
	identify: refreshLogin,
	canOpenVerification,
	openVerification: focusVerification,
};
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 连接与采集共用本机根页面的单次 UUID 标记；服务端知道当前端口时一并限制。 */
export function browserPageUrl(pageUrl: string, marker: string, port?: number): string {
	if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Usage("连接浏览器的服务端口无效");
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker)) throw new Usage("连接标记必须是本次生成的 UUID");
	let url: URL;
	try {
		url = new URL(pageUrl);
	} catch {
		throw new Usage("连接浏览器的 X2 页面地址无效");
	}
	if (
		url.protocol !== "http:" ||
		!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		(port !== undefined && Number(url.port || 80) !== port)
	)
		throw new Usage("只允许连接当前端口的本机 X2 根页面");
	const markers = url.searchParams.getAll("x2BrowserConnect");
	if (markers.length !== 1 || markers[0] !== marker) throw new Usage("X2 页面地址与本次连接标记不一致");
	return url.href;
}

/** 只读标签元数据，精确匹配一次标记，不附着或执行用户的 X2 页面。 */
export async function browsersForPage(url: string, d: Pick<ConnectionDriver, "browsers" | "tabs"> = driver): Promise<ConnectionBrowser[]> {
	const all = await d.browsers();
	const tabs = await Promise.all(all.map((b) => d.tabs(b.id)));
	return all.flatMap((b, i) => tabs[i]!.filter((t) => t.url === url).map(() => ({ id: b.id, label: b.label })));
}

function targetUrl(input: ConnectionInput, port: number): string {
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Usage("连接浏览器的服务端口无效");
	if (!allSites().some((s) => s.key === input.site)) throw new Usage(`没有注册站点 ${input.site}`);
	if (input.action !== undefined && input.action !== "check" && input.action !== "open-verification") throw new Usage("不支持的浏览器连接操作");
	if (input.expectedAccount !== undefined && !input.expectedAccount.trim()) throw new Usage("预期账号不能为空");
	return browserPageUrl(input.url, input.marker, port);
}

export async function connectCurrentBrowser(input: ConnectionInput, options: { port: number; driver?: ConnectionDriver }): Promise<ConnectionResult> {
	const url = targetUrl(input, options.port);
	const d = options.driver ?? driver;
	const site = siteDef(input.site);
	let matches: ConnectionBrowser[];
	try {
		matches = await browsersForPage(url, d);
	} catch (e) {
		return { status: "not_connected", message: `无法确认当前浏览器连接：${messageOf(e)}` };
	}
	if (!matches.length) return { status: "not_connected", message: "尚未在已连接的浏览器中找到当前 X2 页面；请确认当前浏览器的 CDP 扩展已连接" };
	if (matches.length !== 1) return { status: "ambiguous", message: "有多个页面带着同一次连接标记，请关闭重复页面后重新连接" };
	const browser = matches[0]!;
	if (input.action === "open-verification") {
		try {
			await d.openVerification(input.site, browser.id);
			return { status: "challenge", browser, canOpenVerification: true, message: `已聚焦原 ${site.title} 验证页，请手动完成安全验证后重新检测` };
		} catch (e) {
			return { status: "error", browser, canOpenVerification: false, message: messageOf(e) };
		}
	}
	let account: Account | null;
	try {
		account = await d.identify(input.site, browser.id);
	} catch (e) {
		return {
			status: e instanceof Challenge ? "challenge" : e instanceof NeedsHuman ? "login_required" : "error",
			browser,
			message: messageOf(e),
			...(e instanceof Challenge ? { canOpenVerification: await d.canOpenVerification(input.site, browser.id) } : { loginUrl: site.origin }),
		};
	}
	if (!account?.id) return { status: "login_required", browser, message: `当前浏览器尚未识别到已登录的 ${site.title} 账号`, loginUrl: site.origin };
	const expected = input.expectedAccount?.trim();
	if (expected && account.id !== expected && account.name !== expected)
		return { status: "wrong_account", browser, account, message: `当前登录账号为 ${account.name || account.id}，与要求的账号不符`, loginUrl: site.origin };
	return { status: "connected", browser, account, message: `已连接当前浏览器并确认 ${site.title} 账号 ${account.name || account.id}` };
}
