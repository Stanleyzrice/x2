// 单份未建商品稿的最低购买数量：锁行后仅改本稿；没有覆盖值时沿用店铺默认，不改已建商品。
import { z } from "zod";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { ListingId, type ListingRow } from "./row.ts";

const minimumPurchase = z.coerce.number().int().positive().max(2_147_483_647);
export const purchaseLimitParams = z.object({
	id: ListingId.describe("商品稿编号"),
	minimum: minimumPurchase.describe("本稿最低购买数量（正整数）"),
});
type Input = z.output<typeof purchaseLimitParams>;
type LimitRow = Pick<ListingRow, "id" | "product_id" | "listed_at" | "min_purchase">;

export const purchaseLimitOf = (row: Pick<ListingRow, "min_purchase">, shopMinimum: number): number => row.min_purchase ?? shopMinimum;

export function purchaseLimitPatch(row: Pick<ListingRow, "product_id" | "listed_at">, minimum: number): { min_purchase: number } {
	if (row.product_id !== null || row.listed_at !== null) throw new Usage("商品已经建成或上架；草稿最低购买数量工具不修改现有商品");
	return { min_purchase: minimumPurchase.parse(minimum) };
}

export async function setPurchaseLimit(sql: Sql, p: Input) {
	return sql.begin(async (tx) => {
		const [row] = await tx<LimitRow[]>`select id::text, product_id, listed_at, min_purchase from listings where id = ${p.id} for update`;
		if (!row) throw new Usage(`没有商品稿 ${p.id}`);
		const patch = purchaseLimitPatch(row, p.minimum);
		await tx`update listings set min_purchase = ${patch.min_purchase}, updated_at = now() where id = ${p.id}`;
		return { id: p.id, minimum: patch.min_purchase, before: row.min_purchase ?? null };
	});
}
