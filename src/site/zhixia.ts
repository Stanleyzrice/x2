// 知虾（Shopee 的第三方数据平台）。这里只用它代理的 1688 以图搜图（/similarProduct/query1688）。
// 知虾的请求要签名（x-risk-token 由页面现算），照请求重发会让令牌作废：用页面自己的 axios 发——webpack 模块 b775，
// 注册一个模块拿到 require 再取它（模块 id 每次唯一：同名模块 webpack 不再执行工厂函数）。旧工作台（lilto 的 legacy/page/zhixia/api.ts）同样做法。
// 知虾对频率敏感（2026-09 作废过一次令牌）：连续搜索之间隔 6 秒以上，由调用方控制
import { page } from "../browser.ts";

const ORIGIN = "https://shopee.mobduos.com";

export type Candidate = { offerId: string; url: string; title: string; price: number; monthSold: number; image: string };

/** 用一张图在 1688 上找同款，最多 n 个 */
export async function similar1688(imageUrl: string, n = 4): Promise<Candidate[]> {
	const p = await page(ORIGIN);
	const body = await p.run(async (path: string, params: Record<string, unknown>) => {
		if (location.pathname.startsWith("/workbench/login")) return { code: 401, msg: "没有登录" };
		const w = window as any;
		if (!w.webpackJsonp) return { code: -1, msg: "页面还没加载好：不是知虾的工作台页面" };
		if (!w.__x2Http) {
			const holder: { req: any } = { req: null };
			const id = `x2-http-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			w.webpackJsonp.push([[id], { [id]: (_m: unknown, _e: unknown, r: any) => { holder.req = r; } }, [[id]]]);
			w.__x2Http = holder.req("b775").a;
		}
		return w.__x2Http({ url: path, method: "get", params, validateStatus: () => true });
	}, "/api/shopee-report-service/pro/similarProduct/query1688", { imgUrl: imageUrl, beginPage: 1, pageSize: n });
	const b = body as { code?: number; msg?: string; data?: any[] };
	if (b.code === 401 || b.code === 602) throw new Error("知虾没有登录（或令牌失效）：在浏览器里登录知虾再试");
	if (!Array.isArray(b.data)) throw new Error(`知虾回：${b.code} ${b.msg ?? ""}`);
	return b.data.slice(0, n).map((o) => ({
		offerId: String(o.offerId), url: `https://detail.1688.com/offer/${o.offerId}.html`, title: o.subject ?? "",
		price: Number(o.priceInfo?.price ?? 0), monthSold: Number(o.monthSold ?? 0), image: o.imageUrl ?? "",
	}));
}

/** x2 打开知虾标签页时要落在工作台页面上（有 webpackJsonp），不是随便一页 */
export async function ready(): Promise<void> {
	const p = await page(ORIGIN);
	const ok = await p.run(() => Boolean((window as any).webpackJsonp) && !location.pathname.startsWith("/workbench/login"));
	if (!ok) await p.goto(`${ORIGIN}/workbench/home`);
}
