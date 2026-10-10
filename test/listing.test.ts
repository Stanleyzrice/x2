import assert from "node:assert/strict";
import { test } from "node:test";
import { margin, minPrice, payout, type PriceParams } from "../src/listing/price.ts";

// 两家店的参数：lilto 的 landed-cost.json（2026-09-02 依账单和结算截图定）
const base = { fx: 4.4, pricePerKgRmb: 10.8, labelFeeRmb: 1.5, weightRoundingKg: 0.01, returnLossRate: 0.03, minMarginRate: 0.25, minMarginRmb: 8, commissionRate: 0.06, preOrderRate: 0.03, paymentRate: 0.025, freeShippingRate: 0.06, shippingNetTwd: 0 };
const ni1206: PriceParams = { ...base, coinRate: 0, freeShippingMinTwd: 60 };
const cheer: PriceParams = { ...base, coinRate: 0.015, freeShippingMinTwd: 0 };

test("平台进账：费用逐项四舍五入，免运方案费有每单最低（对过真结算）", () => {
	assert.equal(payout(199, ni1206, true).payoutTwd, 116); // 12+6+5+60=83
	assert.equal(payout(199, ni1206, false).payoutTwd, 122);
	assert.deepEqual([payout(1000, ni1206, true).feeTwd, payout(1000, ni1206, true).payoutTwd], [175, 825]);
	assert.equal(payout(617, cheer, true).payoutTwd, 500); // 37+19+15+9+37=117
});

test("核价：两道门都过的最小整数售价（和 lilto 的验算、真站在售价一致）", () => {
	assert.equal(minPrice(19.9, 0, 1.6, cheer, true), 295); // cheeroutdoor 的雨衣，就是在售价
	assert.equal(minPrice(6.9, 0, 3.4, cheer, true), 345);
	assert.equal(minPrice(14.9, 0, 3.4, cheer, true), 404);
	assert.equal(minPrice(2.0, 0, 0.4, cheer, true), 89);
	assert.equal(minPrice(6.9, 0, 3.4, ni1206, true), 386);
	assert.equal(minPrice(14.9, 0, 3.4, ni1206, true), 440);
	assert.equal(minPrice(2.0, 0, 0.4, ni1206, true), 153); // 便宜的货是 ¥8 那道门起作用
	const m = margin(386, 6.9, 0, 3.4, ni1206, true);
	assert.equal(m.payoutTwd, 281);
	assert.equal(Math.round(m.profitRmb * 100) / 100, 16.11);
	assert.equal(Math.round(m.rate * 1000) / 10, 25.2);
	// 国内运费照算进成本
	assert.ok(minPrice(19.9, 3, 1.6, cheer, true)! > 295);
});

import { tiersOf, uniqueNames, type Variant, variantsOf } from "../src/listing/variants.ts";

const v = (specs: [string, string][], image: string | null = null): Variant => ({ sku: "", skuId: "", specId: "", specs: specs.map(([label, value]) => ({ label, value })), costRmb: 1, stock: 9, weightKg: 0.3, image });

test("规格：尺寸层只留字母码；两层组合齐全才留两层，规格图挂在第一层", () => {
	const all = [["卡其色", "a.jpg"], ["黑色", "b.jpg"]].flatMap(([c, img]) => ["【M碼】身高【150-158cm】", "【L碼】身高【158-165cm】"].map((s) => v([["顏色", c!], ["尺碼", s]], img!)));
	const { tiers, index } = tiersOf(all);
	assert.deepEqual(tiers.map((t) => t.name), ["顏色", "尺碼"]);
	assert.deepEqual(tiers[1]!.options.map((o) => o.name), ["M", "L"]);
	assert.deepEqual(tiers[0]!.options, [{ name: "卡其色", image: "a.jpg" }, { name: "黑色", image: "b.jpg" }]);
	assert.deepEqual(index, [[0, 0], [0, 1], [1, 0], [1, 1]]);
	// 缺一个组合：合成一层「款式」
	const merged = tiersOf(all.slice(0, 3));
	assert.deepEqual(merged.tiers.map((t) => [t.name, t.options.map((o) => o.name)]), [["款式", ["卡其色 M", "卡其色 L", "黑色 M"]]]);
	// 同一个选项下规格图不一样：定不了
	assert.throws(() => tiersOf([v([["顏色", "紅"]], "a.jpg"), v([["顏色", "紅"]], "b.jpg"), v([["顏色", "藍"]])]), /規格圖|规格图/);
	// 只有一个规格：单层、空名字
	assert.deepEqual(tiersOf([v([])]).tiers, [{ name: "", options: [{ name: "", image: null }] }]);
});

test("规格：选项名去掉括号里的短说明、重名的加 -2；最多 20 字", () => {
	assert.deepEqual([...uniqueNames(["紅色【爆款】", "紅色(新品)", "藍色"], 20).values()], ["紅色", "紅色-2", "藍色"]);
	assert.equal(uniqueNames(["一二三四五六七八九十一二三四五六七八九十多"], 20).get("一二三四五六七八九十一二三四五六七八九十多")!.length, 20);
});

test("规格：只要有货的，只留取值不一样的层，转台湾繁体，货号是 LT<货源>-<规格 id>", () => {
	const offer = {
		offerId: "952803717616", url: "", title: "", image: "", unit: "", minQty: 1,
		props: [{ name: "颜色", values: [] }, { name: "规格", values: [] }],
		skus: [
			{ skuId: "1", specId: "s1", name: "", attrs: ["红色", "标准款"], price: 19.9, stock: 10, image: "r.jpg", weightKg: 1.6 },
			{ skuId: "2", specId: "s2", name: "", attrs: ["蓝色", "标准款"], price: 19.9, stock: 5, image: "b.jpg", weightKg: 1.6 },
			{ skuId: "3", specId: "s3", name: "", attrs: ["黑色", "标准款"], price: 19.9, stock: 0, image: "k.jpg", weightKg: 1.6 },
		],
	};
	const vs = variantsOf(offer);
	assert.deepEqual(vs.map((x) => [x.sku, x.specs]), [
		["LT952803717616-s1", [{ label: "顏色", value: "紅色" }]],
		["LT952803717616-s2", [{ label: "顏色", value: "藍色" }]],
	]);
	assert.equal(vs[0]!.weightKg, 1.6);
});

import { productInfo, readbackProblems } from "../src/listing/product.ts";

const draft = () => ({
	parentSku: "LT952803717616", title: "輕便雨衣 成人連身 防水透氣", description: "<p>防水雨衣</p>", categoryPath: [100001, 101324],
	attributes: [{ attribute_id: 100824, attribute_values: [{ value_id: 4259 }] }], preOrder: true, daysToShip: 10, minPurchase: 1,
	channels: ["30005", "30006", "30019"],
	variants: [
		{ ...v([["顏色", "卡其色"], ["尺碼", "M"]], "k.jpg"), sku: "LT952803717616-1", priceTwd: 295, weightKg: 1.6 },
		{ ...v([["顏色", "卡其色"], ["尺碼", "L"]], "k.jpg"), sku: "LT952803717616-2", priceTwd: 295, weightKg: 1.7 },
		{ ...v([["顏色", "黑色"], ["尺碼", "M"]]), sku: "LT952803717616-3", priceTwd: 299, weightKg: 1.6 },
		{ ...v([["顏色", "黑色"], ["尺碼", "L"]]), sku: "LT952803717616-4", priceTwd: 299, weightKg: 1.6 },
	],
	images: ["tw-11134207-a", "tw-11134207-b"], detail: [{ id: "tw-11134207-d", width: 800, height: 1200 }],
	optionImages: { "k.jpg": "tw-11134207-k" }, sizeChart: "tw-11134207-s",
});

test("product_info：照 9-01 的成功样本；规格图挂第一层；详情图进描述；建成下架；30019 开不了", () => {
	const p = productInfo(draft()) as any;
	assert.equal(p.unlisted, true);
	assert.deepEqual(p.weight, { value: "1.7", unit: 1 });
	assert.deepEqual(p.std_tier_variation_list.map((t: any) => t.custom_value), ["顏色", "尺碼"]);
	assert.deepEqual(p.std_tier_variation_list[0].value_list, [{ id: 0, custom_value: "卡其色", image_id: "tw-11134207-k" }, { id: 0, custom_value: "黑色" }]);
	assert.deepEqual(p.model_list.map((m: any) => [m.sku, m.tier_index, m.price, m.is_default]), [["LT952803717616-1", [0, 0], "295", true], ["LT952803717616-2", [0, 1], "295", false], ["LT952803717616-3", [1, 0], "299", false], ["LT952803717616-4", [1, 1], "299", false]]);
	assert.deepEqual(JSON.parse(p.description_info.description).field_list, [{ type: 0, value: "防水雨衣" }, { type: 1, value: "tw-11134207-d", width: 800, height: 1200 }]);
	assert.deepEqual(p.logistics_channels.filter((c: any) => c.enabled).map((c: any) => c.channelid), [30006, 30005]);
	assert.equal(p.logistics_channels.find((c: any) => c.channelid === 30020).sizeid, 1);
	// 缺图、详情图太窄：不缺着交
	assert.throws(() => productInfo({ ...draft(), optionImages: {} }), /还没传/);
	assert.throws(() => productInfo({ ...draft(), detail: [{ id: "x", width: 1, height: 1 }] }), /尺寸不够/);
});

test("读回来核对：图片可以是地址；价格、库存、规格对不上要写出来", () => {
	const sent = productInfo(draft()) as any;
	const got = {
		...sent, images: sent.images.map((id: string) => `https://cf.shopee.tw/file/${id}`),
		model_list: sent.model_list.map((m: any) => ({ sku: m.sku, tier_index: m.tier_index, price_info: { input_normal_price: Number(m.price) }, stock_detail: { total_seller_stock: m.stock_setting_list[0].sellable_stock } })),
	};
	const channels = sent.logistics_channels.map((c: any) => ({ channel_id: c.channelid, enabled: c.enabled }));
	assert.deepEqual(readbackProblems(sent, got, channels), []);
	got.model_list[2].price_info.input_normal_price = 199;
	got.name = "別的標題";
	assert.deepEqual(readbackProblems(sent, got, channels), ["标题和提交的不一致", "规格 LT952803717616-3 的选项、售价或库存和提交的不一致"]);
});

import { daysToShip, pickAttributes, recommendedPath } from "../src/listing/category.ts";

test("属性：只送必填的；是 / 否选否，有其他、一般的选它；要填字的交给人", () => {
	const r = pickAttributes([
		{ id: "100824", name: "智能裝置", mandatory: true, maxValues: 1, values: [{ valueId: "4258", name: "是" }, { valueId: "4259", name: "否" }] },
		{ id: "100001", name: "材質", mandatory: true, maxValues: 1, values: [{ valueId: "1", name: "棉" }, { valueId: "9", name: "其他" }] },
		{ id: "100002", name: "產地", mandatory: false, maxValues: 1, values: [{ valueId: "2", name: "台灣" }] },
		{ id: "100003", name: "型號", mandatory: true, maxValues: 1, values: [] },
	]);
	assert.deepEqual(r.attributes, [{ attribute_id: 100824, attribute_values: [{ value_id: 4259 }] }, { attribute_id: 100001, attribute_values: [{ value_id: 9 }] }]);
	assert.deepEqual(r.text, ["智能裝置：否", "材質：其他"]);
	assert.deepEqual(r.missing, ["型號"]);
});

test("类目：取第一个推荐；出货天数取类目的上限", () => {
	assert.deepEqual(recommendedPath({ category_recommend_list: [{ category_path: [100637, 100728, 101324] }, { category_path: [1, 2] }] })?.path, [100637, 100728, 101324]);
	assert.equal(recommendedPath({ category_recommend_list: [] }), null);
	const rules = [{ categoryIds: ["101324"], min: 2, max: 10 }, { categoryIds: ["100559"], min: 2, max: 15 }];
	assert.equal(daysToShip(101324, rules), 10);
	assert.equal(daysToShip(1, rules), null);
});
