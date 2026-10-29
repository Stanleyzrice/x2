// 页：push 照组件的参数校验，说哪一格不对
import assert from "node:assert/strict";
import { test } from "node:test";
import { Usage } from "../errors.ts";
import { actParams, parseAnswer, parseItem, parseProps, refKey } from "./pages.ts";

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
