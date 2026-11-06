// 离线验证隧道失败不耗尽真实驱动连接池，保留原错误；本地回环连接验证恢复后的正常连接原样返回，不访问共享数据库。
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, createServer } from "node:net";
import { test } from "node:test";
import postgres from "postgres";
import { NeedsHuman } from "../errors.ts";
import { postgresSocket } from "./tunnel.ts";

test("连续隧道失败超过连接池大小仍逐次返回原错误，不让第三次查询永久排队", { timeout: 2000 }, async (t) => {
	const errors = Array.from({ length: 4 }, (_, n) => new NeedsHuman(`测试隧道失败 ${n + 1}`));
	let attempts = 0;
	const options = {
		max: 2,
		connect_timeout: 0.01,
		// 大启动包也必须保留隧道原错误，不能被未连接 Socket 的写入错误替代。
		connection: { application_name: "fixture".repeat(500) },
		socket: () =>
			postgresSocket(async () => {
				throw errors[attempts++]!;
			}),
	};
	const sql = postgres("postgres://fixture:fixture@127.0.0.1:1/fixture", options);
	t.after(() => sql.end({ timeout: 0 }));
	for (const expected of errors) await assert.rejects(sql`select 1`, (error: unknown) => error === expected);
	assert.equal(attempts, 4);
});

test("失败后可以重新建立本地连接，正常Socket原样返回，不把成功连接变成错误", { timeout: 2000 }, async (t) => {
	const expected = new NeedsHuman("测试网络暂不可达");
	for (let n = 0; n < 2; n++) {
		const failed = await postgresSocket(async () => {
			throw expected;
		});
		const [error] = await once(failed, "error");
		assert.equal(error, expected);
	}
	const server = createServer((socket) => socket.end("fixture connected"));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
	const address = server.address();
	assert.ok(address && typeof address === "object");
	const socket = connect({ host: "127.0.0.1", port: address.port });
	t.after(() => {
		socket.destroy();
	});
	await once(socket, "connect");
	const returned = await postgresSocket(async () => socket);
	assert.equal(returned, socket);
	const [data] = await once(returned, "data");
	assert.equal(data.toString(), "fixture connected");
});
