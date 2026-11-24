// 采购按钮只接受完整、已人工选好货源的订单；冻结精确规格、数量和账号，再交已有的加购写入引擎。
import type { z } from "zod";
import type { OrderSn } from "../../connectors/sites/shopee/seller.ts";
import { Usage } from "../../platform/errors.ts";
import { needsPurchase, type Result, type Snapshot } from "./check.ts";
import type { MatchNeed } from "./procurement-matches.ts";
import type { cartParams } from "./writes.ts";

type Cart = z.infer<typeof cartParams>;

export function selectPurchase(
	s: Snapshot,
	result: Result,
	orders: OrderSn[],
	shops: string[],
	expected?: Map<string, Pick<MatchNeed, "target" | "qty">>,
): Cart[] {
	if (!s.settings.buyAccount) throw new Usage("先在订单设置里填写采购账号并登录 1688");
	const selected = new Set(orders);
	if (!selected.size) throw new Usage("先选择要采购的订单");
	const selectedItems = new Set(s.orders.filter((order) => selected.has(order.sn)).flatMap((order) => order.items.map((item) => item.itemId)));
	const rows = result.todo
		.flatMap((t) => (t.kind === "加购" ? t.params.items : []))
		.flatMap((row) => {
			const lines = row.lines.filter((l) => selected.has(l.sn));
			return lines.length
				? [{ ...row, newSources: row.newSources.filter((id) => selectedItems.has(id)), lines, qty: lines.reduce((sum, l) => sum + l.qty, 0) }]
				: [];
		});
	for (const sn of selected) {
		const order = s.orders.find((o) => o.sn === sn);
		if (!order?.shop || !shops.includes(order.shop)) throw new Usage(`订单 ${sn} 不在当前店铺范围`);
		if (order.source !== "shopee" || !order.shopeeOrderId || !needsPurchase(order)) throw new Usage(`订单 ${sn} 已不是完整读取的 Shopee 待出货订单`);
		if (!order.items.length) throw new Usage(`订单 ${sn} 没有完整商品明细`);
		for (const item of order.items) {
			const chosen = s.sources.find((source) => source.itemId === item.itemId && source.chosen);
			if (!chosen) throw new Usage(`订单 ${sn} 的「${item.name}」还没有人工选用的货源，请先确认 1688 货源和规格`);
			const matching = rows.filter((row) => row.offerId === chosen.offerId && row.lines.some((line) => line.sn === sn && line.modelId === item.modelId));
			const lines = matching.flatMap((row) => row.lines.filter((line) => line.sn === sn && line.modelId === item.modelId));
			if (expected && matching.length) {
				const expectedLine = expected.get(`${sn}:${item.modelId}`);
				const target = expectedLine?.target;
				const row = matching[0]!;
				if (
					matching.length !== 1 ||
					expectedLine?.qty !== item.qty ||
					!target ||
					target.offerId !== row.offerId ||
					target.skuId !== row.skuId ||
					!chosen.skus.some((sku) => sku.skuId === row.skuId && sku.specId === target.specId)
				)
					throw new Usage(`订单 ${sn} 的「${item.spec || item.name}」与采购汇总的 1688 规格或数量不一致，请刷新订单并核对已选货源`);
			}
			if (!item.modelId || item.qty < 1 || lines.reduce((sum, l) => sum + l.qty, 0) !== item.qty)
				throw new Usage(`订单 ${sn} 的「${item.name} / ${item.spec}」现在不能完整加购：${result.orders.get(sn)?.step ?? "请检查货源、规格、库存和已有采购"}`);
		}
	}
	if (rows.some((row) => row.newSources.length)) throw new Usage("请先人工选用货源，再开始采购");
	return rows;
}

const canonical = (items: Cart[]) =>
	JSON.stringify(
		items
			.map((row) => ({ ...row, lines: [...row.lines].sort((a, b) => `${a.sn}:${a.modelId}`.localeCompare(`${b.sn}:${b.modelId}`)) }))
			.sort((a, b) => `${a.offerId}:${a.skuId}`.localeCompare(`${b.offerId}:${b.skuId}`)),
		(_, value) =>
			value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value,
	);
export const samePurchase = (a: Cart[], b: Cart[]) => canonical(a) === canonical(b);

/** 执行进程可能在保存确认结果前退出；全部预期写入都已终结才释放仍执行中的确认。 */
export function purchaseState(saved: string, statuses: (string | undefined)[]): "executing" | "unknown" | "completed" {
	const terminal = new Set(["成功", "已核对", "被拒", "未执行"]);
	const unknown = statuses.some((status) => status !== undefined && !terminal.has(status));
	if (saved === "executing" && (unknown || statuses.some((status) => status === undefined))) return "executing";
	return unknown ? "unknown" : "completed";
}
