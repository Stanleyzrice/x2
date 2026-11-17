// 仅准备来源的正式入口须在任何图片、模型和类目调用前保存，完整来源可直接用于独立审图。
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { OfferId } from "../../connectors/sites/1688/api.ts";
import type { Sql } from "../../platform/db/index.ts";
import { listing } from "./index.ts";
import { make } from "./make.ts";
import { reviewedImagesPreview } from "./reviewed-images.ts";
import { ListingId, type ListingRow, type ShopSettingsRow } from "./row.ts";
import { sourceProductSchema } from "./source-data.ts";
import { specsOf } from "./variants.ts";

function fixture() {
	const source = sourceProductSchema.parse({
		platform: "1688",
		sourceId: "123",
		url: "https://detail.1688.com/offer/123.html",
		title: "折叠桌",
		images: ["https://source.invalid/main.jpg"],
		props: [
			{
				name: "颜色",
				values: [
					{ name: "黑色", image: "https://source.invalid/black.jpg" },
					{ name: "蓝色", image: "https://source.invalid/blue.jpg" },
				],
			},
		],
		skus: [
			{ id: "black", specId: "spec-black", name: "黑色", attrs: ["黑色"], price: 20, stock: 30, image: "https://source.invalid/black.jpg", weightKg: 2 },
			{ id: "blue", specId: "spec-blue", name: "蓝色", attrs: ["蓝色"], price: 25, stock: 30, image: "https://source.invalid/blue.jpg", weightKg: 2 },
		],
		description: { text: "折叠桌介绍", images: Array.from({ length: 20 }, (_, i) => `https://source.invalid/detail-${i}.jpg`), blocks: [] },
		minQty: 1,
		freightRmb: 3,
		freeShipping: false,
		errors: [],
	});
	const row: ListingRow = {
		id: ListingId.parse("1"),
		shop: "cheeroutdoor",
		offer_id: OfferId.parse("123"),
		source_product_id: "14",
		source_fields: { detailImages: [source.description.images[0]!] },
		strategy: "人选",
		cancelled: false,
		weight_kg: "3",
		freight_rmb: "5",
		title: "人工標題",
		description: "人工介紹",
		nickname: "人工简称",
		note: null,
		noted: null,
		offer: null,
		offer_read_at: null,
		category_id: null,
		category_path: null,
		category_name: null,
		attributes: null,
		attributes_text: null,
		days_to_ship: null,
		variants: null,
		images: { imageMode: "original" },
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
	const settings: ShopSettingsRow = {
		shop: "cheeroutdoor",
		shop_id: "fixture-shop",
		pricing_template: null,
		fx: "4.8",
		price_per_kg_rmb: "10",
		label_fee_rmb: "1.5",
		weight_rounding_kg: "0.1",
		return_loss_rate: "0",
		min_margin_rate: "0.2",
		min_margin_rmb: "1",
		commission_rate: "0.1",
		pre_order_rate: "0",
		payment_rate: "0.02",
		coin_rate: "0",
		free_shipping_rate: "0",
		free_shipping_min_twd: "0",
		shipping_net_twd: "0",
		pre_order: true,
		min_purchase: 1,
		stock_cap: 5,
		channels: null,
		categories: null,
		watermark_text: null,
		watermark_size: 24,
		watermark_opacity: "0.5",
		watermark_position: "center",
		paused: null,
	};
	const queries: string[] = [];
	let saved: Record<string, unknown> | undefined;
	let acceptSave = true;
	const sql = Object.assign(
		(query: unknown, ...values: unknown[]) => {
			if (!Array.isArray(query)) return query;
			const text = query.join("").replace(/\s+/g, " ").trim();
			queries.push(text);
			if (text.startsWith("select * from listings")) return Promise.resolve([row]);
			if (text.startsWith("select * from shop_settings")) return Promise.resolve([settings]);
			if (text.startsWith("select snapshot from listing_sources")) return Promise.resolve([{ snapshot: source }]);
			if (text.startsWith("update listings")) {
				saved = values[0] as Record<string, unknown>;
				return Promise.resolve(acceptSave ? [{ id: row.id }] : []);
			}
			throw new Error(`仅准备不得调用图片或其他SQL：${text}`);
		},
		{ json: (value: unknown) => value },
	) as unknown as Sql;
	return {
		row,
		source,
		settings,
		sql,
		queries,
		saved: () => saved!,
		rejectSave: () => {
			acceptSave = false;
		},
	};
}

test("prepare-only仅接受显式单稿，不能与reviewed续做混用", () => {
	const params = listing.tools.make!.params;
	assert.equal(params.safeParse({ ids: "1", prepareOnly: true }).success, true);
	assert.equal(params.safeParse({ prepareOnly: true }).success, false);
	assert.equal(params.safeParse({ ids: "1,2", prepareOnly: true }).success, false);
	assert.equal(params.safeParse({ ids: "1", prepareOnly: true, imageMode: "reviewed" }).success, false);
});

test("prepare-only保存完整详情和已核规格，保留人工文案与成本，不碰图片、模型或浏览器", async () => {
	const f = fixture();
	const fetch = mock.method(globalThis, "fetch", () => {
		throw new Error("仅准备不得发起外部请求");
	});
	try {
		const result = await make(f.sql, f.row.id, () => {}, { prepareOnly: true });
		const saved = f.saved();
		assert.ok(saved.offer, "来源必须在任何图片处理之前保存");
		const offer = saved.offer as { detail: string[] };
		assert.deepEqual(offer.detail, f.source.description.images, "人工图片子集不能隐藏完整详情来源");
		assert.equal(specsOf(saved.variants)!.variants[0]!.stock, 5);
		assert.equal(specsOf(saved.variants)!.variants[0]!.costRmb, 20);
		assert.ok(specsOf(saved.variants)!.variants[0]!.priceTwd);
		assert.equal((saved.pricing as { freightRmb: number }).freightRmb, 5);
		assert.deepEqual([saved.title, saved.description, saved.nickname], ["人工標題", "人工介紹", "人工简称"]);
		for (const field of ["images", "audit", "source_fields", "weight_kg", "freight_rmb", "category_path", "attributes", "days_to_ship"])
			assert.equal(field in saved, false, `${field}不应被仅准备覆盖`);
		assert.match(result.problems.join("\n"), /缺可用的主图.*待.*审阅/);
		assert.equal(fetch.mock.callCount(), 0);
		assert.equal(f.queries.length, 4, "仅查稿、店铺、采集快照并保存一次");
		assert.match(f.queries[3]!, /source_fields is not distinct from/);
		const ready = { ...f.row, ...saved } as ListingRow;
		assert.equal(reviewedImagesPreview(ready).sourceDetailCount, 20);
		assert.equal(reviewedImagesPreview(ready).requiredOptions.length, 2);
	} finally {
		fetch.mock.restore();
	}
});

test("prepare-only无需processed水印，并保留并发人工修改保护", async () => {
	const f = fixture();
	f.row.images = { imageMode: "processed" };
	f.rejectSave();
	await assert.rejects(
		make(f.sql, f.row.id, () => {}, { prepareOnly: true }),
		/准备期间商品资料或提交状态已变化/,
	);
	assert.ok(f.saved().offer);
});

test("prepare-only拒绝已建商品和已审图稿，不能通过显式original重排已审来源", async () => {
	for (const override of [{ product_id: "published" }, { listed_at: new Date() }, { images: { imageMode: "reviewed" as const } }]) {
		const f = fixture();
		Object.assign(f.row, override);
		await assert.rejects(
			make(f.sql, f.row.id, () => {}, { prepareOnly: true, imageMode: "original" }),
			/已建商品|已审图片/,
		);
		assert.equal(f.saved(), undefined);
	}
});
