// 人说了的改动：放弃、定类目、保留的图、估重量和国内运费，能不能做、改成什么；按策略加货源要写理由
import assert from "node:assert/strict";
import { test } from "node:test";
import { AUDIT_DROP } from "./audit.ts";
import { cancelBlock, categoryBlock, estimateFill, keepImages } from "./edits.ts";
import { listing } from "./index.ts";

const name = "雨衣（cheeroutdoor，#7）";

test("x2 listing cancel：已上架的是下架、建了商品的不 publish，都不是放弃；建商品还没核清的先核清；放弃过的照样收", () => {
	const draft = { cancelled: false, product_id: null, listed_at: null };
	assert.equal(cancelBlock(name, draft, []), null);
	assert.equal(cancelBlock(name, { ...draft, cancelled: true, product_id: "9002" }, []), null);
	assert.equal(cancelBlock(name, { ...draft, product_id: "9002" }, []), `${name}已经建了商品（商品 9002，下架）：不上架就不 publish，不是放弃`);
	assert.equal(cancelBlock(name, { ...draft, product_id: "9002", listed_at: new Date() }, []), `${name}已上架（商品 9002）：不卖了是下架，不是放弃`);
	assert.equal(cancelBlock(name, draft, [{ op: "建商品", status: "结果未知" }]), `${name}在建商品中（建商品：结果未知）：可能已经建了，先核清（x2 verify）`);
});

test("x2 listing category：建了商品的不改；店铺设置了允许的类目，人定的要在里面", () => {
	const l = { shop: "cheeroutdoor", product_id: null, listed_at: null };
	const full = "居家生活 > 浴室用品 > 浴簾";
	assert.equal(categoryBlock(name, l, "101325", full, null), null);
	assert.equal(categoryBlock(name, l, "101324", full, new Set(["101324"])), null);
	assert.equal(categoryBlock(name, l, "101325", full, new Set(["101324"])), `${name}：「${full}」不在 cheeroutdoor 允许的类目里（店铺设置的「允许的类目」）`);
	assert.equal(categoryBlock(name, { ...l, product_id: "9003" }, "101324", full, null), `${name}已经建了商品（商品 9003）：不改类目`);
});

test("x2 listing keep：按图的名字找图；没有的说有哪些；人删的不放回来；x2 去掉的放回来", () => {
	const pic = (id: string, extra: object = {}) => ({ from: `${id}.jpg`, imageId: id, width: 800, height: 800, ...extra });
	const images = { main: [pic("m1"), pic("m2", { drop: `${AUDIT_DROP}「质量」` })], detail: [pic("d1"), pic("d2")], options: [] };
	const keep = (asked: string[]) => keepImages(name, asked, images, ["d1"], AUDIT_DROP);
	assert.deepEqual(keep(["详情图 1"]), { error: `${name}的详情图 1是人删的（已删除的图），不放回来` });
	assert.deepEqual(keep(["主图 9"]), { error: `${name}没有主图 9（有：主图 1、主图 2、详情图 1、详情图 2）` });
	assert.deepEqual(keep(["主图 2", "详情图 2"]), { imageIds: ["m2", "d2"], restored: ["主图 2"] });
});

test("x2 listing estimate：只填空着的「重量」「国内运费」，人填过的、估过的不动；1688 给了的不用估", () => {
	const offer = { tags: { freeShipping: false } };
	const empty = { weight_kg: null, freight_rmb: null, offer };
	assert.deepEqual(estimateFill(empty, ["重量", "国内运费"], { weight: 1, freight: 10 }), {
		set: { weight_kg: 1, freight_rmb: 10 },
		notes: ["重量：记为 1 kg", "国内运费：记为 10 元/件"],
	});
	assert.deepEqual(estimateFill({ ...empty, weight_kg: "0.8" }, ["重量"], { weight: 2 }), {
		set: {},
		notes: ["重量：已有 0.8 kg（人填的或估过的），不改"],
	});
	assert.deepEqual(estimateFill(empty, [], { weight: 2 }).notes, ["重量：1688 给了每个规格的重量，不用估"]);
	assert.deepEqual(estimateFill({ ...empty, offer: { tags: { freeShipping: true } } }, [], { freight: 5 }), {
		set: {},
		notes: ["国内运费：货源包邮，不用估"],
	});
});

test("x2 listing add：按策略选的（带 --strategy）要写选品理由", () => {
	const ok = (p: object) => listing.tools.add!.params.safeParse({ shop: "cheeroutdoor", links: "901", ...p }).success;
	assert.equal(ok({ strategy: "季节" }), false);
	assert.equal(ok({ strategy: "季节", why: "冬天到了" }), true);
	assert.equal(ok({}), true);
});
