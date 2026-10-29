// 规格名的比较：在货源的规格里配店里的规格、规格例外
import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, matchSku, rank } from "./similar.ts";

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

test("在货源的规格里配店里的规格：只有一个对得上才配；单规格直接用；配不上回 null", () => {
	const skus = [{ name: "L20黑色（最大拉力12kg）" }, { name: "L20银色（最大拉力12kg）" }, { name: "L42黑色（最大拉力69kg）" }];
	assert.equal(matchSku("L20黑色（最大拉力12kg）", skus)?.name, "L20黑色（最大拉力12kg）");
	assert.equal(matchSku("L42銀色（最大拉力69kg）", skus), null);
	assert.equal(matchSku("", [{ name: "" }])?.name, "");
});

test("规格例外：按名字配不上时照人写的配（繁简、空格不算）；写的那个货源里没有了回 null", () => {
	const spec = "特粗26管雙層側三網150金+輪";
	assert.equal(matchSku(spec, rack), null);
	const ex = "别的规格 = 特厚25管全钢-双杆150黑+万向轮\n特粗26管双层侧三网150金+轮 = 顶配侧三层置物网+双层置物架+双杆150金+万向轮";
	assert.equal(matchSku(spec, rack, ex)?.name, "顶配侧三层置物网+双层置物架+双杆150金+万向轮");
	assert.equal(matchSku(spec, rack, `${spec} = 顶配侧三层置物网+双层置物架+双杆150银+万向轮`), null);
	assert.equal(matchSku("", [{ name: "红" }, { name: "蓝" }]), null);
	assert.equal(matchSku("", [{ name: "红" }, { name: "蓝" }], "（单规格） = 蓝")?.name, "蓝");
});
