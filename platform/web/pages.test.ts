// 页：push 照组件的参数校验，说哪一格不对
import assert from "node:assert/strict";
import { test } from "node:test";
import { Usage } from "../errors.ts";
import { actParams, deletablePageIds, invalidOf, nextAnswer, nextNotes, pageVisible, parseAnswer, parseItem, parseProps, refKey } from "./pages.ts";

test("页：没有的组件说有哪些；参数不对说哪一格", () => {
	assert.throws(
		() => parseItem({ component: "nope", props: {} }),
		(e: Error) => e instanceof Usage && /没有组件 nope/.test(e.message),
	);
	assert.throws(
		() => parseItem({ component: "chart", props: { type: "pie", data: [{ d: "一", n: 1 }], x: "zz", y: ["n", "m"] } }),
		(e: Error) => e instanceof Usage && /x：data 里没有 x 这一列；y：pie 只画一列/.test(e.message),
	);
	assert.deepEqual(parseItem({ component: "markdown", props: { text: "hi" } }), { component: "markdown", props: { text: "hi" } });
});

test("页：改参数照组件自己的校验（x2 page update），整份换掉", () => {
	assert.deepEqual(parseProps("stats", { items: [{ label: "待出货", value: 3 }] }), { items: [{ label: "待出货", value: 3 }] });
	assert.throws(
		() => parseProps("stats", { items: [] }),
		(e: Error) => e instanceof Usage && /stats 的参数不对：items：/.test(e.message),
	);
	assert.throws(
		() => parseProps("nope", {}),
		(e: Error) => e instanceof Usage && /没有组件 nope/.test(e.message),
	);
});

test("choice 的答案：只认它的选项；单选只能一个；没请人写理由的不存理由；不收答案的组件说不收", () => {
	const props = { question: "用哪个？", options: [{ label: "A" }, { label: "B" }], reason: true };
	assert.deepEqual(parseAnswer("choice", props, { picked: ["B"], reason: " 便宜 " }), { picked: ["B"], reason: "便宜" });
	assert.deepEqual(parseAnswer("choice", { ...props, reason: false }, { picked: ["A"], reason: "x" }), { picked: ["A"] });
	assert.deepEqual(parseAnswer("choice", { ...props, multiple: true }, { picked: ["A", "B"] }), { picked: ["A", "B"] });
	for (const [p, a, why] of [
		[props, { picked: ["A", "B"] }, /只能选一个/],
		[props, { picked: [] }, /要选一个/],
		[props, { picked: ["C"] }, /picked\.0/],
		[{ ...props, multiple: true }, { picked: ["A", "A"] }, /选重了/],
	] as const)
		assert.throws(
			() => parseAnswer("choice", p, a),
			(e: Error) => e instanceof Usage && why.test(e.message),
		);
	assert.throws(
		() => parseAnswer("markdown", { text: "x" }, {}),
		(e: Error) => e instanceof Usage && /markdown 不收答案/.test(e.message),
	);
});

test("替组件调工具：引用说了算，网页只能填声明过的参数（chat 能换会话，换不了店）", () => {
	const ref = { title: "问尺寸的买家", shop: "ni1206", conversationId: "1" };
	assert.deepEqual(actParams(ref, { conversationId: "2", shop: "cheeroutdoor" }, ["conversationId"]), { shop: "ni1206", conversationId: "2" });
	assert.deepEqual(actParams(ref, { shop: "cheeroutdoor" }, []), { shop: "ni1206", conversationId: "1" });
	assert.deepEqual(actParams({ shop: "ni1206" }, "不是对象", ["conversationId"]), { shop: "ni1206" });
});

test("同一个引用：键的先后、标题、筛选里一个值写不写成数组都不算不同", () => {
	const a = refKey({ title: "审稿", table: "listings", filter: { step: "待批准", shop: ["ni1206"] } });
	assert.equal(a, refKey({ filter: { shop: "ni1206", step: ["待批准"] }, table: "listings" }));
	assert.notEqual(a, refKey({ table: "listings", filter: { step: "待批准" } }));
});

test("饼图最多 8 块：颜色按顺序用、不循环，多的要并进「其他」", () => {
	const data = Array.from({ length: 9 }, (_, i) => ({ 店: `店${i}`, 销售额: i + 1 }));
	assert.throws(
		() => parseItem({ component: "chart", props: { type: "pie", data, x: "店", y: ["销售额"] } }),
		(e: Error) => e instanceof Usage && /pie 最多 8 块/.test(e.message),
	);
	parseItem({ component: "chart", props: { type: "pie", data: data.slice(0, 8), x: "店", y: ["销售额"] } });
});

test("组件的参数是严格的：多出来的、打错的键报错；库里存的旧参数照现在的组件查出对不上，不悄悄丢掉", () => {
	assert.throws(
		() => parseItem({ component: "datagrid", props: { table: "writes", filtr: { status: "结果未知" } } }),
		(e: Error) => e instanceof Usage && /filtr/.test(e.message),
	);
	assert.match(invalidOf("datagrid", { table: "writes", view: "全部" }).invalid ?? "", /view/);
	assert.deepEqual(invalidOf("datagrid", { table: "writes", filter: { status: ["结果未知"] } }), {});
});

test("逐行选择表支持100行、图片和缺失链接，不接受重复行编号或列数错配", () => {
	const rows = Array.from({ length: 100 }, (_, i) => ({
		id: `item-${i}`,
		name: `商品${i}`,
		image: "https://example.com/image.jpg",
		link: i ? "https://example.com/item" : null,
		cells: [i],
	}));
	const parsed = parseProps("choice-table", { columns: ["销量"], rows }) as { rows: unknown[] };
	assert.equal(parsed.rows.length, 100);
	assert.throws(() => parseProps("choice-table", { rows: [rows[0], rows[0]], columns: ["销量"] }), /编号不能重复/);
	assert.throws(() => parseProps("choice-table", { rows: [rows[0]] }), /列数/);
});

test("逐行选择只接受表内商品及明确决定，空答案不替人作选择", () => {
	const props = {
		rows: [
			{ id: "first", name: "商品一" },
			{ id: "second", name: "商品二" },
		],
	};
	assert.deepEqual(parseAnswer("choice-table", props, { first: "yes" }), { first: "yes" });
	assert.deepEqual(parseAnswer("choice-table", props, { second: "no" }), { second: "no" });
	assert.deepEqual(parseAnswer("choice-table", props, { first: "pending" }), { first: "pending" });
	assert.throws(() => parseAnswer("choice-table", props, {}), /至少/);
	assert.throws(() => parseAnswer("choice-table", props, { missing: "yes" }), /答案不对/);
	assert.throws(() => parseAnswer("choice-table", props, { first: "publish" }), /答案不对/);
});

test("逐行选择可保留同一商品的货源与竞品链接，只接受 HTTP 地址", () => {
	const row = {
		id: "sku-1",
		name: "商品一",
		link: "https://detail.1688.com/offer/1.html",
		links: [{ label: "竞品", url: "https://shopee.tw/product/1/2" }],
	};
	const parsed = parseProps("choice-table", { rows: [row] }) as { rows: { link: string; links: { label: string; url: string }[] }[] };
	assert.equal(parsed.rows[0]!.link, row.link);
	assert.deepEqual(parsed.rows[0]!.links, row.links);
	assert.throws(() => parseProps("choice-table", { rows: [{ ...row, links: [{ label: "竞品", url: "javascript:alert(1)" }] }] }));
});

test("逐行选择表可以单独开启自定义描述，原有行和选择标签保持兼容", () => {
	const props = { editableNotes: true, noteLabel: "自定义描述", rows: [{ id: "first", name: "商品一" }] };
	assert.doesNotThrow(() => parseProps("choice-table", props));
	assert.deepEqual(parseAnswer("choice-table", props, { first: "no" }), { first: "no" });
});

test("自定义描述逐行合并、允许清空并保留换行，不覆盖其他商品的描述", () => {
	const props = {
		editableNotes: true,
		rows: [
			{ id: "first", name: "商品一" },
			{ id: "second", name: "商品二" },
		],
	};
	const first = nextNotes("choice-table", props, null, { rowId: "first", text: "  我的描述\n下一行  " });
	const both = nextNotes("choice-table", props, first, { rowId: "second", text: "另一个商品" });
	assert.deepEqual(both, { first: "  我的描述\n下一行  ", second: "另一个商品" });
	assert.deepEqual(nextNotes("choice-table", props, both, { rowId: "first", text: "" }), { first: "", second: "另一个商品" });
	assert.deepEqual(first, { first: "  我的描述\n下一行  " });
});

test("自定义描述只允许已开启的表内行，不能夹带选用决定或覆盖损坏的原数据", () => {
	const props = { editableNotes: true, rows: [{ id: "first", name: "商品一" }] };
	assert.throws(() => nextNotes("choice-table", { ...props, editableNotes: false }, {}, { rowId: "first", text: "描述" }), /描述不对/);
	assert.throws(() => nextNotes("choice-table", props, {}, { rowId: "missing", text: "描述" }), /描述不对/);
	assert.throws(() => nextNotes("choice-table", props, {}, { rowId: "first", text: "字".repeat(4001) }), /描述不对/);
	assert.throws(() => nextNotes("choice-table", props, {}, { rowId: "first", text: "描述", decision: "yes" }), /描述不对/);
	assert.throws(() => nextNotes("choice-table", props, "旧数据损坏", { rowId: "first", text: "描述" }), /保留原描述/);
	assert.deepEqual(nextNotes("choice-table", props, { removed: "之前记录的描述" }, { rowId: "first", text: "新描述" }), {
		removed: "之前记录的描述",
		first: "新描述",
	});
});

test("逐行保存保留其他行的决定，撤回只影响指定行；普通单选保持整体替换", () => {
	const props = {
		rows: [
			{ id: "first", name: "商品一" },
			{ id: "second", name: "商品二" },
		],
	};
	const first = nextAnswer("choice-table", props, null, { first: "yes" });
	const both = nextAnswer("choice-table", props, first, { second: "no" });
	assert.deepEqual(both, { first: "yes", second: "no" });
	assert.deepEqual(nextAnswer("choice-table", props, both, { first: "pending" }), { first: "pending", second: "no" });
	assert.deepEqual(nextAnswer("choice-table", props, both, { first: "no" }), { first: "no", second: "no" });
	assert.throws(() => nextAnswer("choice-table", props, "旧数据损坏", { first: "yes" }), /保留原答案/);
	assert.deepEqual(nextAnswer("choice", { question: "选哪个", options: [{ label: "A" }, { label: "B" }] }, { picked: ["A"] }, { picked: ["B"] }), {
		picked: ["B"],
	});
});

test("批量删页：重复编号只删一次，混入固定工作区或不存在的页就整批拒绝", () => {
	const pages = [
		{ id: "1", workspace_key: null, fixed: false },
		{ id: "2", workspace_key: null, fixed: false },
		{ id: "3", workspace_key: "catalog-shop", fixed: true },
		{ id: "4", workspace_key: null, fixed: true },
	];
	assert.deepEqual(deletablePageIds(["1", "2", "1"], pages), ["1", "2"]);
	assert.throws(() => deletablePageIds(["1", "3"], pages), /固定工作区/);
	assert.throws(() => deletablePageIds(["1", "4"], pages), /固定工作区/);
	assert.throws(() => deletablePageIds(["1", "99"], pages), /不存在/);
});

test("批量删页：空选择、非数字编号和错误请求不执行删除", () => {
	for (const input of [[], ["1", "oops"], [1], { ids: ["1"] }, null]) assert.throws(() => deletablePageIds(input, []), /选择|编号/);
});

test("停用的固定工作区不降级为临时页，旧链接也不能打开；临时页保留", () => {
	assert.equal(pageVisible(null, ["catalog-cheeroutdoor"]), true);
	assert.equal(pageVisible("catalog-cheeroutdoor", ["catalog-cheeroutdoor"]), true);
	assert.equal(pageVisible("catalog-ni1206", ["catalog-cheeroutdoor"]), false);
	assert.equal(pageVisible("chat-ni1206", ["catalog-cheeroutdoor"]), false);
});
