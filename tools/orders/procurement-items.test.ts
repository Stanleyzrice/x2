// 采购订单行保留真实商品、规格与数量；货源按商品和店铺归属关联，不猜规格，不信任存下来的 URL。
import assert from "node:assert/strict";
import { test } from "node:test";
import { type ProcurementItem, type ProcurementListingRow, type ProcurementSourceRow, procurementImage, procurementLines } from "./procurement-items.ts";

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
