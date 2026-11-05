// 页面导航前只预读 X2 的页面和 Catalog 快照；后台预加载不请求 Shopee，也不执行任何写入。
import { useEffect } from "react";
import { api, type PageSummary } from "./api.ts";

export async function preloadPage(id: string): Promise<void> {
	try {
		const page = await api.page(id);
		await Promise.all(
			page.items
				.filter((item) => item.component === "catalog" && !item.invalid)
				.map((item) => {
					const props = item.props as { shop: string; defaultStatus?: string };
					return api.catalogProducts(item.id, { shop: props.shop, query: "", status: props.defaultStatus ?? "1", stock: "all", page: 1, pageSize: 50 });
				}),
		);
	} catch {
		// 预加载失败留给打开页面后的正常读取显示，避免导航前报错打断操作。
	}
}

export function usePagePreload(pages: PageSummary[], current: string) {
	const ids = JSON.stringify(pages.filter((page) => page.workspace).map((page) => page.id));
	useEffect(() => {
		const timers = (JSON.parse(ids) as string[]).filter((id) => id !== current).map((id, index) => setTimeout(() => void preloadPage(id), 150 + index * 200));
		return () => {
			for (const timer of timers) clearTimeout(timer);
		};
	}, [ids, current]);
}
