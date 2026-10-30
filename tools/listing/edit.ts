// 已上架商品改标题和价格：人确认原标题、目标标题和逐规格原价/目标价；不交库存、规格名等字段，经写入引擎单次提交、回读。
import { createHash } from "node:crypto";
import { z } from "zod";
import { type ProductInfo, productInfo } from "../../connectors/sites/shopee/products.ts";
import { editProduct } from "../../connectors/sites/shopee/publish.ts";
import { ItemId, ModelId } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { parseJson, str } from "../../platform/tool.ts";
import { type WriteOp, writeOp } from "../../platform/writes.ts";

const priceChange = z.object({ modelId: ModelId, from: z.number().positive().finite(), to: z.number().positive().finite() });
export const editParams = z.object({
	shop: str("店铺账号名（店铺设置里的 shop）"),
	id: ItemId.refine((id) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0).describe("Shopee 商品 id，不是商品稿编号"),
	beforeTitle: str("人确认的原标题，逐字核对；现读不一致就不提交"),
	title: str("人同意的完整新标题"),
	prices: z
		.preprocess(parseJson, z.array(priceChange))
		.default([])
		.describe('人同意的改价 JSON：[{"modelId":"规格 id","from":原价,"to":目标价}]；不写就只改标题'),
});
type Input = z.output<typeof editParams>;

export function titleChange(current: string | null | undefined, before: string, title: string): { skip: string } | { info: { name: string } } {
	if (current === title) return { skip: "已经是目标标题，不再提交" };
	if (current !== before) return { skip: "原标题已变或未知：重新现读并确认，不覆盖" };
	return { info: { name: title } };
}

export const titleState = (current: string | null | undefined, title: string): true | null => (current === title ? true : null);

const model = z.object({ id: ModelId, tier_index: z.array(z.number().int().nonnegative()).min(1), price: z.string() });
type Model = z.output<typeof model>;
/** JSONB 会重排对象键，站点也会重排规格行；按规格 id 比字段值，不能比较原始 JSON 字符串。 */
export function sameModels(a: Model[], b: Model[]): boolean {
	const canonical = (rows: Model[]) => rows.map((m) => [m.id, m.tier_index, Number(m.price)]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
	return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}
export function priceModels(now: ProductInfo, changes: z.output<typeof priceChange>[]): Model[] {
	if (!changes.length) return [];
	if (!now.model_list?.length) throw new Usage("规格未返回，不改价");
	if (new Set(changes.map((c) => c.modelId)).size !== changes.length) throw new Usage("改价清单有重复规格 id");
	const models = now.model_list.map((m) => {
		const price = m.price_info?.input_normal_price ?? m.price_info?.normal_price;
		if (!m.id || !Number.isSafeInteger(Number(m.id)) || price == null || price === "" || !(Number(price) > 0) || !Number.isFinite(Number(price)))
			throw new Usage("规格 id 或售价未知，不改价");
		return model.parse({ id: m.id, tier_index: m.tier_index?.map(Number), price: String(Number(price)) });
	});
	if (new Set(models.map((m) => m.id)).size !== models.length) throw new Usage("回包有重复规格 id，不改价");
	for (const c of changes) {
		const m = models.find((m) => m.id === c.modelId);
		if (!m || Number(m.price) !== c.from) throw new Usage(`规格 ${c.modelId} 不存在或原价已变：重新现读确认`);
	}
	return models.map((m) => ({ ...m, price: String(changes.find((c) => c.modelId === m.id)?.to ?? Number(m.price)) }));
}

/** 对整份规格价格回读：不能只看到两个目标价就把其他规格的意外变化当作成功。 */
export function pricesState(now: ProductInfo, expected: Model[]): true | null {
	if (!expected.length) return true;
	if (now.model_list?.length !== expected.length || new Set(now.model_list.map((m) => m.id)).size !== expected.length) return null;
	return expected.every((m) => {
		const got = now.model_list?.find((g) => g.id === m.id);
		return (
			got &&
			Number(got.price_info?.input_normal_price ?? got.price_info?.normal_price) === Number(m.price) &&
			JSON.stringify(got.tier_index?.map(Number)) === JSON.stringify(m.tier_index)
		);
	})
		? true
		: null;
}

async function shopIdOf(sql: Sql, shop: string): Promise<string> {
	const [row] = await sql<{ shop_id: string }[]>`select shop_id from shop_settings where shop = ${shop}`;
	if (!row) throw new Usage(`店铺设置里没有 ${shop}`);
	return row.shop_id;
}

export async function previewEdit(sql: Sql, p: Input) {
	const shopId = await shopIdOf(sql, p.shop);
	return inAccount("shopee", shopId, async () => {
		const now = await productInfo(p.id);
		const change = titleChange(now.name, p.beforeTitle, p.title);
		if ("skip" in change && now.name !== p.title) throw new Usage(change.skip);
		const models = priceModels(now, p.prices);
		return {
			...p,
			shopId,
			parentSku: now.parent_sku ?? "",
			currentTitle: now.name,
			checkedAt: new Date().toISOString(),
			models,
			already: now.name === p.title && !p.prices.length,
		};
	});
}

export async function planEdit(sql: Sql, p: Input) {
	const preview = await previewEdit(sql, p);
	if (preview.already) return [];
	return [[{ op: "改商品", params: { ...p, shopId: preview.shopId, parentSku: preview.parentSku, models: preview.models } }]];
}

const params = editParams.extend({ shopId: z.string(), parentSku: z.string(), models: z.array(model) });
type Params = z.output<typeof params>;
const editOp: WriteOp<Params, { title: string }> = {
	describe: "修改现有 Shopee 商品的标题和人指定的规格价格",
	params,
	target: (p) => `shopee:${p.shopId}:${p.parentSku || p.id}`,
	key: (p) =>
		`edit:${p.shopId}:${p.id}:${createHash("sha256")
			.update(JSON.stringify([p.beforeTitle, p.title, p.prices]))
			.digest("hex")}`,
	display: (p) =>
		`${p.shop}（商品 ${p.id}）标题：${p.beforeTitle} → ${p.title}${p.prices.map((c) => `；规格 ${c.modelId}：NT$${c.from} → NT$${c.to}`).join("")}`,
	untried: "改商品是新写操作：先和人约一个商品一起跑 --try，回读后请人在站点核对",
	where: (_sql, p, fn) => inAccount("shopee", p.shopId, fn),
	async prepare(sql, p) {
		if ((await shopIdOf(sql, p.shop)) !== p.shopId) return { skip: "店铺设置刚改过：重新确认店铺" };
		const now = await productInfo(p.id);
		if ((now.parent_sku ?? "") !== p.parentSku) return { skip: "商品货号刚改过：重新确认商品" };
		const change = titleChange(now.name, p.beforeTitle, p.title);
		if ("skip" in change && now.name !== p.title) return change;
		const models = priceModels(now, p.prices);
		if (!sameModels(models, p.models)) return { skip: "规格或售价刚改过：重新确认，不覆盖" };
		if (now.name === p.title && !p.prices.length) return { skip: "已经是目标标题，不再提交" };
		return { params: p, before: { title: p.beforeTitle } };
	},
	submit: (_sql, p) => editProduct.submit({ productId: p.id, title: p.title, ...(p.models.length ? { models: p.models } : {}) }),
	async check(p, _before, fresh) {
		for (let n = 0; n < (fresh ? 3 : 1); n++) {
			if (n) await new Promise((ok) => setTimeout(ok, 2000));
			const now = await productInfo(p.id);
			const done = titleState(now.name, p.title) && pricesState(now, p.models);
			if (done || !fresh || n === 2) return { done, readback: { productId: p.id, title: now.name, models: now.model_list } };
		}
		return { done: null, readback: null };
	},
};
export const EDIT_WRITES = { 改商品: writeOp(editOp) };
