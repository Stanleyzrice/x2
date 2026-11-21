import { z } from "zod";
import { productTraffic, twMidnight } from "../../connectors/sites/shopee/marketing.ts";
import { performance } from "../../connectors/sites/shopee/products.ts";
import { shop as identity } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import { NeedsHuman, Usage } from "../../platform/errors.ts";
import { dailyReportSchema } from "../../platform/ui/interactable/store-monitor/schema.ts";
import { readCompleteList } from "./snapshot.ts";

const count = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).pipe(z.number().int().nonnegative());
const missingSources = { search: null, recommendation: null };

export async function collectDay(shop: string, shopId: string, date: string) {
	const start = Date.parse(`${date}T00:00:00+08:00`) / 1000;
	if (start >= twMidnight()) throw new Usage("请选择已结束的台湾日期");
	const end = start + 86_400;
	return inAccount("shopee", shopId, async () => {
		const items = await readCompleteList(
			"虾皮单日商品表现",
			(page) => performance(start, end, "day", page),
			(row) => row.id,
		);
		const rows = [];
		for (const item of items) {
			const visitors = count.safeParse(item.uv).data ?? null;
			const clicks = count.safeParse(item.product_card_clicks).data ?? null;
			const sources = clicks === 0 ? { search: 0, recommendation: 0 } : { ...missingSources };
			if (clicks !== 0 && (clicks !== null || visitors)) {
				try {
					const detail = await productTraffic(item.id, start, end);
					if (clicks === null || detail.total === clicks) Object.assign(sources, { search: detail.search, recommendation: detail.recommendation });
				} catch (error) {
					if (error instanceof NeedsHuman) throw error;
					// 来源请求失败时仍可显示日访客，来源栏保留缺值。
				}
			}
			rows.push({ id: item.id, name: item.name, visitors, ...sources });
		}
		if ((await identity()).shopId !== shopId) throw new NeedsHuman(`虾皮当前登录的店铺与 ${shop} 不符，请切回对应店铺后再查看`);
		return dailyReportSchema.parse({ date, rows });
	});
}
