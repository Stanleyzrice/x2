import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serve } from "./server.ts";
import { requireLocal } from "./setup.ts";

test("配置写入要求实际本机、准确端口及同源", () => {
	const request = (remoteAddress: string, host: string, origin?: string) =>
		({ method: "POST", socket: { remoteAddress }, headers: { host, origin } }) as IncomingMessage;
	assert.doesNotThrow(() => requireLocal(request("127.0.0.1", "127.0.0.1:5170", "http://127.0.0.1:5170"), 5170));
	assert.throws(() => requireLocal(request("127.0.0.1", "127.0.0.1:5170", "https://unrelated.example"), 5170));
	assert.throws(() => requireLocal(request("127.0.0.1", "127.0.0.1:5170"), 5170));
	assert.throws(() => requireLocal(request("192.0.2.2", "localhost:5170", "http://localhost:5170"), 5170));
	assert.throws(() => requireLocal(request("127.0.0.1", "outside.example:5170", "http://outside.example:5170"), 5170));
});

test("没有数据库时仍可以加载启动页面和脱敏配置状态", async () => {
	const dist = await mkdtemp(join(tmpdir(), "x2-setup-test-"));
	await writeFile(join(dist, "index.html"), "<div id=root>setup</div>");
	const server = await serve(
		async () => {
			throw new Error("fixture database unavailable");
		},
		{ host: "127.0.0.1", port: 0, dist, scratch: true },
	);
	try {
		const base = `http://127.0.0.1:${server.port}`;
		const page = await fetch(base);
		assert.equal(page.status, 200);
		assert.match(await page.text(), /setup/);
		const setup = await (await fetch(`${base}/api/setup`)).json();
		assert.equal(setup.ready, false);
		assert.equal(setup.database, false);
		assert.equal(setup.local, true);
		assert.ok(!("apiKey" in setup));
		assert.ok(!("databaseUrl" in setup));
	} finally {
		await server.stop();
		await rm(dist, { recursive: true, force: true });
	}
});
