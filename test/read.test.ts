// 现读：同一个进程里读过的复用，过期了重读，读失败的不留
import assert from "node:assert/strict";
import { test } from "node:test";
import { reuse } from "../src/flows/read.ts";

test("同一个进程里读过的复用，过期了重读；读失败的不留", async () => {
	let n = 0;
	const count = (maxAge?: number) => reuse("试读", async () => ++n, maxAge);
	assert.equal(await count(), 1);
	assert.equal(await count(), 1);
	assert.equal(await count(0), 2);
	assert.equal(await count(), 2);

	let slider = true;
	const flaky = () =>
		reuse("会失败", async () => {
			if (slider) throw new Error("要过滑块");
			return "读到了";
		});
	await assert.rejects(flaky(), /要过滑块/);
	slider = false;
	assert.equal(await flaky(), "读到了");
});
