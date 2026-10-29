// 页：push 照组件的参数校验，说哪一格不对
import assert from "node:assert/strict";
import { test } from "node:test";
import { Usage } from "../errors.ts";
import { parseItem, parseProps } from "./pages.ts";

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
