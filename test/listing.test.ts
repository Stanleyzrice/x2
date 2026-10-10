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

import { matchVariants, tiersOf, uniqueNames, type Variant, variantsOf } from "../src/listing/variants.ts";

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
	assert.throws(() => productInfo({ ...draft(), optionImages: {} }), /未传/);
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

import { checkListings } from "../src/check/listings.ts";
import { acceptIssues, auditDropped, auditIssues, auditKey, auditPassed, dispose, dropAudited, restoreAudited, roleOf } from "../src/listing/audit.ts";
import { type Pics, type TranslatedCheck, translatedDrop } from "../src/listing/images.ts";
import { settingsOf } from "../src/listing/make.ts";
import { productOf } from "../src/listing/ready.ts";

const shopRow = { shop: "cheeroutdoor", shop_id: "1554182542", fx: "4.4", price_per_kg_rmb: "10.8", label_fee_rmb: "1.5", weight_rounding_kg: "0.01", return_loss_rate: "0.03", min_margin_rate: "0.25", min_margin_rmb: "8", commission_rate: "0.06", pre_order_rate: "0.03", payment_rate: "0.025", coin_rate: "0.015", free_shipping_rate: "0.06", free_shipping_min_twd: "0", shipping_net_twd: "0", pre_order: true, min_purchase: 1, stock_cap: 50, channels: "30005,30006", categories: null, watermark_text: "新新家居日用好物賣場", watermark_size: 64, watermark_opacity: "0.35", watermark_position: "center", paused: null };
const pic = (id: string, from = `${id}.jpg`) => ({ from, imageId: id, width: 800, height: 800 });
const ready = (o: Record<string, unknown> = {}) => ({
	id: "7", shop: "cheeroutdoor", offer_id: "952803717616", cancelled: false, listed_at: null, product_id: null, problems: null,
	offer: { title: "雨衣" }, title: "輕便雨衣 成人連身 防水透氣 騎車通勤", description: "防水雨衣，騎車通勤用", category_path: [100637, 101324], days_to_ship: 10, attributes: [],
	variants: [{ ...v([["顏色", "黑色"]], "k.jpg"), sku: "LT952803717616-1", priceTwd: 295, weightKg: 1.6 }, { ...v([["顏色", "綠色"]]), sku: "LT952803717616-2", priceTwd: 295, weightKg: 1.6 }],
	images: { main: [pic("m1")], detail: [], options: [pic("o1", "k.jpg")], waiting: [] }, removed_images: [], audit: null, ...o,
});

test("商品稿的检查：当前步骤、待补充的进收件箱、agent 能做的进 todo", () => {
	const s = new Map([["cheeroutdoor", settingsOf(shopRow)]]);
	const run = (l: any, writes: any[] = []) => checkListings([l], s, writes);
	assert.equal(run(ready({ offer: null })).steps.get("7")!.step, "待做商品稿");
	const fix = run(ready({ problems: "重量：1688 缺 2 个规格的重量" }));
	assert.equal(fix.steps.get("7")!.step, "待补充");
	assert.match(fix.inbox[0]!.title, /待补充：重量/);
	assert.equal(run(ready({ title: null })).todo[0]!.kind, "写文案");
	assert.match(run(ready({ title: "廠家直銷 輕便雨衣 成人連身 防水" })).steps.get("7")!.detail!, /卖家话术：廠家/);
	assert.equal(run(ready()).steps.get("7")!.step, "待台湾审核");
	// 审过了、内容没变：待批准，一批两个写入（建商品、上架）
	const l = ready();
	const key = auditKey(productOf(l, s.get("cheeroutdoor")!).product!, "新新家居日用好物賣場");
	const ok = run({ ...l, audit: { key, textIssues: [], images: [] } });
	assert.equal(ok.steps.get("7")!.step, "待批准");
	const t = ok.todo.find((x) => x.kind === "上架");
	assert.ok(t && t.kind === "上架");
	assert.deepEqual(t.propose.writes.map((w) => w.op), ["建商品", "上架"]);
	assert.equal((t.propose.writes[0]!.params.productInfo as any).std_tier_variation_list[0].value_list[0].image_id, "o1");
	// 审过以后改了标题：要再审
	assert.equal(run({ ...l, title: "輕便雨衣 成人連身 防水透氣 騎車通勤 加厚", audit: { key } }).steps.get("7")!.step, "待台湾审核");
	// 审核挑出的问题带编号：文案的给 agent 改，图的给人删除或放行；人放行了文案那条、保留了那张图，就待批准
	const issues = { key, textIssues: ["規格名有簡體字"], images: [{ id: "m1", issues: ["「产品」是簡體"] }], at: "t0" };
	const bad = run({ ...l, audit: issues });
	assert.equal(bad.steps.get("7")!.step, "台湾审核未通过");
	assert.match(bad.inbox[0]!.detail, /2\. 图 m1：「产品」是簡體/);
	assert.match(bad.inbox[0]!.detail, /x2 listing audit 7 --accept/);
	assert.match(bad.todo.find((x) => x.kind === "写文案")!.why, /1\. 規格名有簡體字/);
	assert.equal(run({ ...l, audit: { ...issues, accepted: [{ n: 1, at: "t1" }] } }).inbox.length, 1);
	assert.equal(run({ ...l, audit: { ...issues, accepted: [{ n: 1, at: "t1" }] }, kept_images: ["m1"] }).steps.get("7")!.step, "待批准");
	// 待批准、待上架、已上架、已放弃、已暂停
	assert.equal(run(l, [{ op: "建商品", status: "待批准", params: { listingId: "7" } }]).steps.get("7")!.step, "待批准");
	const built = run({ ...l, product_id: "51567712845" });
	assert.equal(built.steps.get("7")!.step, "待上架");
	assert.deepEqual((built.todo[0] as any).propose.writes.map((w: any) => w.op), ["上架"]);
	assert.equal(run({ ...l, listed_at: new Date() }).steps.get("7")!.step, "已上架");
	assert.equal(run({ ...l, cancelled: true }).steps.get("7")!.step, "已放弃");
	assert.equal(checkListings([l], new Map([["cheeroutdoor", { ...s.get("cheeroutdoor")!, paused: "店铺被限制" }]]), []).steps.get("7")!.step, "已暂停");
});

test("已移除的规格：按选项名（括号里的说明可以不写）或货号配；去掉以后不上、规格图不审、要再审", () => {
	const s = settingsOf(shopRow);
	const sizes = ["40*60", "60*90cm（升級版）"];
	const variants = ["黑貓", "定製"].flatMap((c, i) => sizes.map((z, j) => ({ ...v([["顏色", c], ["尺寸", z]], `${c}.jpg`), sku: `LT1-${i}${j}`, priceTwd: 133 })));
	assert.deepEqual(matchVariants(variants, ["定製", "60*90cm", "LT1-00", "藍色"]), { skus: ["LT1-10", "LT1-11", "LT1-01", "LT1-00"], unknown: ["藍色"] });
	const images = { main: [pic("m1")], detail: [], options: [pic("o1", "黑貓.jpg"), pic("o2", "定製.jpg")], waiting: [] };
	const all = productOf(ready({ variants, images }), s).product!;
	const kept = productOf(ready({ variants, images, removed_variants: ["LT1-10", "LT1-11"] }), s).product!;
	assert.deepEqual(kept.variants.map((x) => x.sku), ["LT1-00", "LT1-01"]);
	assert.deepEqual(kept.optionImages, { "黑貓.jpg": "o1" });
	assert.notEqual(auditKey(kept, "水印"), auditKey(all, "水印"));
});

test("台湾审核放行：问题按编号（先文案、后图）；文案的放行记在这次审核里，图的记进保留的图；每条都放行了算通过", () => {
	const a = { key: "k", textIssues: ["規格名有簡體字"], images: [{ id: "m2", issues: ["「产品」是簡體"] }, { id: "d1", issues: ["「干」", "「发」"] }], at: "t0" };
	assert.deepEqual(auditIssues(a).map((x) => [x.n, x.kind, x.text, x.image ?? null, x.status]), [
		[1, "文案", "規格名有簡體字", null, "待处理"], [2, "图", "「产品」是簡體", "m2", "待处理"], [3, "图", "「干」；「发」", "d1", "待处理"],
	]);
	assert.equal(auditPassed(a), false);
	assert.equal(auditPassed({ key: "k", textIssues: [], images: [], at: "t0" }), true);
	const x = acceptIssues(a, [], [1, 3, 9], "t1");
	assert.deepEqual(x.unknown, [9]);
	assert.deepEqual(x.audit.accepted, [{ n: 1, at: "t1" }]);
	assert.deepEqual(x.kept, ["d1"]);
	assert.deepEqual(auditIssues(x.audit, x.kept).map((i) => i.status), ["已放行", "待处理", "已放行"]);
	// 放行过的不再记一次
	const y = acceptIssues(x.audit, x.kept, [2, 1], "t2");
	assert.deepEqual([y.audit.accepted, y.kept, auditPassed(y.audit, y.kept)], [[{ n: 1, at: "t1" }], ["d1", "m2"], true]);
	// 重审出来的是新的结果：文案的放行不带过去（措辞会变），保留的图跟着商品稿，还是不挡
	const again = { key: "k2", textIssues: ["規格名有简体字"], images: [{ id: "d1", issues: ["「乾」寫成「干」"] }], at: "t3" };
	assert.deepEqual(auditIssues(again, y.kept).map((i) => i.status), ["待处理", "已放行"]);
});

test("台湾审核挑出的图：印在商品上的、保留的图只记备注；后加的文案，详情图和不是封面的主图 x2 去掉，封面、规格图留给人", () => {
	assert.equal(dispose("印在商品上", "封面", false, true), "备注");
	assert.equal(dispose("后加的文案", "详情图", true, true), "备注");
	assert.equal(dispose("后加的文案", "详情图", false, true), "已去掉");
	assert.equal(dispose("后加的文案", "主图", false, true), "已去掉");
	assert.equal(dispose("后加的文案", "封面", false, true), "待处理");
	assert.equal(dispose("后加的文案", "规格图", false, true), "待处理");
	// 已经再审了两轮、没问出字在哪：留给人
	assert.equal(dispose("后加的文案", "详情图", false, false), "待处理");
	assert.equal(dispose(null, "详情图", false, true), "待处理");
	// 图在商品里是什么：同一张图在几处的，封面 > 规格图 > 主图 > 详情图
	const p = productOf(ready({ images: { main: [pic("m1"), pic("m2")], detail: [pic("d1"), pic("o1", "o1b.jpg")], options: [pic("o1", "k.jpg")], waiting: [] } }), settingsOf(shopRow)).product!;
	assert.deepEqual(["m1", "m2", "d1", "o1"].map((id) => roleOf(p, id)), ["封面", "主图", "详情图", "规格图"]);
	assert.equal(roleOf({ ...p, images: ["o1"] }, "o1"), "封面");
});

test("x2 去掉挑出的图：写在 Pic 的 drop 上（不进已删除的图），商品里不用它，记进审核结果；人放行了放回来", () => {
	const s = settingsOf(shopRow);
	const pics: Pics = { main: [pic("m1"), pic("m2")], detail: [pic("d1"), pic("m2", "m2b.jpg"), { ...pic("d9"), drop: "超过张数，不用" }], options: [pic("o1", "k.jpg")], waiting: [] };
	const dropped = dropAudited(pics, [{ id: "m2", issues: ["「产品」是簡體", "「质量」"] }, { id: "d9", issues: ["「干」"] }]);
	assert.deepEqual([...dropped.main, ...dropped.detail].map((x) => x.drop ?? null), [null, "台湾审核：「产品」是簡體；「质量」", null, "台湾审核：「产品」是簡體；「质量」", "超过张数，不用"]);
	assert.equal(pics.main[1]!.drop, undefined);
	assert.deepEqual(productOf(ready({ images: dropped }), s).product!.images, ["m1"]);
	assert.deepEqual(auditDropped(dropped), [{ id: "m2", issues: ["「产品」是簡體；「质量」"], where: "后加的文案", role: "主图", action: "已去掉" }]);
	assert.deepEqual(restoreAudited(dropped, ["m2", "d9"]), pics);
	// 审核结果里：去掉的、印在商品上的不挡；封面上后加的文案待处理，放行就是保留的图；放行去掉的图要放回来
	const a = { key: "k", textIssues: [], at: "t0", images: [
		...auditDropped(dropped),
		{ id: "o1", issues: ["地墊上的「浴水生财」"], where: "印在商品上" as const, role: "规格图" as const, action: "备注" as const },
		{ id: "m1", issues: ["「随心定制」"], where: "后加的文案" as const, role: "封面" as const, action: "待处理" as const },
	] };
	assert.deepEqual(auditIssues(a).map((x) => [x.n, x.role, x.where, x.status]), [[1, "主图", "后加的文案", "已去掉"], [2, "规格图", "印在商品上", "不算问题"], [3, "封面", "后加的文案", "待处理"]]);
	assert.deepEqual([auditPassed(a), auditPassed(a, ["m1"])], [false, true]);
	const x = acceptIssues(a, [], [1, 2], "t1");
	assert.deepEqual([x.kept, x.restore, x.unknown], [["m2"], ["m2"], []]);
});

test("检查：x2 处理过的图不挡；封面、规格图上后加的文案进收件箱，写着换掉或放行", () => {
	const s = new Map([["cheeroutdoor", settingsOf(shopRow)]]);
	const l = ready();
	const key = auditKey(productOf(l, s.get("cheeroutdoor")!).product!, "新新家居日用好物賣場");
	const done = [{ id: "d1", issues: ["「干」"], where: "后加的文案", role: "详情图", action: "已去掉" }, { id: "o1", issues: ["「浴水生财」"], where: "印在商品上", role: "规格图", action: "备注" }];
	assert.equal(checkListings([{ ...l, audit: { key, textIssues: [], images: done } }], s, []).steps.get("7")!.step, "待批准");
	const cover = checkListings([{ ...l, audit: { key, textIssues: [], images: [...done, { id: "m1", issues: ["「随心定制」"], where: "后加的文案", role: "封面", action: "待处理" }] } }], s, []);
	assert.equal(cover.steps.get("7")!.step, "台湾审核未通过");
	assert.equal(cover.inbox.length, 1);
	assert.match(cover.inbox[0]!.detail, /^3\. 封面 m1：「随心定制」/);
	assert.match(cover.inbox[0]!.detail, /换掉：.*\n放行.*--accept/);
});

test("译图检查：象寄改了商品上的字、还有简体字、转错的字，这张不用；模型说的简体字、错字要在它抄的字里，还要过 OpenCC", () => {
	const c = (o: Partial<TranslatedCheck>): TranslatedCheck => ({ text: [], simplified: [], wrong: [], productText: [], ...o });
	assert.equal(translatedDrop(c({ text: ["一衝即淨"] })), null);
	assert.equal(translatedDrop(c({ productText: ["生财！ → 生財！"] })), "象寄改了商品上印的字：生财！ → 生財！");
	// 简体字：模型把原图的字当成译图的、把繁体当成简体的不算；台湾也用的「台」不算
	assert.equal(translatedDrop(c({ text: ["雙面防滑", "矩阵防滑纹理"], simplified: ["矩阵", "纹理"] })), "译图还有简体字：矩阵、纹理");
	assert.equal(translatedDrop(c({ text: ["賦予空間自然流暢氣質"], simplified: ["赋予", "空间"] })), null);
	assert.equal(translatedDrop(c({ text: ["科技絨浴室地墊", "台灣出貨"], simplified: ["科技絨浴室地墊", "台灣"] })), null);
	// 转错的字：同一个简体字选错了繁体（干 → 幹，应为乾）；异体字、换说法、英文不算，它没抄到的不算
	assert.equal(translatedDrop(c({ text: ["至好の方式快速吸水易幹"], wrong: ["易幹 → 易乾"] })), "译图有转错的字：易幹 → 易乾");
	assert.equal(translatedDrop(c({ text: ["較頑固汙漬", "質量問題", "防滑 S", "瞬吸快乾"], wrong: ["汙 → 污", "質量 → 品質", "防滑 S → 防滑 vs", "瞬吸快幹 → 瞬吸快乾"] })), null);
	assert.equal(translatedDrop(c({ text: ["易幹"], wrong: ["易幹 → 易乾"], productText: ["浴水 → 重画"] })), "象寄改了商品上印的字：浴水 → 重画；译图有转错的字：易幹 → 易乾");
});
