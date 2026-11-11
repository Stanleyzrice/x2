// 目录名称推断的用途优先级与待分类兜底。
import assert from "node:assert/strict";
import test from "node:test";
import { inferCategory } from "./categories.ts";

test("按用途分类，避免配件、宠物和收纳名称被宽泛关键词覆盖", () => {
	assert.equal(inferCategory("貓砂專用垃圾桶"), "宠物用品");
	assert.equal(inferCategory("Sanrio 毛絨吊飾 包包掛件"), "吊饰挂件");
	assert.equal(inferCategory("全棉床單四件組 含枕套"), "床品寝具");
	assert.equal(inferCategory("卡通水杯提袋"), "便当饮料提袋");
	assert.equal(inferCategory("未知商品"), "待分类");
});
