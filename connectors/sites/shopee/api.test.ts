// Shopee 卖家中心的回包解析：拿 fixtures 里的样本（照代码和 NOTES.md 写的）跑解析，看解析出来的样子；回包变了要说哪个接口、哪一格
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { reply } from "../../../platform/reply.ts";
import { conversation, message } from "./chat.ts";
import { productTrafficOf } from "./marketing.ts";
import { orderIndexOf, ordersOf } from "./orders.ts";
import { attributesOf, liveProductsOf, performanceOf, productAttribute, productInfoOf, unlistRequest, unlistResult } from "./products.ts";
import { editProductInfo } from "./publish.ts";
import { ItemId, listingHeaders } from "./seller.ts";

const sample = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("逐日商品来源分开统计搜索和推荐，分项未配平时拒绝补零", () => {
	const raw = sample("product-traffic-day") as {
		result: { product_card: { total: { product_clicks: number }; breakdown: { source: string; product_clicks: number }[] } };
	};
	assert.deepEqual(productTrafficOf(raw), { total: 12, search: 1, recommendation: 10 });
	const card = raw.result.product_card;
	card.breakdown = card.breakdown.filter((row) => row.source !== "psd_label_search");
	assert.throws(() => productTrafficOf(raw), /来源汇总不完整/);
	card.total.product_clicks = 11;
	assert.deepEqual(productTrafficOf(raw), { total: 11, search: 0, recommendation: 10 });
});

test("显式 Size Chart 只组装 size_chart_info，不连带主图、描述、规格或库存", () => {
	const explicit = { title: "泳裝", sizeChartInfo: { size_chart: "tw-size-chart", size_chart_id: 0 } };
	assert.deepEqual(editProductInfo(explicit), { name: "泳裝", size_chart_info: explicit.sizeChartInfo });
	assert.deepEqual(editProductInfo({ title: "泳裝" }), { name: "泳裝" });
});

test("详情图真回包保留富文本原文和图片顺序，站点不回图片宽高", () => {
	const p = productInfoOf(sample("get-product-description-images"));
	const rich = JSON.parse(p.description_info!.description!) as { field_list: { type: number; value: string; width?: number; height?: number }[] };
	const images = rich.field_list.filter((f) => f.type === 1);
	assert.equal(p.description_info!.description_type, "json");
	assert.equal(images.length, 4);
	assert.equal(images[0]!.value, "tw-11134207-820l6-mv4hwnecl6h356");
	assert.ok(images.every((f) => f.width === undefined && f.height === undefined));
	assert.ok(rich.field_list[0]!.value.includes("商品介紹"));
});

test("列表签名：绑定请求体、店铺、当前会话，照网页把时间四舍五入到秒；缺登录态不提交", () => {
	const a = listingHeaders('{"unlisted":true}', "348425", "test-cds", 1600000000500);
	assert.equal(a["sc-listing-sign-t"], "1600000001");
	assert.equal(a["sc-listing-sign-v"], "1.0.0");
	assert.notEqual(a["sc-listing-sign"], listingHeaders('{"unlisted":false}', "348425", "test-cds", 1600000000500)["sc-listing-sign"]);
	assert.notEqual(a["SPC-SLT"], listingHeaders('{"unlisted":true}', "2", "test-cds", 1600000000500)["SPC-SLT"]);
	assert.throws(() => listingHeaders("{}", "348425", ""), /重新登录/);
});

test("列表批量下架：只提交一个 id 和 unlisted；逐件回包必须是这个商品成功，缺失、错号不能猜做成", () => {
	const id = ItemId.parse("25000000001");
	assert.deepEqual(unlistRequest(id, "348425"), {
		query: { version: "3.1.0", source: "seller_center" },
		headers: { "Entrance-Identification": "2" },
		listing: { shopId: "348425" },
		body: [{ id: 25000000001, unlisted: true }],
	});
	assert.equal(unlistResult({ result: [{ id: 25000000001, code: 0 }] }, id).kind, "done");
	assert.deepEqual(unlistResult({ result: [{ id: 25000000001, code: 42, message: "blocked" }] }, id), { kind: "refused", code: 42, why: "blocked" });
	assert.equal(unlistResult({ result: [{ id: 1, code: 0 }] }, id).kind, "unknown");
	assert.equal(unlistResult({ result: [] }, id).kind, "unknown");
	assert.equal(unlistResult({}, id).kind, "unknown");
});

test("列表批量下架（真回包摘录）：逐件成功的 id 对得上；多交一条结果不能当单件做成", () => {
	const id = ItemId.parse("25000000001");
	const raw = sample("unlist-product") as { result: Record<string, unknown>[] };
	assert.equal(unlistResult(raw, id).kind, "done");
	raw.result.push({ id: 25000000002, code: 0 });
	assert.equal(unlistResult(raw, id).kind, "unknown");
});

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

test("订单卡片不能借第一张引用补店铺，漏单、重复或错单都报错", () => {
	const refs = [
		{ order_id: 210000000001, shop_id: 1554182542 },
		{ order_id: 210000000002, shop_id: 1554182542 },
	];
	assert.throws(() => ordersOf(sample("get-order-list-card-list"), refs.slice(0, 1)), /订单/);
	assert.throws(() => ordersOf(sample("get-order-list-card-list"), [...refs, { order_id: 3, shop_id: 1554182542 }]), /订单/);
});

test("订单列表总数缺失不是零单，真实零单与数字字符串可解析", () => {
	const real = orderIndexOf(sample("order-index"));
	assert.equal(real.total, 10);
	assert.equal(real.refs.length, 10);
	assert.deepEqual(orderIndexOf({ data: { index_list: [], pagination: { total: "0" } } }), { total: 0, refs: [] });
	assert.throws(() => orderIndexOf({ data: { index_list: [] } }), /pagination/);
	assert.throws(() => orderIndexOf({ data: { index_list: [], pagination: {} } }), /total/);
	assert.throws(() => orderIndexOf({ data: { index_list: [], pagination: { total: -1 } } }), /total/);
});

test("分包裹订单保留所有包裹状态，不把已出货商品隐藏在首个待出货状态里", () => {
	const raw = sample("get-order-list-card-list") as {
		data: { card_list: { package_level_order_card?: { package_list: { status_info: { status: string } }[] } }[] };
	};
	const card = raw.data.card_list[0]!.package_level_order_card!;
	card.package_list.push({ ...card.package_list[0]!, status_info: { status: "Shipped" } });
	const result = ordersOf(raw, [
		{ order_id: 210000000001, shop_id: 1554182542 },
		{ order_id: 210000000002, shop_id: 1554182542 },
	]);
	assert.deepEqual(result[0]!.packageStatuses, ["To ship", "Shipped"]);
});

test("商品资料：读回对账、上架要用的格解析出来，别的原样留着", () => {
	const p = productInfoOf(sample("get-product-info"));
	assert.deepEqual(
		[p.name, p.parent_sku, p.status, p.is_unlisted, p.category_path],
		["浴室地墊 硅藻泥 吸水防滑", "X2-12-cheeroutdoor", 8, true, [100636, 100713, 101174]],
	);
	assert.equal(p.model_list?.[0]?.stock_detail?.seller_stock_info?.[0]?.sellable_stock, 50);
	assert.equal(p.model_list?.[0]?.id, "250000000011");
	assert.equal(p.id, 25000000001);
	assert.deepEqual(productInfoOf(sample("get-product-attributes")).attributes, [{ attribute_id: 100771, attribute_values: [{ value_id: 4004 }] }]);
	assert.throws(() => productInfoOf({ code: 0, data: {} }), /get_product_info 的回包变了：data\.product_info 没有了/);
});

test("商品详情保留原生自填属性 raw_value，读不到 value_id 不补零；写入属性仍要求明确 value_id", () => {
	const p = productInfoOf(sample("custom-attributes"));
	assert.deepEqual(p.attributes, [
		{ attribute_id: 100131, attribute_values: [{ value_id: 1112 }] },
		{ attribute_id: 100999, attribute_values: [{ raw_value: "nil" }] },
	]);
	assert.equal(Object.hasOwn(p.attributes![1]!.attribute_values[0]!, "value_id"), false);
	assert.equal(p.description_info?.description_type, "json");
	assert.equal(productAttribute.safeParse(p.attributes?.[1]).success, false);
	assert.equal(productAttribute.safeParse(p.attributes?.[0]).success, true);
	assert.throws(() => productInfoOf({ code: 0, data: { product_info: { attributes: [{ attribute_id: 100999, attribute_values: [{}] }] } } }), /回包变了/);
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
