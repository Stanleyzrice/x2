// Shopee 卖家中心（台湾站）的请求。接口是卖家中心页面自己用的：请求带 cookie（页面自带）、查询参数 SPC_CDS、请求头 x-csrftoken，
// 两个值都在页面的 cookie 里。请求一定在页面里用页面的 fetch 发：Shopee 的反爬 SDK 给页面里的每个请求现签名，
// 签名只在页面里算得出来，扩展或服务端发会被拒（90309999，lilto 旧工作台踩过）。
// 响应的外壳多数是 { code, message, data }，code 0 是成功；财务、售后的是 { error, error_msg, data }，error 0 是成功。
// 接口一览、各自的坑在 shopee.md
import { page } from "../../browser.ts";
import { NeedsHuman } from "../../errors.ts";

export const ORIGIN = "https://seller.shopee.tw";
/** 商品图、订单图的地址：图片 id 接在后面，加 _tn 是缩略图 */
export const IMAGE = "https://down-tw.img.susercontent.com/file/";

export type Req = { method?: "GET" | "POST"; query?: Record<string, string | number | boolean>; body?: unknown };

/** 发一个请求，回原样的结果。signin：跳到了登录页；unknown：没拿到响应（网络、超时），请求可能已经到了站点 */
export type Raw = { kind: "signin" } | { kind: "unknown"; why: string } | { kind: "http"; status: number; json: any; text: string };

export async function call(path: string, req: Req = {}): Promise<Raw> {
	const p = await page(ORIGIN);
	return p.run(async (path: string, method: string, query: Record<string, string>, body: string | null) => {
		if (/\/account\/signin|\/seller\/login/.test(location.pathname)) return { kind: "signin" as const };
		const cookie = (n: string) => document.cookie.split("; ").find((c) => c.startsWith(`${n}=`))?.slice(n.length + 1) ?? "";
		const url = new URL(path, location.origin);
		for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
		url.searchParams.set("SPC_CDS", cookie("SPC_CDS"));
		url.searchParams.set("SPC_CDS_VER", "2");
		try {
			// 传字符串，不传 URL 对象：有的页面（例 /edu 帮助中心）包了一层 fetch，只认字符串（e.match is not a function）
			const r = await fetch(url.href, {
				method, credentials: "include",
				headers: { accept: "application/json", "x-csrftoken": cookie("csrftoken"), ...(body === null ? {} : { "content-type": "application/json" }) },
				body: body ?? undefined,
			});
			if (r.url.includes("/account/signin")) return { kind: "signin" as const };
			const text = await r.text();
			let json: unknown = null;
			try { json = JSON.parse(text); } catch { /* 不是 JSON：留下前 300 字给人看 */ }
			return { kind: "http" as const, status: r.status, json, text: json === null ? text.slice(0, 300) : "" };
		} catch (e) {
			return { kind: "unknown" as const, why: String((e as Error)?.message ?? e) };
		}
	}, path, req.method ?? (req.body === undefined ? "GET" : "POST"), Object.fromEntries(Object.entries(req.query ?? {}).map(([k, v]) => [k, String(v)])), req.body === undefined ? null : JSON.stringify(req.body));
}

/** 站点的业务码：code，或财务、售后接口的 error；没有这两个字段是 undefined */
const codeOf = (json: any): number | undefined => (json?.code ?? json?.error) === undefined ? undefined : Number(json.code ?? json.error);
const messageOf = (json: any) => String(json?.user_message ?? json?.message ?? json?.msg ?? json?.error_msg ?? "");

/** 出错的回应里，哪些要人处理：401、403（没登录、token 失效，页面不一定跳登录页），或要再输一次密码、验证（财务区） */
export const needsHuman = (status: number, json: any) => status === 401 || status === 403 || /密碼|驗證/.test(messageOf(json));

/** 读：回 JSON，业务码不是 0、HTTP 出错、没登录都抛错 */
export async function seller<T = any>(path: string, req: Req = {}): Promise<T> {
	const r = await call(path, req);
	if (r.kind === "signin") throw new NeedsHuman("Shopee 卖家中心没有登录：在浏览器里登录");
	if (r.kind === "unknown") throw new Error(`Shopee ${path}：${r.why}`);
	if (r.json === null) throw new Error(`Shopee ${path}：HTTP ${r.status} ${r.text}`);
	const code = codeOf(r.json);
	if (r.status < 400 && (code === undefined || code === 0)) return r.json as T;
	// 出错了才看要不要人处理：成功的响应里也可能出现「驗證」这类字
	if (needsHuman(r.status, r.json)) throw new NeedsHuman(`Shopee ${path} 回 ${code ?? r.status}：${messageOf(r.json)}。没登录或要再验证一次：在浏览器里打开卖家中心处理好再试`);
	throw new Error(`Shopee ${path} 回 ${code ?? r.status}：${messageOf(r.json)}`);
}

/** 写的结果。done：站点回成功；refused：站点回了失败（确定没做）；unknown：没拿到站点的答复，可能已经做了，调用方不许重发，先回读 */
export type Write = { kind: "done"; data: any } | { kind: "refused"; code: number | undefined; why: string } | { kind: "unknown"; why: string };

/** 写：不抛错，回三态。没登录算 refused（请求没发出去） */
export async function write(path: string, req: Req): Promise<Write> {
	const r = await call(path, req);
	if (r.kind === "signin") return { kind: "refused", code: undefined, why: "Shopee 卖家中心没有登录" };
	if (r.kind === "unknown") return { kind: "unknown", why: r.why };
	if (r.json === null) return r.status >= 500 ? { kind: "unknown", why: `HTTP ${r.status}` } : { kind: "refused", code: undefined, why: `HTTP ${r.status} ${r.text}` };
	const code = codeOf(r.json);
	return code === 0 ? { kind: "done", data: r.json.data } : { kind: "refused", code, why: messageOf(r.json) };
}

/** 当前登录的店铺。shopId 是店铺 id（订单的 shop_id、聊聊消息的 from_shop_id）；userId 是卖家账号的 user_id（聊聊消息的 from_id、广告账户 id）。
 * 两个不一样（2026-10-09 查过：店铺 1554182542，账号 1555026956），别拿 user_id 当店铺 id */
export async function shop(): Promise<{ shopId: string; userId: string; name: string; username: string; rating: number | null }> {
	const s = await seller("/api/selleraccount/shop_info/");
	const u = await seller("/api/selleraccount/user_info/");
	const r = await seller("/api/v3/general/get_shop_info/").catch(() => null);
	if (!s.data?.shop_id) throw new Error("Shopee 没有回店铺 id（/api/selleraccount/shop_info/）");
	return { shopId: String(s.data.shop_id), userId: String(u.data?.user_id ?? ""), name: String(s.data.name ?? ""), username: String(u.data?.user_name ?? ""), rating: r?.data?.rating_star ?? null };
}
