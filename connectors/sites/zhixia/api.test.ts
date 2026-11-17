// 知虾的回包解析：热搜词、竞品是真回包（penna 的样本），1688 同款照代码写的；看解析出来的样子，回包变了要说哪个接口、哪一格
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { z } from "zod";
import { NeedsHuman } from "../../../platform/errors.ts";
import { reply } from "../../../platform/reply.ts";
import { bySales30Day, demandSeries, hotWord, item, probeIdentity, similarOf, siteContextOf, withExpectedSite } from "./api.ts";

test("需求变化真实样本只提取sales与日期，未核实日值定义不能由字段名推断", () => {
	const series = demandSeries(sample("demand-change"));
	assert.equal(series.metric, "sales");
	assert.equal(series.basis, "observed");
	assert.equal(series.source.aggregationWindow, "unknown");
	assert.match(series.source.scope, /前10页/);
	assert.equal(series.points.length, 30);
	assert.equal(series.points[0]?.date, "2026-10-18");
	assert.equal(series.points.at(-1)?.date, "2026-11-16");
	assert.equal(series.points.at(-1)?.value, "2460");
	assert.deepEqual(
		demandSeries({ charts: [{ timest: "20261101", sales: "" }, { timest: "20261102" }] }).points.map((p) => p.value),
		["", null],
	);
	assert.throws(() => demandSeries({ charts: [{ timest: "bad", sales: 1 }] }));
	assert.throws(() => demandSeries({ data: [] }));
});

const sample = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

test("站点上下文（原生getter实读）：保留页面名称，站点变更时不能借样本默认值继续", () => {
	assert.deepEqual(siteContextOf(sample("site-context"), 1), { siteId: 1, siteName: "中国台湾" });
	assert.throws(() => siteContextOf(sample("site-context"), 2), NeedsHuman);
});

test("站点校验：沿用实际编号，不给缺失编号默认值，不按编号猜名称", () => {
	assert.deepEqual(siteContextOf({ siteId: 7 }), { siteId: 7, siteName: null });
	assert.deepEqual(siteContextOf({ siteId: "7", siteName: "页面原生名称" }, 7), { siteId: 7, siteName: "页面原生名称" });
	assert.deepEqual(siteContextOf({ siteId: 7, siteName: { label: "不得猜测" } }), { siteId: 7, siteName: null });
	assert.throws(
		() => siteContextOf({ siteId: 7 }, 1),
		(error) => error instanceof NeedsHuman && /编号7与期望站点编号1不符/.test(error.message),
	);
	for (const siteId of [undefined, null, "", "  ", false, 0, -1, 1.5, "no-id", Number.NaN])
		assert.throws(
			() => siteContextOf({ siteId }),
			(error) => error instanceof NeedsHuman && /无法确认/.test(error.message),
		);
});

test("期望站点在异步链中继承，并发和嵌套调用互不串站", async () => {
	await Promise.all([
		withExpectedSite(2, async () => {
			await Promise.resolve();
			assert.equal(siteContextOf({ siteId: 2 }).siteId, 2);
			assert.throws(() => siteContextOf({ siteId: 3 }), NeedsHuman);
			await withExpectedSite(3, async () => assert.equal(siteContextOf({ siteId: 3 }).siteId, 3));
			await withExpectedSite(undefined, async () => assert.throws(() => siteContextOf({ siteId: 3 }), NeedsHuman));
			assert.throws(() => siteContextOf({ siteId: 3 }), NeedsHuman);
		}),
		withExpectedSite(3, async () => {
			await Promise.resolve();
			assert.equal(siteContextOf({ siteId: 3 }).siteId, 3);
			assert.throws(() => siteContextOf({ siteId: 2 }), NeedsHuman);
		}),
	]);
	assert.equal(siteContextOf({ siteId: 4 }).siteId, 4);
});

test("登录身份探测不继承市场期望，探测成功后实际读取仍明确报站点不符", async () => {
	await withExpectedSite(999, async () => {
		const actual = await probeIdentity(async () => {
			await Promise.resolve();
			return withExpectedSite(undefined, async () => siteContextOf(sample("site-context")));
		});
		assert.deepEqual(actual, { siteId: 1, siteName: "中国台湾" });
		assert.throws(
			() => siteContextOf(sample("site-context")),
			(error) => error instanceof NeedsHuman && /编号1与期望站点编号999不符/.test(error.message),
		);
	});
});

test("身份探测失败或并发完成都不清除其他正常读取的期望站点", async () => {
	await Promise.all([
		withExpectedSite(999, async () => {
			const failedLogin = new NeedsHuman("实际未登录");
			await assert.rejects(
				probeIdentity(async () => {
					await Promise.resolve();
					throw failedLogin;
				}),
				(error) => error === failedLogin,
			);
			assert.throws(() => siteContextOf(sample("site-context")), /期望站点编号999/);
		}),
		withExpectedSite(2, async () => {
			await Promise.resolve();
			assert.throws(() => siteContextOf(sample("site-context")), /期望站点编号2/);
		}),
	]);
});

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
