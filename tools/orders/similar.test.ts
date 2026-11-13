// 规格名的比较：在货源的规格里配店里的规格、规格例外
import assert from "node:assert/strict";
import { test } from "node:test";
import { addException, compare, matchSku, rank, sameName } from "./similar.ts";

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

test("x2 orders spec：两边都要对得上（繁简、空格不算）；配不上说最像的；同一个店里的规格写过的换掉", () => {
	const sold = ["特粗26管雙層側三網150金+輪"];
	const errorOf = (r: ReturnType<typeof addException>) => ("error" in r ? r.error : "");
	const source = { title: "衣帽架货源", skus: rack, exceptions: null };
	assert.match(errorOf(addException("特粗26管", sold, source)), /^--spec 写成/);
	assert.match(errorOf(addException("特粗26管 = 顶配侧三层置物网+双层置物架+双杆150金+万向轮", sold, source)), /卖过的规格里没有「特粗26管」/);
	assert.match(errorOf(addException("特粗26管雙層側三網150金+輪 = 顶配150银", sold, source)), /里没有「顶配150银」。最像的：顶配/);
	const first = addException("特粗26管双层侧三网150金+轮 = 顶配侧三层置物网+双层置物架+双杆150白+万向轮", sold, source);
	assert.ok(!("error" in first));
	const again = addException("特粗26管雙層側三網150金+輪=顶配侧三层置物网+双层置物架+双杆150金+万向轮", sold, {
		...source,
		exceptions: `别的规格 = 特厚25管全钢-双杆150黑+万向轮\n${first.exceptions}`,
	});
	assert.deepEqual(again, {
		spec: "特粗26管雙層側三網150金+輪",
		sku: "顶配侧三层置物网+双层置物架+双杆150金+万向轮",
		exceptions: "别的规格 = 特厚25管全钢-双杆150黑+万向轮\n特粗26管雙層側三網150金+輪 = 顶配侧三层置物网+双层置物架+双杆150金+万向轮",
	});
});

test("规格规范化保留字母尺码、小数和数字边界，不把不同规格合并", () => {
	for (const [a, b] of [
		["XL", "L"],
		["1.5m", "15m"],
		["10×20cm", "1020cm"],
		["36-37", "3637"],
	])
		assert.equal(sameName(a!, b!), false);
	assert.equal(sameName("60*90cm", "60 × 90cm"), true);
	assert.equal(matchSku("XL", [{ name: "L" }]), null);
});

test("相似度仅供建议，缺少完整属性、额外尺寸或同名重复 SKU 均不自动决定采购", () => {
	assert.equal(matchSku("42", [{ name: "42 43" }]), null);
	assert.equal(matchSku("黑色", [{ name: "黑色加绒" }]), null);
	assert.equal(matchSku("大号加厚", [{ name: "大号" }]), null);
	const repeated = [
		{ name: "黑色", skuId: "a" },
		{ name: "黑色", skuId: "b" },
	];
	assert.equal(matchSku("黑色", repeated), null);
	assert.equal(matchSku("页面规格", repeated, "页面规格 = 黑色"), null);
	assert.equal(matchSku("黑色", [{ name: "黑色" }, { name: "白色" }], "黑色 = 黑色\n黑色 = 白色"), null);
	assert.ok("error" in addException("页面规格 = 黑色", ["页面规格"], { title: "货源", skus: repeated, exceptions: null }));
});

test("完整属性值允许顺序不同，返回唯一原始 SKU 对象", () => {
	const selected = { name: "白色 / 大号", attrs: ["白色", "大号"], skuId: "a" };
	assert.strictEqual(matchSku("大号,白色", [selected, { name: "白色 / 小号", attrs: ["白色", "小号"], skuId: "b" }]), selected);
	assert.equal(matchSku("大号,白色,加厚", [selected]), null);
});

const rackSkus = [
	["fixture-rack-1", "【加厚款】72x11.8x188cm"],
	["fixture-rack-2", "【钢制-常规】6层-82x9x188cm"],
	["5696255372057", "【钢制-加厚】6层-62x11.8x188cm"],
	["fixture-rack-4", "【钢制-加厚】6层-82x11.8x188cm"],
	["fixture-rack-5", "【常规款】72x9x188cm"],
	["fixture-rack-6", "【加厚款】102x11.8x188cm"],
	["fixture-rack-7", "【常规款】52x9x188cm"],
	["fixture-rack-8", "【加厚款】52x11.8x188cm"],
	["fixture-rack-9", "【钢制-常规】6层-62x9x188cm"],
].map(([skuId, first]) => ({ skuId: skuId!, name: `${first} / 多层储物 双层防掉`, attrs: [first!, "多层储物 双层防掉"] }));

test("真实货架的完整尺寸链与明确加厚款唯一对应，不按营销词或排名选择", () => {
	const expected = rackSkus[2]!;
	assert.strictEqual(matchSku("62*11.8*188,加厚款", rackSkus), expected);
	assert.strictEqual(matchSku("加厚款,62×11.8×188cm", rackSkus), expected);
	const withoutAttrs = rackSkus.map(({ attrs: _attrs, ...sku }) => sku);
	assert.strictEqual(matchSku("62*11.8*188,加厚款", withoutAttrs), withoutAttrs[2]);
	assert.equal(matchSku("62*11.8*188,加厚款", [...rackSkus, { ...expected, skuId: "duplicate" }]), null);
});

test("尺寸链匹配不忽略单位冲突、尺寸顺序、款式缺失或额外订单属性", () => {
	for (const spec of ["62*11.8*188mm,加厚款", "62*188*11.8,加厚款", "62*11.8*188", "62*11.8*188,常规款", "62*11.8*188,加厚款,红色"])
		assert.equal(matchSku(spec, rackSkus), null);
	assert.equal(matchSku("62*11.8*188,加厚款", [{ name: "【非加厚款】62x11.8x188cm", attrs: ["【非加厚款】62x11.8x188cm"] }]), null);
});

test("尺寸链不从范围中截出末端，未知材质或复合款式不能被排除后制造假唯一", () => {
	for (const dimensions of ["52-62x11.8x188cm", "60~62x11.8x188cm", "62x11.8x188-200cm", "62x11.8x188～200cm"])
		assert.equal(matchSku("62*11.8*188,加厚款", [{ name: `【加厚款】${dimensions}` }]), null);
	for (const label of ["塑料-加厚", "钢制-加厚加绒"]) {
		const other = {
			...rackSkus[2]!,
			skuId: "different",
			name: `【${label}】6层-62x11.8x188cm / 多层储物 双层防掉`,
			attrs: [`【${label}】6层-62x11.8x188cm`, "多层储物 双层防掉"],
		};
		assert.equal(matchSku("62*11.8*188,加厚款", [...rackSkus, other]), null);
	}
});
