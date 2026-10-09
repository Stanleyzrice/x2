// 同步规格：一家店的在售商品（在那家店的浏览器里读），每个规格一行。人定的两列（货源、1688 规格）同步不改。
// 只有一个规格的商品用商品 id 当规格 id：chanboss 的订单里这种商品的 platform_model_id 就是商品 id，两边对得上
import { inShop } from "../accounts.ts";
import { liveProducts, type Product } from "../site/shopee/products.ts";
import type { Sql } from "../db/index.ts";

export function skuRows(shopId: string, products: Product[]) {
	return products.flatMap((p) => {
		const single = p.models.length === 1 && !p.models[0]!.name;
		return p.models.map((m) => ({
			model_id: single ? p.productId : m.modelId, shop_id: shopId, item_id: p.productId, item_name: p.name, name: m.name,
			image: p.cover, price: m.price, stock: m.stock, status: "在售",
		}));
	});
}

export async function syncSkus(sql: Sql, shopId: string): Promise<number> {
	const products = await inShop(shopId, async () => {
		const out: Product[] = [];
		for (let n = 1; ; n++) {
			const page = await liveProducts(n);
			out.push(...page.rows);
			if (n * 48 >= page.total || page.rows.length === 0) break;
		}
		return out;
	});
	const rows = skuRows(shopId, products);
	const at = new Date();
	await sql.begin(async (tx) => {
		for (const r of rows) {
			await tx`
				insert into skus ${tx({ ...r, synced_at: at })}
				on conflict (model_id) do update set
					shop_id = excluded.shop_id, item_id = excluded.item_id, item_name = excluded.item_name, name = excluded.name, image = excluded.image,
					price = excluded.price, stock = excluded.stock, status = excluded.status, synced_at = excluded.synced_at`;
		}
		// 这一轮没读到的：不在售了（下架、删除、审核中）
		await tx`update skus set status = '不在售' where shop_id = ${shopId} and status = '在售' and synced_at < ${at}`;
	});
	return rows.length;
}
