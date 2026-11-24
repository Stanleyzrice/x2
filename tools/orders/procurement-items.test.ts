// 采购订单行保留真实商品、规格与数量；货源按商品和店铺归属关联，不猜规格，不信任存下来的 URL。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type ProcurementItem,
	type ProcurementListingRow,
	type ProcurementSourceRow,
	procurementDemand,
	procurementImage,
	procurementLines,
} from "./procurement-items.ts";
import type { Match, MatchNeed } from "./procurement-matches.ts";

const item: ProcurementItem = { itemId: "10", modelId: "11", name: "商品", spec: "大号", qty: 3, image: "https://img.example/shopee.jpg" };
const chosen: ProcurementSourceRow = { itemId: "10", offerId: "123", title: "选用货源", itemImage: "https://img.example/item.jpg", broken: null };
const listing: ProcurementListingRow = { shop: "shop", shopId: "1", productId: "10", offerId: "456", title: "已有上品" };
const order = (items: ProcurementItem[] = [item]) => ({ shop: "shop", shopId: "1", items });

test("每个规格保留自己的图片、名称和数量；同商品货源仅展示商品级链接", () => {
	const lines = procurementLines(order([item, { ...item, modelId: "12", spec: "小号", qty: 1, image: "https://img.example/small.jpg" }]), [chosen], [listing]);
	assert.deepEqual(
		lines.map((line) => [line.modelId, line.spec, line.qty, line.image]),
		[
			["11", "大号", 3, item.image],
			["12", "小号", 1, "https://img.example/small.jpg"],
		],
	);
	assert.deepEqual(lines[0]!.sources, [
		{ offerId: "123", url: "https://detail.1688.com/offer/123.html", title: "选用货源", chosen: true, broken: null, origin: "chosen" },
		{ offerId: "456", url: "https://detail.1688.com/offer/456.html", title: "已有上品", chosen: false, broken: null, origin: "listing" },
	]);
	assert.ok(lines[0]!.sources.every((source) => !("skuId" in source)));
});

test("排除其他商品、同名其他店铺和变化的店铺身份；同货源去重保留人工选择及不可用原因", () => {
	const lines = procurementLines(
		order(),
		[
			{ ...chosen, broken: "已下架" },
			{ ...chosen, itemId: "99", offerId: "999" },
		],
		[
			{ ...listing, offerId: chosen.offerId },
			{ ...listing, shop: "other" },
			{ ...listing, shopId: "2" },
			{ ...listing, productId: "99" },
		],
	);
	assert.equal(lines[0]!.sources.length, 1);
	assert.equal(lines[0]!.sources[0]!.chosen, true);
	assert.equal(lines[0]!.sources[0]!.broken, "已下架");
});

test("缺图只允许同商品已选货源留存的店铺商品图补全；没有货源时保持缺失", () => {
	assert.equal(procurementLines(order([{ ...item, image: "" }]), [chosen], [])[0]!.image, chosen.itemImage);
	const [missing] = procurementLines(order([{ ...item, image: "" }]), [{ ...chosen, itemId: "99" }], []);
	assert.equal(missing!.image, null);
	assert.deepEqual(missing!.sources, []);
});

test("图片拒绝可执行协议、内嵌凭证和无效地址；1688 链接只由纯数字货源编号生成", () => {
	for (const value of ["javascript:alert(1)", "data:text/html,test", "file:///private/a", "https://user:secret@example.com/a", "not a url", "//example.com/a"])
		assert.equal(procurementImage(value), null);
	assert.equal(procurementImage("https://img.example/a.jpg"), "https://img.example/a.jpg");
	const [line] = procurementLines(order(), [{ ...chosen, offerId: "123/../../evil" }], [{ ...listing, offerId: "javascript:alert(1)" }]);
	assert.deepEqual(line!.sources, []);
});

const target: MatchNeed["target"] = { offerId: "123", skuId: "42", specId: "大号" };
type DemandLine = Parameters<typeof procurementDemand>[0][number]["lines"][number];
const demandLine = (qty: number, state: Match["state"] = "unmatched", paidQty = 0, unpaidQty = 0): DemandLine => ({
	...item,
	skuImage: item.image,
	qty,
	cartRecorded: false,
	target,
	sources: [],
	purchase: { state, label: state, paidQty, unpaidQty, requiredQty: qty, reason: null, matches: [], canPurchase: state === "unmatched" },
});
const demandOrder = (sn: string, ...lines: DemandLine[]) => ({
	sn,
	shop: "one",
	shopId: "1",
	lines,
});

test("汇总只取本规格目录或订单行的图片；同组后续订单可补图，商品封面不充当规格图", () => {
	const pink = "https://img.example/pink.jpg";
	const grey = "https://img.example/grey.jpg";
	const models = {
		...listing,
		models: [
			{ modelId: "11", image: pink },
			{ modelId: "12", image: grey },
		],
	};
	const lines = procurementLines(
		order([item, { ...item, modelId: "12" }, { ...item, modelId: "13", image: "" }]),
		[chosen],
		[],
		[{ ...models, shopId: "other", models: [{ modelId: "11", image: grey }] }, models],
	);
	assert.deepEqual(
		lines.map((line) => line.skuImage),
		[pink, grey, null],
	);
	assert.equal(lines[2]!.image, chosen.itemImage);
	const blank = { ...demandLine(1), skuImage: null };
	const rows = procurementDemand([
		demandOrder("A", blank),
		demandOrder("B", ...lines.map((line) => ({ ...blank, ...line, target: line.modelId === "11" ? target : null }))),
	]);
	assert.deepEqual(
		rows.map((row) => row.image),
		[pink, grey, null],
	);
});

test("不同订单的相同 1688 商品规格合计，保留各订单的数量", () => {
	const [same, different] = procurementDemand([
		demandOrder("first", demandLine(2), { ...demandLine(1), itemId: "20", modelId: "21" }),
		{ ...demandOrder("second", demandLine(3)), shop: "two", shopId: "2" },
		demandOrder("third", { ...demandLine(4), target: { ...target, specId: "小号" } }),
	]);
	assert.equal(same?.qty, 6);
	assert.equal(same?.buyQty, 6);
	assert.deepEqual(same?.orders, [
		{ sn: "first", shop: "one", qty: 3, paidQty: 0, unpaidQty: 0, buyQty: 3, reviewQty: 0 },
		{ sn: "second", shop: "two", qty: 3, paidQty: 0, unpaidQty: 0, buyQty: 3, reviewQty: 0 },
	]);
	assert.equal(different?.qty, 4);
});

test("未映射的规格按 Shopee 店铺、商品和规格归集，相同名称不混算", () => {
	const unmapped = (qty: number) => ({ ...demandLine(qty, "unknown"), target: null });
	const groups = procurementDemand([
		demandOrder("first", unmapped(2)),
		demandOrder("second", unmapped(3)),
		{ ...demandOrder("third", unmapped(4)), shopId: "2" },
		demandOrder("fourth", { ...unmapped(5), modelId: "12" }),
	]);
	assert.deepEqual(
		groups.map(({ qty, buyQty, reviewQty }) => [qty, buyQty, reviewQty]),
		[
			[5, 0, 5],
			[4, 0, 4],
			[5, 0, 5],
		],
	);
});

test("已付、待付、待加购与待核对各自有数量，未核实数量不会计入待加购", () => {
	const [summary] = procurementDemand([
		demandOrder("first", demandLine(2, "paid", 2)),
		demandOrder("second", demandLine(1, "unpaid", 0, 1)),
		demandOrder("third", demandLine(6, "partial", 2, 1)),
		demandOrder("fourth", demandLine(5, "unknown", 4)),
		demandOrder("fifth", { ...demandLine(2), cartRecorded: true }),
		demandOrder("sixth", { ...demandLine(3), cartRecorded: true }),
		demandOrder("seventh", demandLine(4)),
	]);
	assert.ok(summary);
	const { qty, paidQty, unpaidQty, buyQty, reviewQty } = summary;
	assert.deepEqual({ qty, paidQty, unpaidQty, buyQty, reviewQty }, { qty: 23, paidQty: 4, unpaidQty: 2, buyQty: 7, reviewQty: 10 });
});
