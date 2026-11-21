import { z } from "zod";
import { type Attribute, attributes as attributeTree } from "../../connectors/sites/shopee/products.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { pickAttributes } from "./category.ts";
import { settingsOf } from "./pricing.ts";
import { inShopQueued } from "./queue.ts";
import { ListingId, type ListingRow, type ShopSettingsRow } from "./row.ts";

export const listingAttributeParams = z.object({
	id: ListingId.describe("商品稿编号"),
	category: z.string().regex(/^\d+$/).describe("商品稿当前的叶子类目编号"),
	name: z.string().trim().min(1).describe("站点属性名称"),
	value: z.string().trim().min(1).describe("站点属性的目标可选值"),
});
type AttributeInput = z.output<typeof listingAttributeParams>;
type Draft = Pick<ListingRow, "id" | "shop" | "category_id" | "attributes" | "attributes_text" | "product_id" | "listed_at" | "cancelled" | "problems">;

export function replaceDraftAttribute(tree: Attribute[], current: Draft["attributes"], name: string, value: string) {
	const matches = tree.filter((item) => item.name === name);
	if (matches.length !== 1) throw new Usage(`当前类目中无法唯一确定属性「${name}」`);
	const item = matches[0]!;
	const choices = item.values.filter((choice) => choice.name === value);
	if (choices.length !== 1) throw new Usage(`属性「${name}」没有唯一对应可选值「${value}」`);
	const attributeId = Number(item.id);
	const selected = { attribute_id: attributeId, attribute_values: [{ value_id: Number(choices[0]!.valueId) }] };
	const before = current ?? [];
	const next = before.some((entry) => entry.attribute_id === attributeId)
		? before.map((entry) => (entry.attribute_id === attributeId ? selected : entry))
		: [...before, selected];
	const checked = pickAttributes(tree, next);
	if (checked.missing.length) throw new Usage(`属性：${checked.missing.join("；")}`);
	return { attributes: checked.attributes, text: checked.text.join("\n") };
}

export async function setListingAttribute(sql: Sql, p: AttributeInput) {
	const [draft] = await sql<Draft[]>`select id, shop, category_id, attributes, attributes_text, product_id, listed_at, cancelled, problems
		from listings where id = ${p.id}`;
	if (!draft) throw new Usage(`没有商品稿 ${p.id}`);
	if (draft.cancelled || draft.product_id || draft.listed_at) throw new Usage("只修改尚未建成商品且未放弃的草稿属性");
	if (String(draft.category_id) !== p.category) throw new Usage("草稿类目与指定的当前类目不一致");
	const [shop] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${draft.shop}`;
	if (!shop) throw new Usage(`没有「${draft.shop}」的店铺设置`);
	const tree = await inShopQueued(settingsOf(shop).shopId, () => attributeTree(Number(p.category)));
	const patch = replaceDraftAttribute(tree, draft.attributes, p.name, p.value);
	const problems =
		draft.problems
			?.split("\n")
			.filter((line) => line && !line.startsWith("属性："))
			.join("\n") || null;
	const [saved] = await sql<Pick<Draft, "category_id" | "attributes_text">[]>`update listings
		set attributes = ${sql.json(patch.attributes)}, attributes_text = ${patch.text}, problems = ${problems}, updated_at = now()
		where id = ${p.id} and not cancelled and product_id is null and listed_at is null and category_id = ${p.category}
		and attributes is not distinct from ${draft.attributes === null ? null : sql.json(draft.attributes)}
		and problems is not distinct from ${draft.problems}
		and not exists (select 1 from writes where params->>'listingId' = ${p.id} and op in ('建商品', '上架')
			and status in ('待执行','已提交','结果未知','不一致'))
		returning category_id, attributes_text`;
	if (!saved) throw new Usage("草稿的资料或发布状态已变化，未修改属性");
	return { id: p.id, category: String(saved.category_id), before: draft.attributes_text, attributes: saved.attributes_text };
}
