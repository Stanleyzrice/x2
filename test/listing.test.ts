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
