// Shopee 卖家中心（台湾站）的请求。接口是卖家中心页面自己用的：请求带 cookie（页面自带）、查询参数 SPC_CDS、请求头 x-csrftoken，
// 两个值都在页面的 cookie 里。请求一定在页面里用页面的 fetch 发：Shopee 的反爬 SDK 给页面里的每个请求现签名，
// 签名只在页面里算得出来，扩展或服务端发会被拒（90309999，lilto 旧工作台踩过）。
// 响应的外壳多数是 { code, message, data }，code 0 是成功；财务、售后的是 { error, error_msg, data }，error 0 是成功。
// 接口一览、各自的坑在同目录的 NOTES.md

import { createHash } from "node:crypto";
import { z } from "zod";
import { page } from "../../../platform/browser/browser.ts";
import { NeedsHuman } from "../../../platform/errors.ts";
import { idText, reply } from "../../../platform/reply.ts";

export const ORIGIN = "https://seller.shopee.tw";
/** 商品图、订单图的地址：图片 id 接在后面，加 _tn 是缩略图 */
export const IMAGE = "https://down-tw.img.susercontent.com/file/";

/** Shopee 的几种 id 都是字符串，贴上标签别互相传错：商品 id（item id，卖家中心叫 product_id）、规格 id（model id）、订单号（order sn；和 chanboss 连接器的 OrderSn 是同一个标签）。解析回包时贴 */
export const ItemId = z.string().min(1).brand<"ItemId">();
export type ItemId = z.output<typeof ItemId>;
export const ModelId = z.string().min(1).brand<"ModelId">();
export type ModelId = z.output<typeof ModelId>;
export const OrderSn = z.string().min(1).brand<"OrderSn">();
export type OrderSn = z.output<typeof OrderSn>;

export type Req = {
	method?: "GET" | "POST";
	query?: Record<string, string | number | boolean>;
	body?: unknown;
	headers?: Record<string, string>;
	listing?: { shopId: string };
};

/** 当前卖家中心 product-list 的 listingSignature 和 getSLTToken：只在内存里用登录 cookie 算，不把 cookie、签名记进库或日志 */
export function listingHeaders(body: string, shopId: string, cds: string, now = Date.now()): Record<string, string> {
	if (!cds) throw new NeedsHuman("Shopee 没有 SPC_CDS：在浏览器里重新登录卖家中心");
	const md5 = (s: string) => createHash("md5").update(s).digest("hex");
	const time = Math.round(now / 1000).toFixed(0);
	return {
		"SPC-SLT": md5(`${shopId}-e18c3c4dd05aef020946e6afbf9e04ef-${cds}`),
		"sc-listing-sign": md5(`${body}SIGNCODE${time}${cds}`),
		"sc-listing-sign-t": time,
		"sc-listing-sign-v": "1.0.0",
	};
}

export type Raw = { kind: "signin" } | { kind: "unknown"; why: string } | { kind: "http"; status: number; json: unknown; text: string };

export async function call(path: string, req: Req = {}): Promise<Raw> {
	const p = await page(ORIGIN);
	const body = req.body === undefined ? null : JSON.stringify(req.body);
	let headers = req.headers ?? {};
	if (req.listing) {
		const cds = await p.run(
			() =>
				document.cookie
					.split("; ")
					.find((s) => s.startsWith("SPC_CDS="))
					?.slice("SPC_CDS=".length) ?? "",
		);
		headers = { ...headers, ...listingHeaders(body ?? "", req.listing.shopId, cds) };
	}
	return p.run(
		async (path: string, method: string, query: Record<string, string>, body: string | null, headers: Record<string, string>) => {
			if (/\/account\/signin|\/seller\/login/.test(location.pathname)) return { kind: "signin" as const };
			const cookie = (n: string) =>
				document.cookie
					.split("; ")
					.find((c) => c.startsWith(`${n}=`))
					?.slice(n.length + 1) ?? "";
			const url = new URL(path, location.origin);
			for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
			url.searchParams.set("SPC_CDS", cookie("SPC_CDS"));
			url.searchParams.set("SPC_CDS_VER", "2");
			try {
				// 传字符串，不传 URL 对象：有的页面（例 /edu 帮助中心）包了一层 fetch，只认字符串（e.match is not a function）
				const r = await fetch(url.href, {
					method,
					credentials: "include",
					headers: {
						accept: "application/json",
						"x-csrftoken": cookie("csrftoken"),
						...(body === null ? {} : { "content-type": "application/json" }),
						...headers,
					},
					body: body ?? undefined,
				});
				if (r.url.includes("/account/signin")) return { kind: "signin" as const };
				const text = await r.text();
				let json: unknown = null;
				try {
					json = JSON.parse(text);
				} catch {}
				return { kind: "http" as const, status: r.status, json, text: json === null ? text.slice(0, 300) : "" };
			} catch (e) {
				return { kind: "unknown" as const, why: String((e as Error)?.message ?? e) };
			}
		},
		path,
		req.method ?? (req.body === undefined ? "GET" : "POST"),
		Object.fromEntries(Object.entries(req.query ?? {}).map(([k, v]) => [k, String(v)])),
		body,
		headers,
	);
}

/** 外壳：code（或财务、售后的 error）0 是成功；出错的话在 user_message、message、msg、error_msg 里。不是这个样子的（例 数组）当没有外壳 */
const shell = z.looseObject({
	code: z.union([z.number(), z.string()]).nullish(),
	error: z.union([z.number(), z.string()]).nullish(),
	user_message: z.unknown().optional(),
	message: z.unknown().optional(),
	msg: z.unknown().optional(),
	error_msg: z.unknown().optional(),
	data: z.unknown().optional(),
});
type Shell = z.output<typeof shell>;
const shellOf = (json: unknown): Shell => {
	const r = shell.safeParse(json);
	return r.success ? r.data : {};
};
const codeOf = (j: Shell): number | undefined => ((j.code ?? j.error) === undefined ? undefined : Number(j.code ?? j.error));
const messageOf = (j: Shell) => String(j.user_message ?? j.message ?? j.msg ?? j.error_msg ?? "");

/** 出错的回应里，哪些要人处理：401、403（没登录、token 失效，页面不一定跳登录页），或要再输一次密码、验证（财务区） */
export const needsHuman = (status: number, json: unknown) => status === 401 || status === 403 || /密碼|驗證/.test(messageOf(shellOf(json)));

/** 卖家中心的一个读接口：外壳对了，整个回包照 schema 解析（对不上是「回包变了」） */
export async function seller<S extends z.ZodType>(path: string, schema: S, req: Req = {}): Promise<z.output<S>> {
	const r = await call(path, req);
	if (r.kind === "signin") throw new NeedsHuman("Shopee 卖家中心没有登录：在浏览器里登录");
	if (r.kind === "unknown") throw new Error(`Shopee ${path}：${r.why}`);
	if (r.json === null) throw new Error(`Shopee ${path}：HTTP ${r.status} ${r.text}`);
	const head = shellOf(r.json);
	const code = codeOf(head);
	if (r.status < 400 && (code === undefined || code === 0)) return reply(schema, r.json, `Shopee ${path}`);
	// 出错了才看要不要人处理：成功的响应里也可能出现「驗證」这类字
	if (needsHuman(r.status, r.json))
		throw new NeedsHuman(`Shopee ${path} 回 ${code ?? r.status}：${messageOf(head)}。没登录或要再验证一次：在浏览器里打开卖家中心处理好再试`);
	throw new Error(`Shopee ${path} 回 ${code ?? r.status}：${messageOf(head)}`);
}

/** 回包的 data 照 s 解析，别的格原样留着 */
export const withData = <S extends z.ZodType>(s: S) => z.looseObject({ data: s });
/** 原样的一行（列表里不解析的行） */
export const row = z.looseObject({});

export type Write = { kind: "done"; data: unknown } | { kind: "refused"; code: number | undefined; why: string } | { kind: "unknown"; why: string };

export async function write(path: string, req: Req): Promise<Write> {
	const r = await call(path, req);
	if (r.kind === "signin") return { kind: "refused", code: undefined, why: "Shopee 卖家中心没有登录" };
	if (r.kind === "unknown") return { kind: "unknown", why: r.why };
	if (r.json === null)
		return r.status >= 500 ? { kind: "unknown", why: `HTTP ${r.status}` } : { kind: "refused", code: undefined, why: `HTTP ${r.status} ${r.text}` };
	const head = shellOf(r.json);
	const code = codeOf(head);
	// 字段校验失败（1000100256）时 msg 里列着全部失败的规则（Rule Type），user_message 只有第一条：都带上
	const rules = /Rule Type/.test(String(head.msg ?? "")) ? ` | ${String(head.msg).slice(0, 800)}` : "";
	return code === 0 ? { kind: "done", data: head.data } : { kind: "refused", code, why: messageOf(head) + rules };
}

/** 当前登录的店铺。shopId 是店铺 id（订单的 shop_id、聊聊消息的 from_shop_id）；userId 是卖家账号的 user_id（聊聊消息的 from_id、广告账户 id）。
 * 两个不一样（2026-10-09 查过：店铺 1554182542，账号 1555026956），别拿 user_id 当店铺 id */
export async function shop(): Promise<{ shopId: string; userId: string; name: string; username: string; rating: number | null }> {
	const s = await seller("/api/selleraccount/shop_info/", withData(z.looseObject({ shop_id: idText, name: z.string().nullish() })));
	const u = await seller("/api/selleraccount/user_info/", withData(z.looseObject({ user_id: idText.nullish(), user_name: z.string().nullish() }).nullish()));
	const r = await seller("/api/v3/general/get_shop_info/", withData(z.looseObject({ rating_star: z.number().nullish() }).nullish())).catch(() => null);
	return {
		shopId: s.data.shop_id,
		userId: u.data?.user_id ?? "",
		name: s.data.name ?? "",
		username: u.data?.user_name ?? "",
		rating: r?.data?.rating_star ?? null,
	};
}
