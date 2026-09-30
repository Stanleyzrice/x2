import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, rank } from "../src/similar.ts";

// 例子都是 2026-09-30 真实订单里的规格名和它们的 1688 货源
const rack = [
	"特厚25管全钢-双杆150黑+万向轮",
	"特厚25管全钢-双层置物架+双杆150黑+万向轮",
	"顶配侧三层置物网+双层置物架+双杆120金+万向轮",
	"顶配侧三层置物网+双层置物架+双杆150白+万向轮",
	"顶配侧三层置物网+双层置物架+双杆150金+万向轮",
].map((name) => ({ name }));

test("衣帽架：侧三层、150、金的排第一，缺的只有 26 管", () => {
	const [best] = rank("特粗26管雙層側三網150金+輪", rack);
	assert.equal(best!.name, "顶配侧三层置物网+双层置物架+双杆150金+万向轮");
	assert.deepEqual(best!.missing, ["26管"]);
});

test("缺的数字、颜色列出来", () => {
	assert.deepEqual(compare("特粗26管雙層側三網150金+輪", "顶配侧三层置物网+双层置物架+双杆150白+万向轮").missing, ["26管", "金"]);
	assert.deepEqual(compare("特粗26管雙層側三網150金+輪", "顶配侧三层置物网+双层置物架+双杆120金+万向轮").missing, ["26管", "150"]);
});

test("kitty 地垫：款式号和尺寸都要对上", () => {
	const skus = ["kitty猫款式2 / 40*60cm【硅藻泥】3mm", "kitty猫款式10 / 60*90cm【硅藻泥】3mm", "kitty猫款式2 / 60*90cm【硅藻泥】3mm"].map((name) => ({ name }));
	const [best] = rank("kitty貓款式2,60*90cm【硅藻泥】3mm", skus);
	assert.equal(best!.name, "kitty猫款式2 / 60*90cm【硅藻泥】3mm");
	assert.deepEqual(best!.missing, []);
});
