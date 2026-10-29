// id 贴了标签（zod 的 brand）：几种 id 都是字符串，传错种类编译不过（tsc 查这里的 @ts-expect-error：哪一行不再报错，tsc 就失败）；
// 标签在边界上贴（命令行参数、解析回包、读库），之后的函数签名只收对的那一种
import assert from "node:assert/strict";
import { test } from "node:test";
import { addToCart, type OfferId, offer, offerIdOf, type SkuId, type SpecId } from "../connectors/sites/1688/api.ts";
import { type ChanbossOrderId, OrderSn, ordersBySn } from "../connectors/sites/chanboss/api.ts";
import { type ItemId, type ModelId, OrderSn as ShopeeOrderSn } from "../connectors/sites/shopee/seller.ts";
import { type PageId, PageItemId } from "../platform/web/pages.ts";
import { WriteId } from "../platform/writes.ts";
import { ListingId } from "../tools/listing/row.ts";
import { cartParams, forecastParams } from "../tools/orders/writes.ts";

// 只给 tsc 看，不跑：每一行 @ts-expect-error 下面是一种传错
export function wrongIds(o: OfferId, k: SkuId, s: SpecId, sn: OrderSn, cb: ChanbossOrderId, item: ItemId, model: ModelId, l: ListingId, w: WriteId, p: PageId) {
	// @ts-expect-error 规格的 skuId 不是商品 id
	void offer(k);
	// @ts-expect-error Shopee 商品 id 不是 1688 商品 id
	void offer(item);
	// @ts-expect-error 商品稿编号不是 1688 商品 id
	void offer(l);
	// @ts-expect-error 加购要 specId，不是 skuId
	void addToCart(o, k, 1);
	// @ts-expect-error 没贴标签的字符串也不行：在边界上 parse
	void addToCart("123", s, 1);
	// @ts-expect-error chanboss 上订单的 id 不是订单号
	void ordersBySn([cb]);
	// @ts-expect-error Shopee 规格 id 不是订单号
	void ordersBySn([model]);
	// @ts-expect-error 写入编号不是页编号
	const page: PageId = w;
	// @ts-expect-error 页编号不是商品稿编号
	const listing: ListingId = p;
	void [page, listing];
	// 对的照常能传
	void offer(o);
	void addToCart(o, s, 1);
	void ordersBySn([sn]);
}

test("Shopee 和 chanboss 的订单号是同一个标签：两边的值能互传（chanboss 的订单号就是 Shopee 的）", () => {
	const fromChanboss: ShopeeOrderSn = OrderSn.parse("251009ABCDEF01");
	const fromShopee: OrderSn = ShopeeOrderSn.parse("251009ABCDEF01");
	assert.equal(fromChanboss, fromShopee);
});

test("边界上贴标签：值不变，只认对的样子（商品稿、写入、页的编号是数字；从链接里认出商品 id）", () => {
	assert.equal(offerIdOf("https://detail.1688.com/offer/1014247787336.html"), "1014247787336");
	assert.equal(ListingId.parse("12"), "12");
	assert.throws(() => ListingId.parse("LT12"), /商品稿编号是数字/);
	assert.throws(() => WriteId.parse("#3"), /写入的编号是数字/);
	assert.equal(PageItemId.safeParse("x").success, false);
});

test("加购、预报的参数照 zod 解析时贴上标签：订单号空的不收", () => {
	const cart = cartParams.parse({
		offerId: "1014247787336",
		skuId: "6022174637511",
		qty: 1,
		title: "地垫",
		sku: "黑猫",
		price: 8.1,
		lines: [{ sn: "251009ABCDEF01", modelId: "250000000011", qty: 1 }],
	});
	assert.equal(cart.lines[0]!.sn, "251009ABCDEF01");
	assert.throws(() =>
		forecastParams.parse({ sn: "", chanbossId: "88001234", chanbossTime: 1, lines: [{ modelId: "1", chanbossModelId: "2", qty: 1, trackingNo: null }] }),
	);
});
