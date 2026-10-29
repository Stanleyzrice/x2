// 会话：push 照组件的参数校验，说哪一格不对
import assert from "node:assert/strict";
import { test } from "node:test";
import { Usage } from "../errors.ts";
import { parseItem } from "./sessions.ts";

test("会话：没有的组件说有哪些；参数不对说哪一格", () => {
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
