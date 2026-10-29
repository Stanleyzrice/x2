// 截 x2 自己的网页（x2 shot，验证改了的网页）：在一个连着的浏览器里开一个新标签页（x2 自己开的，用完关掉，不碰人正在用的），
// 从头加载、等网络静下来、截图存成 PNG，同时回页面上的报错（console.error、没接住的异常）和失败的请求（HTTP >= 400、连不上）。
// 只开本机（127.0.0.1、localhost）的地址：站点的页面经 browser.ts（锁、隔开、认登录），不从这里开
import { writeFile } from "node:fs/promises";
import { RelayClient, type RelayEvent } from "@wuwe1/booey";
import { z } from "zod";
import { Usage } from "../errors.ts";
import { pick, using } from "./browser.ts";

export type Problem = { kind: "console" | "exception" | "http" | "failed"; text: string; url?: string };
export type Shot = { url: string; file: string; browser: string; settled: boolean; problems: Problem[] };

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const consoleCall = z.looseObject({
	type: z.string(),
	args: z.array(z.looseObject({ value: z.unknown().optional(), description: z.string().optional(), type: z.string() })),
});
const thrown = z.looseObject({
	exceptionDetails: z.looseObject({
		text: z.string(),
		url: z.string().optional(),
		exception: z.looseObject({ description: z.string().optional() }).optional(),
	}),
});
const sent = z.looseObject({ requestId: z.string(), request: z.looseObject({ url: z.string() }) });
const received = z.looseObject({ requestId: z.string(), response: z.looseObject({ url: z.string(), status: z.number(), statusText: z.string().optional() }) });
const failed = z.looseObject({ requestId: z.string(), errorText: z.string(), canceled: z.boolean().optional() });

const argText = (a: z.output<typeof consoleCall>["args"][number]) =>
	a.description ?? (typeof a.value === "string" ? a.value : a.value === undefined ? a.type : JSON.stringify(a.value));

/** 页面的事件（booey 的 console、net）里挑出报错和失败的请求，照发生的先后 */
export function problemsOf(events: readonly RelayEvent[]): Problem[] {
	const urls = new Map<string, string>();
	const out: Problem[] = [];
	for (const e of events) {
		if (e.method === "Network.requestWillBeSent") {
			const p = sent.safeParse(e.params);
			if (p.success) urls.set(p.data.requestId, p.data.request.url);
		} else if (e.method === "Runtime.consoleAPICalled") {
			const p = consoleCall.safeParse(e.params);
			if (p.success && (p.data.type === "error" || p.data.type === "assert")) out.push({ kind: "console", text: p.data.args.map(argText).join(" ") });
		} else if (e.method === "Runtime.exceptionThrown") {
			const p = thrown.safeParse(e.params);
			if (p.success)
				out.push({ kind: "exception", text: p.data.exceptionDetails.exception?.description ?? p.data.exceptionDetails.text, url: p.data.exceptionDetails.url });
		} else if (e.method === "Network.responseReceived") {
			const p = received.safeParse(e.params);
			if (p.success && p.data.response.status >= 400)
				out.push({ kind: "http", text: `${p.data.response.status} ${p.data.response.statusText ?? ""}`.trim(), url: p.data.response.url });
		} else if (e.method === "Network.loadingFailed") {
			const p = failed.safeParse(e.params);
			if (p.success && !p.data.canceled) out.push({ kind: "failed", text: p.data.errorText, url: urls.get(p.data.requestId) });
		}
	}
	return out.map((p) => (p.url ? p : { kind: p.kind, text: p.text }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 等网页服务起来（x2 web 先打包界面，要几秒）：连得上就行，不管状态码 */
async function reachable(url: string, waitMs: number): Promise<void> {
	const until = Date.now() + waitMs;
	for (;;) {
		try {
			await fetch(url, { signal: AbortSignal.timeout(2000) });
			return;
		} catch {
			if (Date.now() > until) throw new Usage(`${url} 连不上（等了 ${waitMs / 1000} 秒）：先开网页服务，例 x2 web --scratch --port ${new URL(url).port || 80}`);
			await sleep(500);
		}
	}
}

export async function shoot(o: { url: string; out: string; browser?: string; width: number; height: number; waitMs: number }): Promise<Shot> {
	const u = new URL(o.url);
	if (!LOOPBACK.has(u.hostname)) throw new Usage(`x2 shot 只开本机的网页（127.0.0.1、localhost），不开 ${u.host}`);
	await reachable(o.url, o.waitMs);
	const b = await (o.browser ? using(o.browser, () => pick(u.origin)) : pick(u.origin));
	const c = new RelayClient({ browser: b.id });
	const { tabId } = await c.openTab(o.url);
	try {
		await c.attach(tabId, { events: ["nav", "console", "net"] });
		await c.send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
		await c.send(tabId, "Emulation.setDeviceMetricsOverride", { width: o.width, height: o.height, deviceScaleFactor: 1, mobile: false });
		// 标签页开的时候还没订上事件：从头再加载一遍，加载时的报错、请求才都看得到
		await c.clearEvents(tabId);
		await c.send(tabId, "Page.reload", { ignoreCache: true });
		const { quiet } = await c.settled(tabId, { net: true, quietMs: 1000, timeoutMs: 30_000 });
		await c.eval(tabId, "document.fonts.ready.then(() => true)", { awaitPromise: true });
		const events = await c.readEvents(tabId);
		const problems = problemsOf(events.events);
		if (events.truncated) problems.push({ kind: "console", text: `事件太多，丢了 ${events.dropped} 条：报错可能没列全` });
		const png = await c.send<{ data: string }>(tabId, "Page.captureScreenshot", { format: "png" });
		await writeFile(o.out, Buffer.from(png.data, "base64"));
		return { url: o.url, file: o.out, browser: b.label || b.id, settled: quiet, problems };
	} finally {
		await c.send(tabId, "Page.close").catch(() => {});
	}
}
