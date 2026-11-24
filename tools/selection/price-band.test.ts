import assert from "node:assert/strict";
import { test } from "node:test";
import { pricePosition, summarizePriceBand } from "../../platform/ui/interactable/selection/price-band-data.ts";
import { priceBandSource } from "./price-band.ts";

function item(id: number, price: number, sales: number, date: string | null = "20261116", shopId: number | null = id) {
	return {
		itemId: id,
		itemName: "浴室地墊 40 × 60 cm",
		shopId,
		siteId: 1,
		minPrice: price,
		maxPrice: price,
		itemDataList: [{ timest: date, sales30Day: String(sales) }],
	};
}

test("价格带只使用台湾站的同日单一标价，区分真实零销量和无日期的零值", () => {
	const source = priceBandSource("浴室地墊", [
		item(1, 179, 0, null),
		item(2, 199, 0),
		item(3, 199, 12),
		item(3, 199, 12),
		item(4, 169, 8, "20261115"),
		{ ...item(5, 99, 45), maxPrice: 299 },
		{ ...item(6, 199, 80), siteId: 2 },
	]);
	assert.deepEqual({ date: source.date, received: source.received, dated: source.dated }, { date: "2026-11-16", received: 5, dated: 3 });
	assert.equal(source.rows.length, 2);
	assert.equal(summarizePriceBand(source, "40x60").bands[0]?.sellingRate, 50);
	assert.equal(summarizePriceBand(source, "40x80").items, 0);
});

test("主力价带用销量加权，店铺先聚合，同价没有销量时不显示头部占比", () => {
	const source = priceBandSource("地墊", [
		item(1, 169, 2),
		item(2, 199, 2, "20261116", 10),
		item(3, 199, 3, "20261116", 10),
		item(4, 199, 4),
		item(5, 199, 3),
		item(6, 199, 2),
		item(7, 229, 0),
		item(8, 249, 1, "20261116", null),
	]);
	const { bands, mainBand } = summarizePriceBand(source, "");
	assert.deepEqual(mainBand, { lower: 199, upper: 199 });
	assert.equal(bands[1]?.topShopShare, (12 / 14) * 100);
	assert.equal(bands[2]?.topShopShare, null);
	assert.equal(bands[3]?.topShopShare, null);
	assert.deepEqual(
		pricePosition(
			bands.map(({ price }) => price),
			220,
		),
		{ index: 2, exact: false },
	);
});
