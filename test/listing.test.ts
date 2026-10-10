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

import { dropSpecs, limitProblems, OLD_SPECS, priceRange, removedOf, renameSpecs, type Specs, specsFrom, specsOf, specsText, structureProblems } from "../src/listing/variants.ts";
import type { Offer } from "../src/site/1688.ts";

/** 一个货源：props 是 [层名, 取值…]（第一层的取值带图「<取值>.jpg」），skus 是 [各层的取值, 库存]，规格 id 是 s<第几个> */
const offerOf = (props: [string, string[]][], skus: [string[], number?][]): Offer => ({
	offerId: "1", url: "", title: "", image: "", unit: "", minQty: 1,
	props: props.map(([name, values], i) => ({ name, values: values.map((v) => ({ name: v, image: i === 0 ? `${v}.jpg` : "" })) })),
	skus: skus.map(([attrs, stock = 9], k) => ({ skuId: `k${k}`, specId: `s${k}`, name: attrs.join(" / "), attrs, price: 10, stock, image: attrs[0] ? `${attrs[0]}.jpg` : "", weightKg: 0.3 })),
});
/** 每层的层名和选项名 */
const names = (s: Specs) => s.tiers.map((t) => [t.name, t.options.map((o) => o.name)]);
/** 换上名字（每层 [层名, 选项名…]，不核规矩） */
const named = (s: Specs, tiers: [string, string[]][]): Specs => ({ ...s, tiers: s.tiers.map((t, a) => ({ ...t, name: tiers[a]![0], options: t.options.map((o, k) => ({ ...o, name: tiers[a]![1][k]! })) })) });
/** 规格：每层 [层名, 选项名…]（原值和名字一样，第一层的选项带图「<名字>.jpg」），每个组合一个规格（货号 LT1-<各层下标>），售价、重量照给的 */
const grid = (tiers: [string, string[]][], price: (c: number[]) => number | null = () => 295, weight: (c: number[]) => number | null = () => 1.6): Specs => {
	const cells = tiers.reduce<number[][]>((all, [, opts]) => all.flatMap((c) => opts.map((_, k) => [...c, k])), [[]]);
	return {
		tiers: tiers.map(([name, opts], a) => ({ source: name, name, options: opts.map((o) => ({ source: o, name: o, ...(a === 0 ? { image: `${o}.jpg` } : {}) })) })),
		variants: cells.map((c) => ({ sku: `LT1-${c.join("")}`, skuId: c.join(""), specId: c.join(""), options: c, costRmb: 1, stock: 9, weightKg: weight(c), priceTwd: price(c) })),
	};
};

test("规格：只要有货的、没移除的，只留取值不一样的层；两层组合齐全才留两层，不齐合成一层「款式」；选项照 1688 的顺序，规格图挂第一层", () => {
	const sizes = ["【M码】身高【150-158cm】", "【L码】身高【158-165cm】"];
	const o = offerOf([["颜色", ["卡其色", "黑色", "白色"]], ["尺码", sizes], ["款式", ["标准款"]]], [
		[["黑色", sizes[1]!, "标准款"]], [["卡其色", sizes[0]!, "标准款"]], [["黑色", sizes[0]!, "标准款"]], [["卡其色", sizes[1]!, "标准款"]], [["白色", sizes[0]!, "标准款"], 0],
	]);
	const { specs, problems } = specsFrom(o);
	assert.deepEqual(problems, []);
	assert.deepEqual(specs.tiers, [
		{ source: "颜色", name: "顏色", options: [{ source: "卡其色", name: "卡其色", image: "卡其色.jpg" }, { source: "黑色", name: "黑色", image: "黑色.jpg" }] },
		{ source: "尺码", name: "尺碼", options: [{ source: sizes[0], name: "M" }, { source: sizes[1], name: "L" }] },
	]);
	assert.deepEqual(specs.variants.map((v) => [v.sku, v.options]), [["LT1-s1", [0, 0]], ["LT1-s3", [0, 1]], ["LT1-s2", [1, 0]], ["LT1-s0", [1, 1]]]);
	assert.deepEqual(structureProblems(specs), []);
	// 缺一个组合（移除了，或没货了）：合成一层「款式」，一个组合一个选项，原值是各层的原值连起来
	const merged = specsFrom(o, ["LT1-s0"]).specs;
	assert.deepEqual(names(merged), [["款式", ["卡其色 M", "卡其色 L", "黑色 M"]]]);
	assert.equal(merged.tiers[0]!.source, "颜色 / 尺码");
	assert.deepEqual(merged.tiers[0]!.options.map((x) => [x.source, x.image]), [[`卡其色 / ${sizes[0]}`, "卡其色.jpg"], [`卡其色 / ${sizes[1]}`, "卡其色.jpg"], [`黑色 / ${sizes[0]}`, "黑色.jpg"]]);
	assert.deepEqual(merged.variants.map((v) => v.options), [[0], [1], [2]]);
	assert.deepEqual(structureProblems(merged), []);
	// 同一个选项下 1688 的图不一样：定不了，要人处理
	const twoImages = offerOf([["颜色", ["红", "蓝"]], ["尺寸", ["S", "L"]]], [[["红", "S"]], [["红", "L"]], [["蓝", "S"]], [["蓝", "L"]]]);
	twoImages.skus[1]!.image = "b.jpg";
	const t = specsFrom(twoImages);
	assert.deepEqual([t.problems, t.specs.tiers[0]!.options[0]!.image], [["规格：「紅」下的规格图不一样，定不了这个选项用哪张图"], null]);
	// 只有一个规格：单层、空名字
	assert.deepEqual(specsFrom(offerOf([], [[[]]])).specs, { tiers: [{ source: "", name: "", options: [{ source: "", name: "", image: null }] }], variants: [{ sku: "LT1-s0", skuId: "k0", specId: "s0", options: [0], costRmb: 10, stock: 9, weightKg: 0.3, priceTwd: null }] });
});

test("规格：自动的名字转台湾繁体、去掉 emoji 和括号里的短说明、最多 20 字；1688 的值前 20 字一样也是两个选项（名字加 -2），不会指到同一格", () => {
	const long = "一二三四五六七八九十一二三四五六七八九十";
	const values = ["红色【爆款】", "红色(新品)", "蓝色🌟", `${long}甲`, `${long}乙`];
	const { specs } = specsFrom(offerOf([["颜色", values]], values.map((v): [string[]] => [[v]])));
	assert.deepEqual(names(specs), [["顏色", ["紅色", "紅色-2", "藍色", long, `${long.slice(0, 18)}-2`]]]);
	assert.deepEqual(specs.tiers[0]!.options.map((o) => o.source), values);
	assert.deepEqual(specs.variants.map((v) => v.options), [[0], [1], [2], [3], [4]]);
	assert.deepEqual(structureProblems(specs), []);
});

test("规格：重做商品稿时按 1688 层名、原值把名字对回去；新的选项自动起名字，不和留下的名字撞；没货了的不要", () => {
	const sizes = ["40*60cm（升级版硅藻泥）", "60*90cm（升级版硅藻泥）"];
	const o = offerOf([["颜色", ["卡其色", "黑色（加厚款）"]], ["尺寸", sizes]], ["卡其色", "黑色（加厚款）"].flatMap((c) => sizes.map((z): [string[]] => [[c, z]])));
	const first = specsFrom(o).specs;
	assert.deepEqual(names(first), [["顏色", ["卡其色", "黑色"]], ["尺寸", ["40*60cm升級版矽藻泥", "60*90cm升級版矽藻泥"]]]);
	const before = named(first, [["款式", ["奶茶卡其", "黑色"]], ["尺寸", ["40×60cm", "60×90cm"]]]);
	// 1688 上卡其色没货了，多了「黑色」
	const again = offerOf([["颜色", ["卡其色", "黑色（加厚款）", "黑色"]], ["尺寸", sizes]], ["卡其色", "黑色（加厚款）", "黑色"].flatMap((c) => sizes.map((z): [string[], number] => [[c, z], c === "卡其色" ? 0 : 9])));
	const next = specsFrom(again, [], before).specs;
	assert.deepEqual(names(next), [["款式", ["黑色", "黑色-2"]], ["尺寸", ["40×60cm", "60×90cm"]]]);
	assert.deepEqual(next.tiers[0]!.options.map((x) => x.source), ["黑色（加厚款）", "黑色"]);
	// 上一版是旧格式的：名字都自动起
	assert.deepEqual(names(specsFrom(o, [], specsOf([{ sku: "x", specs: [] }])).specs), names(first));
});

test("规格的规矩：错在哪层哪个选项写清楚；上限在核价以后算；旧格式认不出", () => {
	const ok = grid([["款式", ["黑貓", "黃狗"]], ["尺寸", ["40×60cm", "60×90cm"]]]);
	assert.deepEqual(structureProblems(ok), []);
	const bad = (f: (s: Specs) => unknown) => {
		const s: Specs = structuredClone(ok);
		f(s);
		return structureProblems(s).join("\n");
	};
	assert.match(bad((s) => s.tiers.push({ source: "", name: "材質", options: [] })), /3 层，要 1–2 层/);
	assert.match(bad((s) => { s.tiers[0]!.name = ""; }), /第 1 层缺层名/);
	assert.match(bad((s) => { s.tiers[1]!.name = "一二三四五六七八九十一二三四五"; }), /第 2 层「一二三四五六七八九十一二三四五」的层名 15 字，最多 14 字/);
	assert.match(bad((s) => { s.tiers[0]!.options[1]!.name = " "; }), /第 1 层「款式」第 2 个选项缺名字/);
	assert.match(bad((s) => { s.tiers[1]!.options[0]!.name = "一二三四五六七八九十一二三四五六七八九十多"; }), /第 2 层「尺寸」第 1 个选项「一二三四五六七八九十一二三四五六七八九十多」 21 字，最多 20 字/);
	assert.match(bad((s) => { s.tiers[0]!.options[1]!.name = "黑貓"; }), /第 1 层「款式」的第 1、2 个选项都叫「黑貓」，同一层不能重名/);
	assert.match(bad((s) => { s.tiers[1]!.name = "款式"; }), /两层都叫「款式」/);
	assert.match(bad((s) => { s.variants[0]!.options = [0]; }), /规格 LT1-00 有 1 个选项下标，要每层一个（2 个）/);
	assert.match(bad((s) => { s.variants[0]!.options = [0, 5]; }), /规格 LT1-00 在第 2 层「尺寸」的选项下标 5 不存在（这一层有 2 个选项）/);
	assert.match(bad((s) => { s.variants[1]!.options = [0, 0]; }), /规格 LT1-00 和 LT1-01 是同一格（黑貓 × 40×60cm）/);
	assert.match(bad((s) => { s.variants.pop(); }), /两层的组合不齐，缺「黃狗 × 60×90cm」（两层要每个组合都有，不然合成一层「款式」）/);
	assert.match(bad((s) => s.tiers[1]!.options.push({ source: "80*120", name: "80×120cm" })), /第 2 层「尺寸」第 3 个选项「80×120cm」没有规格/);
	assert.match(bad((s) => { s.tiers[1]!.options[0]!.image = "x.jpg"; }), /第 2 层「尺寸」第 1 个选项「40×60cm」有规格图，规格图只挂第一层/);
	assert.match(bad((s) => { s.variants[1]!.sku = "LT1-00"; }), /货号 LT1-00 重复/);
	assert.match(bad((s) => { s.variants = []; }), /无有货的规格/);
	// 只有一个规格：单层、空名字是对的；多个规格的不能空着名字
	assert.deepEqual(structureProblems(specsFrom(offerOf([], [[[]]])).specs), []);
	// 上限：最多 50 个、最高价不超过最低价 5 倍
	assert.deepEqual(limitProblems(grid([["款式", [...Array(51).keys()].map(String)]])), ["规格：有货的规格 51 个，最多 50 个"]);
	assert.match(limitProblems(grid([["尺寸", ["小", "大"]]], (c) => (c[0] ? 600 : 100))).join(), /最高价超过最低价的 5 倍/);
	assert.deepEqual(limitProblems(ok), []);
	// 旧格式（规格的数组，选项名每次现算）：认不出，要重做商品稿
	assert.equal(specsOf([{ sku: "LT1-1", specs: [{ label: "顏色", value: "黑" }] }]), null);
	assert.deepEqual(specsOf(ok), ok);
});

test("去掉规格：整个选项；两层都有的写层名；单个规格让组合不齐时不做，--merge 才合成一层；重做商品稿照样认得", () => {
	const colors = ["斑点狗", "定制", "标准"], sizes = ["40*60*0.25", "标准"];
	// 规格 id：s0 斑点狗 40*60、s1 斑点狗 标准、s2 定制 40*60、s3 定制 标准、s4 标准 40*60、s5 标准 标准
	const o = offerOf([["颜色", colors], ["尺寸", sizes]], colors.flatMap((c) => sizes.map((z): [string[]] => [[c, z]])));
	const s = named(specsFrom(o).specs, [["顏色", ["斑點狗", "定製", "標準"]], ["尺寸", ["40×60cm", "標準"]]]);
	const ok = <T extends object>(r: T | { error: string }): T => {
		assert.ok(!("error" in r), "error" in r ? r.error : "");
		return r as T;
	};
	const option = ok(dropSpecs(s, ["定製"]));
	assert.deepEqual([option.skus, option.merged], [["LT1-s2", "LT1-s3"], false]);
	assert.deepEqual(names(option.specs), [["顏色", ["斑點狗", "標準"]], ["尺寸", ["40×60cm", "標準"]]]);
	assert.deepEqual(option.specs.variants.map((v) => [v.sku, v.options]), [["LT1-s0", [0, 0]], ["LT1-s1", [0, 1]], ["LT1-s4", [1, 0]], ["LT1-s5", [1, 1]]]);
	// 两层都有「標準」：要写层名
	assert.deepEqual(dropSpecs(s, ["標準"]), { error: "两层都有「標準」：写成「层名:选项名」（顏色:標準 或 尺寸:標準）" });
	const size = ok(dropSpecs(s, ["尺寸:標準"]));
	assert.deepEqual([size.skus, names(size.specs)], [["LT1-s1", "LT1-s3", "LT1-s5"], [["顏色", ["斑點狗", "定製", "標準"]], ["尺寸", ["40×60cm"]]]]);
	// 单个规格（货号）：组合会不齐，不做；一个选项的规格都写了，就是去掉这个选项
	assert.match((dropSpecs(s, ["LT1-s0"]) as { error: string }).error, /^去掉以后两层的组合不齐（缺「斑點狗 × 40×60cm」）：要么去掉整个选项（例 顏色:斑點狗、尺寸:40×60cm），要么人说了加 --merge 合成一层「款式」$/);
	assert.deepEqual(names(ok(dropSpecs(s, ["LT1-s2", "LT1-s3"])).specs), names(option.specs));
	const merged = ok(dropSpecs(s, ["LT1-s0"], true));
	assert.deepEqual([merged.skus, merged.merged, names(merged.specs)], [["LT1-s0"], true, [["款式", ["斑點狗 標準", "定製 40×60cm", "定製 標準", "標準 40×60cm", "標準 標準"]]]]);
	assert.deepEqual(merged.specs.tiers[0]!.options[1], { source: "定制 / 40*60*0.25", name: "定製 40×60cm", image: "定制.jpg" });
	assert.deepEqual(structureProblems(merged.specs), []);
	// 重做商品稿：去掉的不要，合成的「款式」和名字照旧
	assert.deepEqual(specsFrom(o, merged.skus, merged.specs).specs, merged.specs);
	assert.deepEqual(specsFrom(o, option.skus, option.specs).specs, option.specs);
	// 没有的、全去掉的
	assert.match((dropSpecs(s, ["藍色", "定製"]) as { error: string }).error, /^规格里没有：藍色/);
	assert.match((dropSpecs(s, ["斑點狗", "定製", "顏色:標準"]) as { error: string }).error, /规格都去掉了/);
});

test("规格和价格：按层写，价格、重量跟着哪层变就写在哪层；两层都影响的第一层每个选项一行；都一样的写「各」；最后写已移除的", () => {
	const price = (c: number[]) => [133, 155][c[1]!]!, weight = (c: number[]) => [0.216, 0.36][c[1]!]!;
	// 价格、重量都跟着尺寸变（商品稿 2 的样子）
	assert.equal(specsText(grid([["款式", ["水生財黑貓咪", "洗洗睡吧梅棕狗"]], ["尺寸", ["40×60cm", "50×80cm"]]], price, weight)), [
		"款式（2）：水生財黑貓咪、洗洗睡吧梅棕狗", "尺寸（2）：40×60cm NT$133 0.216 kg · 50×80cm NT$155 0.36 kg", "共 4 个规格，库存各 9",
	].join("\n"));
	// 重量都一样，有移除的（商品稿 3 的样子）
	assert.equal(specsText(grid([["款式", ["斑點狗", "香蕉狗"]], ["尺寸", ["40×60cm", "50×80cm"]]], price), [{ name: "定製", count: 3 }]), [
		"款式（2）：斑點狗、香蕉狗", "尺寸（2）：40×60cm NT$133 · 50×80cm NT$155", "共 4 个规格，库存各 9，重量各 1.6 kg", "已移除：定製（3 个规格）",
	].join("\n"));
	// 两层都影响价格：第一层每个选项一行
	assert.equal(specsText(grid([["顏色", ["卡其色", "黑色"]], ["尺碼", ["M", "L"]]], (c) => 295 + c[0]! * 4 + c[1]! * 10)), [
		"顏色（2）× 尺碼（2）：", "卡其色：M NT$295 · L NT$305", "黑色：M NT$299 · L NT$309", "共 4 个规格，库存各 9，重量各 1.6 kg",
	].join("\n"));
	// 一层：每个选项后面写价格；库存不一样写范围；价格都一样写「售价各」
	const one = grid([["規格", ["L20", "L25"]]], (c) => [70, 74][c[0]!]!);
	one.variants[1]!.stock = 50;
	assert.equal(specsText(one), "規格（2）：L20 NT$70 · L25 NT$74\n共 2 个规格，库存 9–50，重量各 1.6 kg");
	assert.equal(specsText(grid([["規格", ["L20", "L25"]]], () => null)), "規格（2）：L20、L25\n共 2 个规格，售价各 未定价，库存各 9，重量各 1.6 kg");
	assert.equal(specsText({ ...specsFrom(offerOf([], [[[]]])).specs }), "单规格：未定价，库存 9，0.3 kg");
	// 已移除的：整个取值都移除了的写这个取值（照 1688 转繁体），别的写各层的取值
	const sizes = ["40*60*0.25", "50*80*0.25", "60*90*0.25"];
	const o = offerOf([["颜色", ["斑点狗", "定制"]], ["尺寸", sizes]], ["斑点狗", "定制"].flatMap((c) => sizes.map((z): [string[]] => [[c, z]])));
	assert.deepEqual(removedOf(o, ["LT1-s3", "LT1-s4", "LT1-s5"]), [{ name: "定製", count: 3 }]);
	assert.deepEqual(removedOf(o, ["LT1-s0", "LT1-x"]), [{ name: "斑點狗 40*60*0.25", count: 1 }]);
	assert.equal(priceRange(grid([["尺寸", ["小", "大"]]], (c) => (c[0] ? 155 : 133)).variants), "NT$133–155");
});

import { type Product, productInfo, readbackProblems } from "../src/listing/product.ts";

const draft = (): Product => ({
	parentSku: "LT952803717616", title: "輕便雨衣 成人連身 防水透氣", description: "<p>防水雨衣</p>", categoryPath: [100001, 101324],
	attributes: [{ attribute_id: 100824, attribute_values: [{ value_id: 4259 }] }], preOrder: true, daysToShip: 10, minPurchase: 1,
	channels: ["30005", "30006", "30019"],
	tiers: [
		{ source: "颜色", name: "顏色", options: [{ source: "卡其色", name: "卡其色", image: "k.jpg" }, { source: "黑色", name: "黑色", image: null }] },
		{ source: "尺码", name: "尺碼", options: [{ source: "M码", name: "M" }, { source: "L码", name: "L" }] },
	],
	variants: [[0, 0, 295, 1.6], [0, 1, 295, 1.7], [1, 0, 299, 1.6], [1, 1, 299, 1.6]].map(([a, b, priceTwd, weightKg], i) => ({
		sku: `LT952803717616-${i + 1}`, skuId: String(i + 1), specId: String(i + 1), options: [a!, b!], costRmb: 1, stock: 9, weightKg: weightKg!, priceTwd: priceTwd!,
	})),
	images: ["tw-11134207-a", "tw-11134207-b"], detail: [{ id: "tw-11134207-d", width: 800, height: 1200 }],
	optionImages: { "k.jpg": "tw-11134207-k" }, sizeChart: "tw-11134207-s",
});

test("product_info：照 9-01 的成功样本；规格（层、tier_index）照存着的结构；规格图挂第一层；详情图进描述；建成下架；30019 开不了", () => {
	const p = productInfo(draft()) as any;
	assert.equal(p.unlisted, true);
	assert.deepEqual(p.weight, { value: "1.7", unit: 1 });
	assert.deepEqual(p.std_tier_variation_list.map((t: any) => t.custom_value), ["顏色", "尺碼"]);
	assert.deepEqual(p.std_tier_variation_list[0].value_list, [{ id: 0, custom_value: "卡其色", image_id: "tw-11134207-k" }, { id: 0, custom_value: "黑色" }]);
	assert.deepEqual(p.std_tier_variation_list[1].value_list, [{ id: 0, custom_value: "M" }, { id: 0, custom_value: "L" }]);
	assert.deepEqual(p.model_list.map((m: any) => [m.sku, m.tier_index, m.price, m.is_default]), [["LT952803717616-1", [0, 0], "295", true], ["LT952803717616-2", [0, 1], "295", false], ["LT952803717616-3", [1, 0], "299", false], ["LT952803717616-4", [1, 1], "299", false]]);
	// tier_index 就是规格存着的下标，跟规格的先后无关
	const reversed = productInfo({ ...draft(), variants: draft().variants.reverse() }) as any;
	assert.deepEqual(reversed.model_list.map((m: any) => [m.sku, m.tier_index]), [["LT952803717616-4", [1, 1]], ["LT952803717616-3", [1, 0]], ["LT952803717616-2", [0, 1]], ["LT952803717616-1", [0, 0]]]);
	assert.deepEqual(JSON.parse(p.description_info.description).field_list, [{ type: 0, value: "防水雨衣" }, { type: 1, value: "tw-11134207-d", width: 800, height: 1200 }]);
	assert.deepEqual(p.logistics_channels.filter((c: any) => c.enabled).map((c: any) => c.channelid), [30006, 30005]);
	assert.equal(p.logistics_channels.find((c: any) => c.channelid === 30020).sizeid, 1);
	// 只有一个规格：单层、空名字
	const single = productInfo({ ...draft(), tiers: [{ source: "", name: "", options: [{ source: "", name: "", image: null }] }], variants: [{ ...draft().variants[0]!, options: [0] }] }) as any;
	assert.deepEqual([single.std_tier_variation_list, single.model_list[0].tier_index], [[{ id: 0, custom_value: "", value_list: [{ id: 0, custom_value: "" }] }], [0]]);
	// 规格不对、缺图、详情图太窄：不缺着交
	assert.throws(() => productInfo({ ...draft(), variants: draft().variants.map((v) => ({ ...v, options: [0, 0] })) }), /同一格/);
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
/** 一层「顏色」两个选项：黑色带规格图 k.jpg，綠色没有 */
const colors = (): Specs => ({
	tiers: [{ source: "颜色", name: "顏色", options: [{ source: "黑色", name: "黑色", image: "k.jpg" }, { source: "绿色", name: "綠色", image: null }] }],
	variants: [1, 2].map((n, i) => ({ sku: `LT952803717616-${n}`, skuId: String(n), specId: String(n), options: [i], costRmb: 1, stock: 9, weightKg: 1.6, priceTwd: 295 })),
});
const ready = (o: Record<string, unknown> = {}) => ({
	id: "7", shop: "cheeroutdoor", offer_id: "952803717616", cancelled: false, listed_at: null, product_id: null, problems: null,
	offer: { title: "雨衣" }, title: "輕便雨衣 成人連身 防水透氣 騎車通勤", description: "防水雨衣，騎車通勤用", category_path: [100637, 101324], days_to_ship: 10, attributes: [],
	variants: colors(),
	images: { main: [pic("m1")], detail: [], options: [pic("o1", "k.jpg")], waiting: [] }, removed_images: [], audit: null, ...o,
});

test("商品稿的检查：当前步骤、待补充的进收件箱、agent 能做的进 todo", () => {
	const s = new Map([["cheeroutdoor", settingsOf(shopRow)]]);
	const run = (l: any, writes: any[] = []) => checkListings([l], s, writes);
	assert.equal(run(ready({ offer: null })).steps.get("7")!.step, "待做商品稿");
	// 规格是旧格式（选项名每次现算的那种）：重做商品稿
	const old = run(ready({ variants: [{ sku: "LT952803717616-1", specs: [{ label: "顏色", value: "黑色" }] }] }));
	assert.deepEqual(old.steps.get("7"), { step: "待做商品稿", detail: "规格为旧格式，待重做商品稿" });
	assert.deepEqual([old.todo[0]!.kind, old.todo[0]!.why, (old.todo[0] as any).command], ["做商品稿", "1 份商品稿的规格是旧格式，要重做", "x2 listing make 7"]);
	assert.deepEqual(productOf(ready({ variants: [] }), s.get("cheeroutdoor")!).problems, [OLD_SPECS]);
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

test("去掉规格以后：去掉的不上，规格图只挂还在的选项，审核键跟着变；规格名变了，审核键也跟着变", () => {
	const s = settingsOf(shopRow);
	const specs = grid([["顏色", ["黑貓", "定製"]], ["尺寸", ["40*60", "60*90cm（升級版）"]]]);
	const images = { main: [pic("m1")], detail: [], options: [pic("o1", "黑貓.jpg"), pic("o2", "定製.jpg")], waiting: [] };
	const all = productOf(ready({ variants: specs, images }), s).product!;
	assert.deepEqual(all.optionImages, { "黑貓.jpg": "o1", "定製.jpg": "o2" });
	const r = dropSpecs(specs, ["定製"]);
	assert.ok(!("error" in r));
	const kept = productOf(ready({ variants: r.specs, images, removed_variants: r.skus }), s).product!;
	assert.deepEqual(kept.variants.map((x) => x.sku), ["LT1-00", "LT1-01"]);
	assert.deepEqual(kept.optionImages, { "黑貓.jpg": "o1" });
	assert.notEqual(auditKey(kept, "水印"), auditKey(all, "水印"));
	// 规格里还有已移除的货号（没跟着改）：要重做商品稿
	assert.match(productOf(ready({ variants: specs, images, removed_variants: r.skus }), s).problems.join(), /已移除的规格还在/);
	// 规格名改了：审核键跟着变，要再审；名字一样就不用
	const key = (x: Specs) => auditKey(productOf(ready({ variants: x, images }), s).product!, "水印");
	assert.notEqual(key(named(r.specs, [["顏色", ["黑貓"]], ["尺寸", ["40×60cm", "60×90cm"]]])), key(r.specs));
	assert.equal(key(named(r.specs, [["顏色", ["黑貓"]], ["尺寸", ["40*60", "60*90cm（升級版）"]]])), key(r.specs));
});

test("交规格名：个数、顺序照 show，按第几层第几个选项改；个数不对、超长、重名的不收；改了名字要再审", () => {
	const s = grid([["顏色", ["黑貓", "黃狗"]], ["尺寸", ["40*60cm（升級版矽藻泥）", "60*90cm（升級版矽藻泥）"]]]);
	const sizes = { name: "尺寸", options: ["40×60cm", "60×90cm"] };
	assert.deepEqual(renameSpecs(s, [{ name: "款式", options: ["黑貓", "黃狗"] }]), { problems: ["规格名：要 2 层（照 x2 listing show），交了 1 层"] });
	assert.deepEqual(renameSpecs(s, [{ name: "款式", options: ["黑貓"] }, sizes]), { problems: ["规格名：第 1 层「顏色」要 2 个选项名，交了 1 个"] });
	assert.match(renameSpecs(s, [{ name: "款式", options: ["黑貓", "一二三四五六七八九十一二三四五六七八九十多"] }, sizes]).problems.join(), /第 1 层「款式」第 2 个选项「一二三四五六七八九十一二三四五六七八九十多」 21 字，最多 20 字/);
	assert.match(renameSpecs(s, [{ name: "款式", options: ["黑貓", "黑貓"] }, sizes]).problems.join(), /第 1 层「款式」的第 1、2 个选项都叫「黑貓」，同一层不能重名/);
	assert.match(renameSpecs(s, [{ name: "一二三四五六七八九十一二三四五", options: ["黑貓", "黃狗"] }, sizes]).problems.join(), /层名 15 字，最多 14 字/);
	const r = renameSpecs(s, [{ name: "款式", options: [" 招財黑貓 ", "黃狗"] }, sizes]);
	assert.deepEqual([r.problems, names(r.specs!)], [[], [["款式", ["招財黑貓", "黃狗"]], ["尺寸", ["40×60cm", "60×90cm"]]]]);
	assert.deepEqual(r.specs!.variants, s.variants);
	assert.deepEqual(r.specs!.tiers.map((t) => t.options.map((o) => o.source)), s.tiers.map((t) => t.options.map((o) => o.source)));
	// 单规格不写规格名
	const single = specsFrom(offerOf([], [[[]]])).specs;
	assert.deepEqual(renameSpecs(single, []), { specs: single, problems: [] });
	assert.deepEqual(renameSpecs(single, [{ name: "款式", options: ["一般"] }]).problems, ["规格名：单规格的商品不写规格名（tiers 交 []）"]);
	// 交了新的规格名：审核键跟着变
	const images = { main: [pic("m1")], detail: [], options: [], waiting: [] };
	const key = (x: Specs) => auditKey(productOf(ready({ variants: x, images }), settingsOf(shopRow)).product!, "水印");
	assert.notEqual(key(r.specs!), key(s));
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
