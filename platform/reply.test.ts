// 回包解析：对得上回解析好的样子（没写的格留着），对不上报「回包变了」，说哪个接口、哪一格
import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { idText, reply } from "./reply.ts";

const shape = z.object({ data: z.object({ list: z.array(z.looseObject({ id: idText, name: z.string() })) }) });

test("回包对得上：id 收成字符串，没写的格原样留着", () => {
	const got = reply(shape, { data: { list: [{ id: 12, name: "a", extra: true }] } }, "Shopee /api/x");
	assert.deepEqual(got.data.list, [{ id: "12", name: "a", extra: true }]);
});

test("回包变了：报错里有站、接口、哪一格，缺了的和类型不对的分开说", () => {
	assert.throws(() => reply(shape, { data: { list: [{ name: "a" }] } }, "Shopee /api/x"), /^Error: Shopee \/api\/x 的回包变了：data\.list\[0\]\.id 没有了/);
	assert.throws(() => reply(shape, { data: { list: [{ id: 1, name: 2 }] } }, "Shopee /api/x"), /data\.list\[0\]\.name 应该是 string，回的是 number 2/);
	assert.throws(() => reply(shape, null, "1688 购物车"), /1688 购物车 的回包变了：（整个回包） 应该是 object，回的是 null/);
});
