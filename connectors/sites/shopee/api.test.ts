// Shopee 卖家中心的回包解析：拿 fixtures 里的样本（照代码和 NOTES.md 写的）跑解析，看解析出来的样子；回包变了要说哪个接口、哪一格
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { reply } from "../../../platform/reply.ts";
import { conversation, message } from "./chat.ts";
import { ordersOf } from "./orders.ts";
import { attributesOf, liveProductsOf, performanceOf, productInfoOf } from "./products.ts";

const sample = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("商品表现（真回包摘录）：id 收成字符串，确认与付款件数分开；没返回的件数不补零", () => {
	const raw = sample("product-performance") as { result: { items: Record<string, unknown>[] } };
	const r = performanceOf(raw);
	assert.equal(typeof r.rows[0]!.id, "string");
	assert.ok(r.rows[0]!.confirmed_units! > 0);
	assert.equal(r.rows[1]!.confirmed_units, 0);
	assert.equal(r.rows[1]!.paid_units, 0);
	delete raw.result.items[1]!.confirmed_units;
	assert.equal(performanceOf(raw).rows[1]!.confirmed_units, undefined);
	raw.result.items[1]!.confirmed_units = "0";
	assert.throws(() => performanceOf(raw), /回包变了/);
});

test("在售列表：商品和规格的 id 收成字符串，价格、库存、销量空的是 null，规格带 tier_index", () => {
	const r = liveProductsOf(sample("get-product-list"));
	assert.equal(r.total, 1);
	assert.deepEqual(r.rows[0], {
		productId: "25000000001",
		parentSku: "X2-12-cheeroutdoor",
		name: "浴室地墊 硅藻泥 吸水防滑",
		cover: "https://down-tw.img.susercontent.com/file/tw-11134207-0000cover",
		createdAt: new Date(1760000000 * 1000).toISOString(),
		models: [
			{ modelId: "250000000011", sku: "X2-12-1", name: "黑貓,60*90cm", price: 299, stock: 50, sold: 3, tierIndex: [0, 1] },
			{ modelId: "250000000012", sku: "", name: "黃狗,60*90cm", price: null, stock: null, sold: null, tierIndex: [1, 1] },
		],
	});
});

test("在售列表变了（商品没有 id）：说哪个接口、哪一格", () => {
	const raw = sample("get-product-list") as { data: { products: Record<string, unknown>[] } };
	delete raw.data.products[0]!.id;
	assert.throws(() => liveProductsOf(raw), /Shopee get_product_list 的回包变了：data\.products\[0\]\.id 没有了/);
});

test("订单卡片：分包裹的和不分包裹的都认；金额除以 100000，规格名去掉前缀和编号，店铺 id 照这一批的引用", () => {
	const refs = [
		{ order_id: 210000000001, shop_id: 1554182542 },
		{ order_id: 210000000002, shop_id: 1554182542 },
	];
	const [a, b] = ordersOf(sample("get-order-list-card-list"), refs);
	assert.deepEqual(a, {
		orderId: "210000000001",
		orderSn: "251009ABCDEF01",
		shopId: "1554182542",
		status: "To ship",
		shipBy: new Date(1760300000 * 1000).toISOString(),
		total: 210,
		items: [
			{
				itemId: "25000000001",
				modelId: "250000000011",
				name: "浴室地墊 硅藻泥",
				spec: "黑貓,60*90cm",
				qty: 2,
				image: "https://down-tw.img.susercontent.com/file/tw-11134207-0000item_tn",
			},
		],
		packages: [{ packageNumber: "OFG000001", channel: "7-ELEVEN", trackingNo: "", status: 1, arrangeBy: null }],
	});
	assert.deepEqual(
		[b?.orderSn, b?.status, b?.total, b?.packages],
		["251009ABCDEF02", "Completed", 150, [{ packageNumber: "OFG000002", channel: "全家", trackingNo: "F0000002", status: 8, arrangeBy: null }]],
	);
	assert.throws(() => ordersOf({ data: { card_list: [{}] } }, refs), /card_list\[0\]：没有 package_level_order_card，也没有 order_card/);
});

test("商品资料：读回对账、上架要用的格解析出来，别的原样留着", () => {
	const p = productInfoOf(sample("get-product-info"));
	assert.deepEqual(
		[p.name, p.parent_sku, p.status, p.is_unlisted, p.category_path],
		["浴室地墊 硅藻泥 吸水防滑", "X2-12-cheeroutdoor", 8, true, [100636, 100713, 101174]],
	);
	assert.equal(p.model_list?.[0]?.stock_detail?.seller_stock_info?.[0]?.sellable_stock, 50);
	assert.equal(p.id, 25000000001);
	assert.throws(() => productInfoOf({ code: 0, data: {} }), /get_product_info 的回包变了：data\.product_info 没有了/);
});

test("属性树：必填、最多几个值、可选值（名字在 display_name 或 name）", () => {
	assert.deepEqual(attributesOf(sample("get-attribute-tree")), [
		{
			id: "100037",
			name: "保固期限",
			mandatory: true,
			maxValues: 1,
			values: [
				{ valueId: "1", name: "無保固" },
				{ valueId: "2", name: "1個月" },
			],
		},
		{ id: "100134", name: "材質", mandatory: false, maxValues: 1, values: [] },
	]);
});

test("聊聊：会话、消息照原样回（值不改），缺了认谁发的格要报", () => {
	const c = reply(z.array(conversation), sample("conversations"), "聊聊 /conversations");
	assert.deepEqual([c[0]?.id, c[0]?.to_id, c[0]?.last_message_time_nano], ["1000000000000000001", 900001, "1761700000000000000"]);
	const m = reply(z.array(message), sample("messages"), "聊聊 /messages");
	assert.deepEqual(
		m.map((x) => [x.id, x.from_shop_id, x.created_timestamp]),
		[
			["m1", 0, 1761700000],
			["m2", 1554182542, "1761700005"],
		],
	);
	assert.throws(() => reply(z.array(message), [{ id: "m3", type: "text" }], "聊聊 /messages"), /\[0\]\.created_timestamp 没有了/);
});
