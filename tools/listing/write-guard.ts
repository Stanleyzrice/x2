// Catalog 使用稳定商品 id；listing 保留原 SKU target，并在 prepare 按公共写入记录阻断同商品未结操作。
import type { Sql } from "../../platform/db/index.ts";

type ListingIdentity = { shopId: string; parentSku: string; productId?: string };
type CatalogIdentity = { shopId: string | null; productId: string | null; parentSku: string | null };

export function sameCatalogProduct(saved: CatalogIdentity, p: ListingIdentity): boolean {
	if (saved.shopId !== p.shopId) return false;
	return p.productId ? saved.productId === p.productId : Boolean(p.parentSku) && saved.parentSku === p.parentSku;
}

export async function catalogWriteBlock(sql: Sql, p: ListingIdentity): Promise<string | null> {
	if (!p.productId && !p.parentSku) return null;
	const rows = await sql<(CatalogIdentity & { id: string })[]>`select id::text,
		params->'expected'->>'shopId' as "shopId", params->>'productId' as "productId", params->'expected'->>'parentSku' as "parentSku"
		from writes where op = 'Catalog状态' and status in ('已提交', '结果未知', '不一致') and params->'expected'->>'shopId' = ${p.shopId}`;
	const pending = rows.find((w) => sameCatalogProduct(w, p));
	return pending ? `同一个商品有没核清的 Catalog 写入 #${pending.id}：先核清再做` : null;
}
