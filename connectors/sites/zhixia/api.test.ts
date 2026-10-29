// 知虾的回包解析：热搜词、竞品是真回包（penna 的样本），1688 同款照代码写的；看解析出来的样子，回包变了要说哪个接口、哪一格
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { reply } from "../../../platform/reply.ts";
import { bySales30Day, hotWord, item, similarOf } from "./api.ts";

const sample = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("热搜词（真回包）：id、词、搜索量、30 天销量都在，别的格原样留着", () => {
	const b = reply(z.looseObject({ hotWordList: z.array(hotWord) }), sample("hot-word-list"), "知虾 /hotWord/hotWordList");
	assert.deepEqual(
		b.hotWordList.map((w) => [w.hotWordId, w.word, w.searchVal, w.sales30day]),
		[
			[22673, "牙膏", 295962, 29385],
			[118237936, "超細", 211, 12183],
			[65128509, "浴室置物架", 129947, 82626],
		],
	);
	assert.equal(b.hotWordList[0]?.recPrice, 32.38);
});

test("竞品（真回包）：按 30 天销量从高到低（销量是字符串）", () => {
	const b = reply(z.looseObject({ itemListInfo: z.array(item) }), sample("hot-word-item-sales-detail"), "知虾 /hotWordDetail/hotWordItemSalesDetail");
	assert.deepEqual(
		bySales30Day(b.itemListInfo).map((i) => i.itemId),
		["4289577060", "446370772", "2686492485", "25123817301"],
	);
});

test("1688 同款：只取前 n 个；没给价格、销量是 0，没有列表是回包变了", () => {
	assert.deepEqual(similarOf(sample("similar-1688"), 2), [
		{
			offerId: "1014247787336",
			url: "https://detail.1688.com/offer/1014247787336.html",
			title: "浴水生财猫咪浴室地垫",
			price: 8.1,
			monthSold: 1200,
			image: "https://cbu01.alicdn.com/img/ibank/a.jpg",
		},
		{ offerId: "720000000001", url: "https://detail.1688.com/offer/720000000001.html", title: "硅藻泥地垫", price: 0, monthSold: 0, image: "" },
	]);
	assert.throws(() => similarOf({ code: 200 }), /知虾 \/similarProduct\/query1688 的回包变了：data 没有了/);
});
