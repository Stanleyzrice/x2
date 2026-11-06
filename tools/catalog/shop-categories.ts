// 店铺导航分类：每次请求绑定店铺与目标，提交一次后用完整成员清单核对；不修改商品平台类目。
import { z } from "zod";
import { liveProducts } from "../../connectors/sites/shopee/products.ts";
import { shop as identity } from "../../connectors/sites/shopee/seller.ts";
import {
	createShopCategory,
	createShopCategoryDraft,
	type ShopCategory,
	setShopCategoryStatus,
	shopCategories,
	shopCategory,
	shopCategoryDrafts,
	sortShopCategories,
} from "../../connectors/sites/shopee/shop-categories.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import type { Planned } from "../../platform/tool.ts";
import { type Outcome, WriteId, type WriteOp, writeOp } from "../../platform/writes.ts";
import { checkIdentity } from "./facts.ts";

const id = z
	.string()
	.regex(/^\d+$/)
	.refine((v) => Number.isSafeInteger(Number(v)) && Number(v) > 0, "id 要是正整数且不丢精度");
const ids = z.preprocess(
	(v) =>
		typeof v === "string"
			? v
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: v,
	z
		.array(id)
		.min(1)
		.refine((a) => new Set(a).size === a.length, "id 不能重复"),
);
const input = z.object({ shop: z.string().min(1), requestId: z.string().uuid() });
export const shopCategoryReadInput = z.object({ shop: z.string().min(1), ids: ids.optional() });
export const shopCategoryDraftInput = input.extend({ name: z.string().trim().min(1).max(40) });
export const shopCategoryCreateInput = shopCategoryDraftInput.extend({ productIds: ids, draftId: id });
export const shopCategoryStatusInput = input.extend({ id, status: z.enum(["active", "inactive"]) });
export const shopCategorySortInput = input.extend({ ids });
const draftParams = shopCategoryDraftInput.extend({ shopId: id });
const createParams = shopCategoryCreateInput.extend({ shopId: id });
const statusParams = shopCategoryStatusInput.extend({ shopId: id });
const sortParams = shopCategorySortInput.extend({ shopId: id });
type Scoped = { shop: string; shopId: string; requestId: string };
const OPS = { draft: "店铺分类草稿", create: "创建店铺分类", status: "店铺分类显示", sort: "店铺分类排序" } as const;
type Action = keyof typeof OPS;
const keyOf = (action: Action, requestId: string) => `shop-category-${action}:${requestId}`;

export function sameMembers(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
	return actual !== undefined && actual.length === expected.length && new Set(actual).size === actual.length && actual.every((s) => expected.includes(s));
}
export function categoryOrder(categories: readonly ShopCategory[]): string[] {
	return [...categories].sort((a, b) => b.sortWeight - a.sortWeight).map((c) => c.id);
}
export function assertCategoryOrder(categories: readonly ShopCategory[], expected: readonly string[]): void {
	if (
		!sameMembers(
			categories.map((c) => c.id),
			expected,
		)
	)
		throw new Usage("分类已增删，排序必须包含当前全部分类 id，请重新读取");
}
export function checkExistingCategory(categories: readonly ShopCategory[], name: string): ShopCategory | undefined {
	const matches = categories.filter((c) => c.name === name);
	if (matches.length > 1) throw new Usage(`同名分类「${name}」不唯一，请先核对`);
	return matches[0];
}
export function assertSameCategoryMembers(category: ShopCategory, expected: readonly string[]): void {
	if (!sameMembers(category.productIds, expected)) throw new Usage(`同名分类「${category.name}」已有不同商品；未覆盖或重复创建`);
}
export function assertCategoryCanHide(category: ShopCategory): void {
	if (category.productCount !== 0) throw new Usage(`分类「${category.name}」仍有 ${category.productCount} 个有效商品，未隐藏`);
}
async function configured(sql: Sql, shop: string): Promise<string> {
	const [s] = await sql<{ shop_id: string }[]>`select shop_id from shop_settings where shop = ${shop}`;
	if (!s) throw new Usage(`没有已配置的店铺 ${shop}`);
	return s.shop_id;
}
async function assertIdentity(p: Scoped): Promise<void> {
	checkIdentity(p, await identity());
}
async function where<T>(sql: Sql, p: Scoped, fn: () => Promise<T>): Promise<T> {
	if ((await configured(sql, p.shop)) !== p.shopId) throw new Usage("店铺配置已改变，未沿用旧分类请求");
	return inAccount("shopee", p.shopId, fn);
}
const target = (p: Scoped) => `shopee:${p.shopId}:shop-categories`;
const tried = (op: string) => async (sql: Sql) => (await sql`select 1 from writes where op = ${op} and status = '已核对' limit 1`).length > 0;

// live_all 在该店的登录上下文中返回商品；严格消费完整分页，防止拿其他店商品或残缺页面创建分类。
async function assertLiveProducts(expected: string[]): Promise<void> {
	const found = new Set<string>();
	let total: number | undefined;
	for (let page = 1; ; page++) {
		const r = await liveProducts(page);
		if (total !== undefined && total !== r.total) throw new Usage("在售商品总数在读取期间变化，未创建分类");
		total = r.total;
		for (const p of r.rows) {
			if (found.has(p.productId)) throw new Usage(`在售商品分页重复：${p.productId}`);
			found.add(p.productId);
		}
		if (found.size === total) break;
		if (!r.rows.length || found.size > total) throw new Usage("在售商品分页不完整，未创建分类");
	}
	const missing = expected.filter((v) => !found.has(v));
	if (missing.length) throw new Usage(`商品不在当前店铺在售列表中：${missing.join(",")}`);
}

export async function readShopCategories(sql: Sql, p: z.output<typeof shopCategoryReadInput>) {
	const shopId = await configured(sql, p.shop);
	return inAccount("shopee", shopId, async () => {
		checkIdentity({ shop: p.shop, shopId }, await identity());
		const categories = await shopCategories();
		const selected = p.ids;
		if (selected) {
			if (!selected.every((v) => categories.some((c) => c.id === v))) throw new Usage("请求的分类不在当前店铺中");
			return { shop: p.shop, shopId, categories: await Promise.all(selected.map(shopCategory)), drafts: await shopCategoryDrafts() };
		}
		return { shop: p.shop, shopId, categories, drafts: await shopCategoryDrafts() };
	});
}

type Frozen = z.output<typeof draftParams> | z.output<typeof createParams> | z.output<typeof statusParams> | z.output<typeof sortParams>;
function normalized(p: Frozen): string {
	return JSON.stringify({
		shop: p.shop,
		shopId: p.shopId,
		requestId: p.requestId,
		...("name" in p ? { name: p.name } : {}),
		...("productIds" in p ? { productIds: [...p.productIds].sort(), draftId: p.draftId } : {}),
		...("id" in p ? { id: p.id, status: p.status } : {}),
		...("ids" in p ? { ids: p.ids } : {}),
	});
}
async function plan(sql: Sql, action: Action, p: Frozen): Promise<Planned[][]> {
	const rows = await sql<
		{ params: Frozen }[]
	>`select params from writes where key = ${keyOf(action, p.requestId)} or key like ${`${keyOf(action, p.requestId)}#%`}`;
	if (rows.length) {
		if (rows.some((r) => normalized(r.params) !== normalized(p))) throw new Usage("同一 requestId 已绑定另一份分类请求，未提交");
		return [];
	}
	return [[{ op: OPS[action], params: p }]];
}
export const planShopCategoryDraft = async (sql: Sql, p: z.output<typeof shopCategoryDraftInput>) =>
	plan(sql, "draft", { ...p, shopId: await configured(sql, p.shop) });
export const planShopCategoryCreate = async (sql: Sql, p: z.output<typeof shopCategoryCreateInput>) =>
	plan(sql, "create", { ...p, shopId: await configured(sql, p.shop) });
export const planShopCategoryStatus = async (sql: Sql, p: z.output<typeof shopCategoryStatusInput>) =>
	plan(sql, "status", { ...p, shopId: await configured(sql, p.shop) });
export const planShopCategorySort = async (sql: Sql, p: z.output<typeof shopCategorySortInput>) =>
	plan(sql, "sort", { ...p, shopId: await configured(sql, p.shop) });

export async function replayShopCategory(sql: Sql, action: Action, p: { requestId: string }): Promise<Outcome> {
	const rows = await sql<{ id: string; batch: string; op: string; display: string; status: string; why: string | null }[]>`
		select id::text, batch::text, op, display, status, error as why from writes
		where key = ${keyOf(action, p.requestId)} or key like ${`${keyOf(action, p.requestId)}#%`} order by id`;
	return {
		ran: rows.map((r) => ({ ...r, id: WriteId.parse(r.id), why: r.why ?? undefined })),
		unknown: rows.some((r) => ["待执行", "已提交", "结果未知", "不一致"].includes(r.status)),
		blocked: null,
	};
}

const draftWrite: WriteOp<z.output<typeof draftParams>> = {
	describe: "创建独立店铺分类草稿",
	params: draftParams,
	target,
	key: (p) => keyOf("draft", p.requestId),
	display: (p) => `${p.shop} 创建分类草稿「${p.name}」`,
	untried: "首次创建店铺分类草稿，请按已确认方案加 --try 执行一类",
	tried: tried(OPS.draft),
	where,
	prepare: async (_sql, p) => {
		await assertIdentity(p);
		const categories = await shopCategories();
		if (checkExistingCategory(categories, p.name)) throw new Usage(`正式分类「${p.name}」已存在，不新建草稿`);
		const drafts = await shopCategoryDrafts();
		const same = drafts.filter((d) => d.name === p.name);
		if (same.length > 1) throw new Usage("同名草稿不唯一，未创建");
		return same.length ? { skip: "同名分类草稿已存在" } : { params: p, before: { categories, drafts } };
	},
	submit: (_sql, p) => createShopCategoryDraft({ name: p.name }),
	check: async (p) => {
		await assertIdentity(p);
		const drafts = await shopCategoryDrafts();
		const matches = drafts.filter((d) => d.name === p.name);
		return { done: matches.length === 1 ? true : matches.length === 0 ? false : null, readback: { drafts, checkedAt: new Date().toISOString() } };
	},
};
const createWrite: WriteOp<z.output<typeof createParams>> = {
	describe: "将草稿创建为独立店铺分类并指定完整商品成员",
	params: createParams,
	target,
	key: (p) => keyOf("create", p.requestId),
	display: (p) => `${p.shop} 创建分类「${p.name}」：${p.productIds.length} 个商品`,
	untried: "首次创建店铺分类，请按已确认方案加 --try 执行一类",
	tried: tried(OPS.create),
	where,
	prepare: async (_sql, p) => {
		await assertIdentity(p);
		const categories = await shopCategories();
		const existing = checkExistingCategory(categories, p.name);
		if (existing) {
			assertSameCategoryMembers(await shopCategory(existing.id), p.productIds);
			return { skip: "同名分类与完整商品成员已经一致" };
		}
		const drafts = await shopCategoryDrafts();
		if (!drafts.some((d) => d.id === p.draftId && d.name === p.name)) throw new Usage("分类草稿编号与名称不匹配，未创建");
		await assertLiveProducts(p.productIds);
		return { params: p, before: { categories, drafts } };
	},
	submit: (_sql, p) => createShopCategory({ name: p.name, productIds: p.productIds, draftId: p.draftId }),
	check: async (p) => {
		await assertIdentity(p);
		const categories = await shopCategories();
		const matches = categories.filter((c) => c.name === p.name);
		if (matches.length !== 1) return { done: matches.length ? null : false, readback: { categories } };
		const observed = await shopCategory(matches[0]!.id);
		const drafts = await shopCategoryDrafts();
		return {
			done:
				observed.name === p.name && observed.type === "customized" && sameMembers(observed.productIds, p.productIds) && !drafts.some((d) => d.id === p.draftId),
			readback: { observed, drafts, checkedAt: new Date().toISOString() },
		};
	},
};
const statusWrite: WriteOp<z.output<typeof statusParams>> = {
	describe: "修改独立店铺分类显示状态",
	params: statusParams,
	target,
	key: (p) => keyOf("status", p.requestId),
	display: (p) => `${p.shop} 分类 ${p.id} → ${p.status}`,
	untried: "首次修改店铺分类显示，请按已确认方案加 --try 执行一类",
	tried: tried(OPS.status),
	where,
	prepare: async (_sql, p) => {
		await assertIdentity(p);
		const categories = await shopCategories();
		const found = categories.find((c) => c.id === p.id);
		if (!found) throw new Usage("分类不在当前店铺中");
		if (found.status === p.status) return { skip: "分类已经是目标显示状态" };
		if (p.status === "inactive") assertCategoryCanHide(found);
		return { params: p, before: found };
	},
	submit: (_sql, p) => setShopCategoryStatus({ id: p.id, status: p.status }),
	check: async (p) => {
		await assertIdentity(p);
		const observed = (await shopCategories()).find((c) => c.id === p.id);
		return { done: observed ? observed.status === p.status : null, readback: { observed, checkedAt: new Date().toISOString() } };
	},
};
const sortWrite: WriteOp<z.output<typeof sortParams>> = {
	describe: "设置当前店铺全部分类的显示顺序",
	params: sortParams,
	target,
	key: (p) => keyOf("sort", p.requestId),
	display: (p) => `${p.shop} 排列 ${p.ids.length} 个店铺分类`,
	untried: "首次修改店铺分类排序，请按已确认方案加 --try 执行",
	tried: tried(OPS.sort),
	where,
	prepare: async (_sql, p) => {
		await assertIdentity(p);
		const categories = await shopCategories();
		assertCategoryOrder(categories, p.ids);
		if (categoryOrder(categories).every((v, i) => v === p.ids[i])) return { skip: "分类顺序已一致" };
		return { params: p, before: categories };
	},
	submit: (_sql, p) => sortShopCategories({ ids: p.ids }),
	check: async (p) => {
		await assertIdentity(p);
		const observed = await shopCategories();
		const order = categoryOrder(observed);
		return { done: sameMembers(order, p.ids) && order.every((v, i) => v === p.ids[i]), readback: { observed, checkedAt: new Date().toISOString() } };
	},
};
export const SHOP_CATEGORY_WRITES = {
	[OPS.draft]: writeOp(draftWrite),
	[OPS.create]: writeOp(createWrite),
	[OPS.status]: writeOp(statusWrite),
	[OPS.sort]: writeOp(sortWrite),
};
