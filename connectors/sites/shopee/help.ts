// 帮助中心的文章（法规、类目规定）。不带 x-csrftoken，要 shopee-language 头
import { z } from "zod";
import { page } from "../../../platform/browser/browser.ts";
import { reply } from "../../../platform/reply.ts";
import { ORIGIN } from "./seller.ts";

const shell = z.looseObject({ code: z.union([z.number(), z.string()]).nullish(), msg: z.string().nullish(), data: z.unknown().optional() });

async function help<S extends z.ZodType>(path: string, query: Record<string, string>, data: S): Promise<z.output<S>> {
	const p = await page(ORIGIN);
	const b = await p.run(
		async (path: string, query: Record<string, string>) => {
			const spc =
				document.cookie
					.split("; ")
					.find((c) => c.startsWith("SPC_CDS="))
					?.slice(8) ?? "";
			const q = new URLSearchParams({ SPC_CDS: spc, SPC_CDS_VER: "2", lang: "default", ...query });
			const r = await fetch(`${path}?${q}`, { credentials: "include", headers: { "shopee-language": "default" } });
			return (await r.json()) as unknown;
		},
		path,
		query,
	);
	const h = reply(shell, b, `Shopee 帮助中心 ${path}`);
	if (h.code !== 0) throw new Error(`Shopee 帮助中心 ${path} 回 ${h.code}：${h.msg ?? ""}`);
	return reply(data, h.data, `Shopee 帮助中心 ${path}`);
}

/** 帮助中心一个二级分类下的文章列表（一页最多 50）。categoryId 是帮助中心自己的分类 id，不是商品类目 id */
export async function articles(
	categoryId: number,
	pageIndex = 0,
	pageSize = 20,
): Promise<{ total: number; rows: { articleId: string; title: string; rtime: string | null }[] }> {
	const d = await help(
		"/help/api/v3/article/list/",
		{ page_index: String(pageIndex), page_size: String(pageSize), l2_cat_id: String(categoryId) },
		z.looseObject({
			total: z.union([z.number(), z.string()]).nullish(),
			article_list: z
				.array(
					z.looseObject({ article_id: z.union([z.number(), z.string()]), title: z.string().nullish(), rtime: z.union([z.number(), z.string()]).nullish() }),
				)
				.nullish(),
		}),
	);
	// rtime 是发布时间（站点给秒），换成 ISO
	const iso = (v: unknown) => (Number(v) > 0 ? new Date(Number(v) * 1000).toISOString() : null);
	return {
		total: Number(d.total ?? 0),
		rows: (d.article_list ?? []).map((a) => ({ articleId: String(a.article_id), title: String(a.title ?? "").trim(), rtime: iso(a.rtime) })),
	};
}

export const article = (articleId: string) => help("/help/api/v3/article/detail/", { article_id: articleId }, z.unknown());
