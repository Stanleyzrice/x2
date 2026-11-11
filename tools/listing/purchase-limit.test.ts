// 单稿起购量进入原生商品参数；空值沿用店铺默认，草稿工具不能修改已建或已上架商品。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type Offer, OfferId, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import { productInfoOf } from "../../connectors/sites/shopee/products.ts";
import type { Sql } from "../../platform/db/index.ts";
import { reprice, settingsOf } from "./pricing.ts";
import { productInfo, readbackProblems } from "./product.ts";
import { purchaseLimitParams, purchaseLimitPatch, setPurchaseLimit } from "./purchase-limit.ts";
import { productOf } from "./ready.ts";
import { ListingId, type ListingRow } from "./row.ts";
import { type Specs, specsOf } from "./variants.ts";

function settings(minimum = 1) {
	return settingsOf({
		shop: "ni1206",
		shop_id: "348425",
		pricing_template: null,
		fx: "4.8",
		price_per_kg_rmb: "10",
		label_fee_rmb: "1.5",
		weight_rounding_kg: "0.01",
		return_loss_rate: "0",
		min_margin_rate: "0.2",
		min_margin_rmb: "0",
		commission_rate: "0.16",
		pre_order_rate: "0",
		payment_rate: "0",
		coin_rate: "0",
		free_shipping_rate: "0",
		free_shipping_min_twd: "0",
		shipping_net_twd: "0",
		pre_order: true,
		min_purchase: minimum,
		stock_cap: 50,
		channels: "30005",
		categories: null,
		watermark_text: "shop",
		watermark_size: 20,
		watermark_opacity: "0.2",
		watermark_position: "bottom-right",
		paused: null,
	});
}

function draft(minimum?: number | null): ListingRow & { min_purchase?: number | null } {
	const offer: Offer = {
		offerId: OfferId.parse("991756966145"),
		url: "https://detail.1688.com/offer/991756966145.html",
		title: "花卉抱枕套",
		image: "cover.jpg",
		unit: "只",
		minQty: 1,
		props: [],
		skus: [{ skuId: SkuId.parse("1"), specId: SpecId.parse("a"), name: "花卉", attrs: [], price: 8.5, stock: 20, image: "cover.jpg", weightKg: 0.4 }],
		tags: { onePsale: true, freeShipping: true, ship48h: true, deliveryDays: 2 },
		freight: { costRmb: 0, to: "东莞" },
	};
	const variants: Specs = {
		tiers: [{ source: "", name: "", options: [{ source: "", name: "", image: null }] }],
		variants: [
			{ sku: "LT991756966145-a", skuId: SkuId.parse("1"), specId: SpecId.parse("a"), options: [0], costRmb: 8.5, stock: 20, weightKg: 0.4, priceTwd: 149 },
		],
	};
	return {
		id: ListingId.parse("87"),
		shop: "ni1206",
		offer_id: offer.offerId,
		strategy: "人选",
		cancelled: false,
		weight_kg: null,
		freight_rmb: null,
		min_purchase: minimum,
		title: "花卉抱枕套 不含枕芯",
		description: "花卉抱枕套，單套販售。",
		note: null,
		noted: null,
		nickname: "花卉抱枕套",
		offer,
		offer_read_at: new Date(0),
		category_id: "101166",
		category_path: [100636, 101166],
		category_name: "抱枕、靠墊",
		attributes: [],
		attributes_text: null,
		days_to_ship: 10,
		variants,
		images: { main: [{ from: "cover.jpg", imageId: "cover", width: 800, height: 800 }], detail: [], options: [] },
		pricing: null,
		audit: null,
		problems: null,
		step: null,
		step_detail: null,
		product_id: null,
		listed_at: null,
		removed_images: [],
		removed_variants: [],
		kept_images: [],
		pick_why: null,
		pick_evidence: null,
		pick_snapshot: null,
		created_at: new Date(0),
		updated_at: new Date(0),
	};
}

test("单稿两件起购进入productOf和原生min_purchase_limit，其他稿和店铺默认不变", () => {
	const row = draft(2),
		shop = settings();
	const beforeRow = structuredClone(row),
		beforeShop = structuredClone(shop);
	const result = productOf(row, shop),
		other = productOf(draft(), shop);
	assert.deepEqual(result.problems, []);
	assert.equal(result.product?.minPurchase, 2);
	assert.equal(result.info?.min_purchase_limit, 2);
	assert.equal(other.product?.minPurchase, 1);
	assert.equal(other.info?.min_purchase_limit, 1);
	assert.notEqual(result.hash, other.hash);
	assert.deepEqual(row, beforeRow);
	assert.deepEqual(shop, beforeShop);
});

test("单稿起购量null或旧fixture未提供时沿用真实店铺默认", () => {
	for (const minimum of [undefined, null]) {
		const old = draft(minimum);
		if (minimum === undefined) delete old.min_purchase;
		assert.equal(productOf(old, settings()).info?.min_purchase_limit, 1);
		assert.equal(productOf(old, settings(3)).info?.min_purchase_limit, 3);
	}
});

test("单稿明确一件起购优先于店铺三件默认", () => {
	assert.equal(productOf(draft(1), settings(3)).info?.min_purchase_limit, 1);
});

test("发布重核采用实际起购数量，不能把两件订单通过状态沿用于一件", () => {
	const row = draft(2),
		shop = settings();
	shop.template = { fx: 4.8, feeRate: 0.16, freightPerKgRmb: 10, labelFeeRmb: 1.5, minMargin: 0.2, maxMargin: 0.3 };
	const specs = specsOf(row.variants)!;
	specs.variants[0]!.pricingInput = { costRmb: 6.26, chargeableWeightKg: 0.4, priceTwd: 105, freightRmbPerUnit: 3 };
	row.variants = specs;
	const calculated = reprice(row, shop)!;
	row.variants = calculated.specs;
	row.pricing = { model: "template", params: shop.template, freightRmb: calculated.freightRmb, minimumPurchase: calculated.minimumPurchase };
	const two = productOf(row, shop);
	assert.deepEqual(two.problems, []);
	assert.equal(two.info?.min_purchase_limit, 2);
	assert.equal(two.product!.variants[0]!.priceTwd, 105);
	const one = { ...row, min_purchase: 1 };
	assert.equal(productOf(one, shop).info, undefined);
	assert.match(productOf(one, shop).problems.join(), /重新核价/);
	const rechecked = reprice(one, shop)!;
	assert.match(rechecked.specs.variants[0]!.pricingProblem!, /19\.67%/);
	assert.match(productOf({ ...one, variants: rechecked.specs, pricing: { ...row.pricing, minimumPurchase: 1 } }, shop).problems.join(), /19\.67%/);
	const fallback = { ...row, min_purchase: null };
	shop.minPurchase = 2;
	assert.deepEqual(productOf(fallback, shop).problems, []);
});

function purchaseReadback(minimum: number) {
	const sent = productInfo(productOf(draft(minimum), settings()).product!);
	const raw = {
		...sent,
		model_list: sent.model_list.map((m) => ({
			sku: m.sku,
			tier_index: m.tier_index,
			price_info: { input_normal_price: m.price },
			stock_detail: { total_seller_stock: m.stock_setting_list[0]!.sellable_stock },
		})),
	};
	const got = (actual: unknown) => productInfoOf({ data: { product_info: { ...raw, min_purchase_limit: actual } } });
	const channels = sent.logistics_channels.map((c) => ({ channel_id: c.channelid, enabled: c.enabled }));
	return { sent, got, channels };
}

test("两件及以上起购必须读回明确相等的原生值，缺失或退回一件不能算核对通过", () => {
	for (const minimum of [2, 3]) {
		const { sent, got, channels } = purchaseReadback(minimum);
		for (const actual of [minimum, String(minimum)]) {
			assert.equal(got(actual).min_purchase_limit, actual, "现有Connector保留原生字段，不需要另加经营逻辑");
			assert.deepEqual(readbackProblems(sent, got(actual), channels), []);
		}
		for (const actual of [undefined, null, 0, 1, "1", minimum + 1, true, [minimum]])
			assert.deepEqual(readbackProblems(sent, got(actual), channels), ["最低购买数量和提交的不一致"], `提交${minimum}，实际${String(actual)}`);
	}
});

test("原一件起购读回缺失或0/1的legacy行为保持不变", () => {
	const { sent, got, channels } = purchaseReadback(1);
	for (const actual of [undefined, null, 0, 1, "1"]) assert.deepEqual(readbackProblems(sent, got(actual), channels), []);
});

test("purchase-limit 参数只接受数据库int范围内的正整数，不把缺失或零当作店铺默认", () => {
	assert.equal(purchaseLimitParams.parse({ id: "87", minimum: "2" }).minimum, 2);
	assert.equal(purchaseLimitParams.safeParse({ id: "87", minimum: 2_147_483_647 }).success, true);
	for (const minimum of [undefined, null, 0, -1, 1.5, "2.5", Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])
		assert.equal(purchaseLimitParams.safeParse({ id: "87", minimum }).success, false, `不接受${String(minimum)}`);
	assert.equal(purchaseLimitParams.safeParse({ id: "not-an-id", minimum: 2 }).success, false);
});

test("最低购买数量纯修改只给本稿一个字段，拒绝已建或已上架商品", () => {
	const row = { product_id: null, listed_at: null };
	assert.deepEqual(purchaseLimitPatch(row, 2), { min_purchase: 2 });
	assert.deepEqual(row, { product_id: null, listed_at: null });
	assert.throws(() => purchaseLimitPatch(row, 0));
	assert.throws(() => purchaseLimitPatch({ ...row, product_id: "123" }, 2), /已经建成或上架/);
	assert.throws(() => purchaseLimitPatch({ ...row, listed_at: new Date(0) }, 2), /已经建成或上架/);
});

type LimitRow = Pick<ListingRow, "id" | "product_id" | "listed_at" | "min_purchase">;

/** 只记录语句、返回固定行，不实现数据库筛选，也不连接真实数据库。 */
function store(row: LimitRow | undefined) {
	const queries: { text: string; values: unknown[] }[] = [];
	let transactions = 0;
	const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const text = strings.join("?").replace(/\s+/g, " ").trim();
		queries.push({ text, values });
		if (text.startsWith("select ")) return row ? [row] : [];
		if (text.startsWith("update ")) return [];
		throw new Error(`测试未预期的SQL：${text}`);
	};
	const sql = Object.assign(tagged, {
		begin: async (fn: (tx: Sql) => Promise<unknown>) => {
			transactions++;
			return fn(tagged as unknown as Sql);
		},
	}) as unknown as Sql;
	return { sql, queries, transactions: () => transactions };
}

test("purchase-limit handler 现读已建/已上架标志后拒绝，事务内不发update", async () => {
	const base: LimitRow = { id: ListingId.parse("87"), product_id: null, listed_at: null, min_purchase: null };
	for (const changes of [{ product_id: "123" }, { product_id: "" }, { listed_at: new Date(0) }]) {
		const db = store({ ...base, ...changes });
		await assert.rejects(() => setPurchaseLimit(db.sql, purchaseLimitParams.parse({ id: "87", minimum: 2 })), /已经建成或上架/);
		assert.equal(db.transactions(), 1);
		assert.equal(db.queries.length, 1);
		assert.match(db.queries[0]!.text, /from listings where id = \? for update$/);
		assert.deepEqual(db.queries[0]!.values, ["87"]);
	}
});

test("purchase-limit handler 锁住未建稿后只保存本稿min_purchase，保留其他字段和全店设置", async () => {
	for (const before of [null, 3]) {
		const row: LimitRow = { id: ListingId.parse("89"), product_id: null, listed_at: null, min_purchase: before };
		const db = store(row);
		const result = await setPurchaseLimit(db.sql, purchaseLimitParams.parse({ id: "89", minimum: 2 }));
		assert.deepEqual(result, { id: "89", minimum: 2, before });
		assert.equal(db.transactions(), 1);
		assert.equal(db.queries.length, 2);
		assert.match(db.queries[0]!.text, /select .*product_id, listed_at, min_purchase from listings where id = \? for update$/);
		assert.equal(db.queries[1]!.text, "update listings set min_purchase = ?, updated_at = now() where id = ?");
		assert.deepEqual(db.queries[1]!.values, [2, "89"]);
		assert.deepEqual(row, { id: "89", product_id: null, listed_at: null, min_purchase: before });
	}
});

test("purchase-limit handler 找不到稿件时不发update", async () => {
	const db = store(undefined);
	await assert.rejects(() => setPurchaseLimit(db.sql, purchaseLimitParams.parse({ id: "87", minimum: 2 })), /没有商品稿/);
	assert.equal(db.transactions(), 1);
	assert.equal(db.queries.length, 1);
});
