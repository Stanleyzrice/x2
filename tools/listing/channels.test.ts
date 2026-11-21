// 单稿渠道进入原生发布参数并读回；缺列旧稿仍沿用店铺，已建商品不能走草稿修改。
import assert from "node:assert/strict";
import { test } from "node:test";
import { OfferId, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import { productInfoOf } from "../../connectors/sites/shopee/products.ts";
import type { Sql } from "../../platform/db/index.ts";
import { auditKey } from "./audit.ts";
import { channelsPatch, listingChannelsParams, setListingChannels } from "./channels.ts";
import { checkListings } from "./check.ts";
import { coverageScope, saveCoverage } from "./coverage.ts";
import { listing } from "./index.ts";
import type { Settings } from "./pricing.ts";
import { type ChannelOption, productInfo, readbackProblems } from "./product.ts";
import { productOf } from "./ready.ts";
import { ListingId, type ListingRow } from "./row.ts";
import { LISTING_WRITES } from "./writes.ts";

function draft(channelIds?: string[] | null, channelOptions?: ChannelOption[] | null): ListingRow {
	return {
		id: ListingId.parse("190"),
		shop: "cheeroutdoor",
		offer_id: OfferId.parse("123"),
		strategy: "人选",
		cancelled: false,
		weight_kg: null,
		freight_rmb: null,
		channel_ids: channelIds,
		channel_options: channelOptions,
		title: "折疊露營桌 黑色便攜款",
		description: "黑色折疊桌，單桌販售。",
		note: null,
		noted: null,
		nickname: "露营桌",
		offer: {
			offerId: OfferId.parse("123"),
			url: "https://detail.1688.com/offer/123.html",
			title: "折叠桌",
			image: "https://source/table.jpg",
			unit: "件",
			minQty: 1,
			props: [],
			skus: [{ skuId: SkuId.parse("sku"), specId: SpecId.parse("spec"), name: "黑色", attrs: [], price: 20, stock: 30, weightKg: 2, image: "" }],
			tags: { onePsale: true, ship48h: true, freeShipping: false, deliveryDays: 2 },
			freight: { costRmb: 3, to: "东莞" },
		},
		offer_read_at: new Date(0),
		category_id: "101169",
		category_path: [100636, 101169],
		category_name: "桌子",
		attributes: [],
		attributes_text: null,
		days_to_ship: 15,
		variants: {
			tiers: [{ source: "", name: "", options: [{ source: "", name: "", image: null }] }],
			variants: [{ sku: "LT123-spec", skuId: "sku", specId: "spec", options: [0], costRmb: 20, weightKg: 2, priceTwd: 329, stock: 30 }],
		},
		images: { main: [{ from: "https://source/table.jpg", imageId: "table", width: 800, height: 800 }], detail: [], options: [] },
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

const settings: Settings = {
	shop: "cheeroutdoor",
	shopId: "1554182542",
	params: {
		fx: 4.8,
		pricePerKgRmb: 10,
		labelFeeRmb: 1.5,
		weightRoundingKg: 0.01,
		returnLossRate: 0,
		minMarginRate: 0.2,
		minMarginRmb: 0,
		commissionRate: 0.16,
		preOrderRate: 0,
		paymentRate: 0,
		coinRate: 0,
		freeShippingRate: 0,
		freeShippingMinTwd: 0,
		shippingNetTwd: 0,
	},
	template: null,
	mark: null,
	paused: null,
	preOrder: true,
	minPurchase: 1,
	stockCap: 50,
	channels: ["30005", "30006", "30015", "30020"],
	categories: null,
};

test("本稿渠道覆盖进入payload并关闭其他渠道，不改变店铺或其他稿默认", () => {
	const row = draft(["30020"]),
		beforeRow = structuredClone(row),
		beforeShop = structuredClone(settings);
	const changed = productOf(row, settings),
		original = productOf(draft(), settings);
	assert.deepEqual(changed.problems, []);
	const enabled = (result: typeof changed) =>
		productInfo(result.product!)
			.logistics_channels.filter((c) => c.enabled)
			.map((c) => String(c.channelid));
	assert.deepEqual(enabled(changed), ["30020"]);
	assert.deepEqual(new Set(enabled(original)), new Set(settings.channels));
	assert.notEqual(changed.hash, original.hash, "既有发布指纹须保护渠道变更");
	for (const channelIds of [null, undefined]) assert.deepEqual(enabled(productOf(draft(channelIds), settings)), enabled(original));
	assert.deepEqual(row, beforeRow);
	assert.deepEqual(settings, beforeShop);

	const product = changed.product!;
	const sent = productInfo(product);
	const got = productInfoOf({
		data: {
			product_info: {
				...sent,
				model_list: product.variants.map((v) => ({
					sku: v.sku,
					tier_index: v.options,
					price_info: { input_normal_price: String(v.priceTwd) },
					stock_detail: { total_seller_stock: v.stock },
				})),
			},
		},
	});
	const channels = (sent.logistics_channels as { channelid: number; enabled: boolean }[]).map((c) => ({ channel_id: c.channelid, enabled: c.enabled }));
	assert.deepEqual(readbackProblems(sent, got, channels), []);
	assert.deepEqual(
		readbackProblems(
			sent,
			got,
			channels.map((c) => (c.channel_id === 30005 ? { ...c, enabled: true } : c)),
		),
		["物流渠道和提交的不一致"],
	);
});

test("channels命令只接受非空已知字符串渠道集合，重复值合并", () => {
	assert.ok(listing.tools.channels);
	assert.deepEqual(listingChannelsParams.parse({ id: "190", channels: "30020,30018,30020" }), { id: "190", channels: ["30020", "30018"] });
	for (const channels of [undefined, null, "", [], [30020], ["unknown"], ["30020", ""]])
		assert.equal(listingChannelsParams.safeParse({ id: "190", channels }).success, false);
	assert.throws(() => channelsPatch({ product_id: null, listed_at: null }, []));
	assert.throws(() => channelsPatch({ product_id: null, listed_at: null }, ["unknown"]));
});

type ChannelRow = Pick<ListingRow, "id" | "product_id" | "listed_at" | "channel_ids" | "channel_options">;
function store(row: ChannelRow | undefined) {
	const queries: { text: string; values: unknown[] }[] = [];
	const tagged = async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const text = strings.join("?").replace(/\s+/g, " ").trim();
		queries.push({ text, values });
		if (text.startsWith("select ")) return row ? [row] : [];
		if (text.startsWith("update ")) return [{ channel_ids: values[0], channel_options: values[1] }];
		throw new Error(`测试未预期的SQL：${text}`);
	};
	const sql = Object.assign(tagged, {
		json: (value: unknown) => value,
		begin: (fn: (tx: Sql) => Promise<unknown>) => fn(sql),
	}) as unknown as Sql;
	return { sql, queries };
}

test("渠道工具锁住指定未建稿，只更新本稿渠道与档位并返回数据库保存值", async () => {
	const row: ChannelRow = { id: ListingId.parse("190"), product_id: null, listed_at: null, channel_ids: null };
	const db = store(row);
	assert.deepEqual(await setListingChannels(db.sql, { id: row.id, channels: ["30020"] }), {
		id: "190",
		channels: ["30020"],
		options: null,
		before: null,
		beforeOptions: null,
	});
	assert.match(db.queries[0]!.text, /from listings where id = \? for update$/);
	assert.equal(
		db.queries[1]!.text,
		"update listings set channel_ids = ?, channel_options = ?, updated_at = now() where id = ? returning channel_ids, channel_options",
	);
	assert.deepEqual(db.queries[1]!.values, [["30020"], null, "190"]);
	assert.equal(db.queries.length, 2);
	assert.equal(row.channel_ids, null);
});

test("已建、已上架或不存在的稿件不发渠道update", async () => {
	const base: ChannelRow = { id: ListingId.parse("190"), product_id: null, listed_at: null, channel_ids: ["30005"] };
	for (const changes of [{ product_id: "123" }, { product_id: "" }, { listed_at: new Date(0) }]) {
		const db = store({ ...base, ...changes });
		await assert.rejects(() => setListingChannels(db.sql, { id: base.id, channels: ["30020"] }), /已经建成或上架/);
		assert.equal(db.queries.length, 1);
	}
	const db = store(undefined);
	await assert.rejects(() => setListingChannels(db.sql, { id: base.id, channels: ["30020"] }), /没有商品稿/);
	assert.equal(db.queries.length, 1);
});

test("逐渠道档位与金额进入payload和发布核对参数，缺失或错误原生读回不能通过", () => {
	const options: ChannelOption[] = [
		{ channelId: "30020", sizeId: 3, priceTwd: 90 },
		{ channelId: "30017", sizeId: 4, priceTwd: 95 },
	];
	const row = draft(["30020", "30017"], options);
	const result = productOf(row, settings);
	assert.deepEqual(result.problems, []);
	const sent = productInfo(result.product!);
	assert.equal("channelOptions" in sent, false, "只将原生字段提交给Shopee，核对元数据留在WriteOp内");
	for (const option of options) {
		const channel = sent.logistics_channels.find((c) => String(c.channelid) === option.channelId)!;
		assert.equal(channel.enabled, true);
		assert.equal(channel.sizeid, option.sizeId);
		assert.equal(channel.price, String(option.priceTwd));
	}
	assert.notEqual(result.hash, productOf(draft(row.channel_ids), settings).hash);
	const coverage = saveCoverage(row, result.product!, {
		expectedScope: coverageScope(row, result.product!).expectedScope,
		excludedSkus: [],
		detail: [],
		layoutEvidence: "货源与在售规格对应，货源没有详情图。",
	});
	const ready = checkListings([{ ...row, coverage, audit: { key: auditKey(result.product!) } }], new Map([[row.shop, settings]]), []);
	const params = ready.ready[0]!.writes[0]!.params;
	assert.deepEqual(params.channelOptions, options);
	assert.deepEqual((LISTING_WRITES.建商品!.params.parse(params) as { channelOptions?: ChannelOption[] }).channelOptions, options);
	const got = productInfoOf({
		data: {
			product_info: {
				...sent,
				model_list: result.product!.variants.map((v) => ({
					sku: v.sku,
					tier_index: v.options,
					price_info: { input_normal_price: v.priceTwd },
					stock_detail: { total_seller_stock: v.stock },
				})),
			},
		},
	});
	const channels = sent.logistics_channels.map((c) => ({ channel_id: c.channelid, enabled: c.enabled, size_id: c.sizeid, price: Number(c.price).toFixed(2) }));
	assert.deepEqual(readbackProblems(sent, got, channels, options), []);
	for (const field of ["size_id", "price"] as const) {
		for (const value of [undefined, null, "", "wrong", 1]) {
			const changed = channels.map((c) => (c.channel_id === 30020 ? { ...c, [field]: value } : c));
			assert.deepEqual(readbackProblems(sent, got, changed, options), [`物流渠道 30020 ${field === "size_id" ? "档位" : "运费"}和提交的不一致`]);
		}
	}
	assert.deepEqual(
		readbackProblems(
			sent,
			got,
			channels.map(({ size_id: _size, price: _price, ...c }) => c),
		),
		[],
		"历史未保存显式档位的写入沿用旧核对",
	);
});

test("逐渠道输入拒绝未启用渠道、重复渠道及无效档位金额；不传保留覆盖，[]显式清空", async () => {
	const option: ChannelOption = { channelId: "30020", sizeId: 2, priceTwd: 70 };
	assert.deepEqual(listingChannelsParams.parse({ id: "190", channels: "30020", options: JSON.stringify([option]) }).options, [option]);
	for (const options of [
		[option, option],
		[{ ...option, channelId: "30017" }],
		[{ ...option, channelId: "unknown" }],
		[{ ...option, sizeId: -1 }],
		[{ ...option, sizeId: 1.5 }],
		[{ ...option, sizeId: "2" }],
		[{ ...option, priceTwd: -1 }],
		[{ ...option, priceTwd: Number.NaN }],
		[{ ...option, priceTwd: Number.POSITIVE_INFINITY }],
	])
		assert.equal(listingChannelsParams.safeParse({ id: "190", channels: "30020", options }).success, false);
	const row: ChannelRow = { id: ListingId.parse("190"), product_id: null, listed_at: null, channel_ids: ["30020"], channel_options: [option] };
	assert.deepEqual(channelsPatch(row, ["30020"]).channel_options, [option]);
	assert.throws(() => channelsPatch(row, ["30005"]), /本稿启用/);
	assert.deepEqual(channelsPatch(row, ["30005"], []).channel_options, []);
	const db = store(row);
	const next = { ...option, sizeId: 3, priceTwd: 90 };
	const saved = await setListingChannels(db.sql, { id: row.id, channels: ["30020"], options: [next] });
	assert.deepEqual(saved.options, [next]);
	assert.deepEqual(db.queries[1]!.values, [["30020"], [next], "190"]);
});
