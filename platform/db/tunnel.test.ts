// 离线验证隧道失败不耗尽真实驱动连接池，保留原错误；本地回环连接验证恢复后的正常连接原样返回，不访问共享数据库。
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect, createServer, Socket } from "node:net";
import { Duplex } from "node:stream";
import { test } from "node:test";
import postgres from "postgres";
import { NeedsHuman } from "../errors.ts";
import { open, type ProbeStatus, postgresReply, postgresSocket, postgresStartup, probePostgres, reach, tunnelSshArgs, tunnelTarget } from "./tunnel.ts";

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

test("已发过close的Socket也逐次释放池位，后续查询不永久排队", { timeout: 2000 }, async (t) => {
	let attempts = 0;
	const options = {
		max: 1,
		connect_timeout: 0.02,
		socket: () =>
			postgresSocket(async () => {
				attempts++;
				const socket = Object.assign(new Socket(), { host: "fixture-host", port: 15432 });
				const closed = once(socket, "close");
				socket.destroy();
				await closed;
				return socket;
			}),
	};
	const sql = postgres("postgres://fixture:fixture@127.0.0.1:1/fixture", options);
	t.after(() => sql.end({ timeout: 0 }));
	for (let n = 0; n < 4; n++)
		await assert.rejects(sql`select 1`, (error: NodeJS.ErrnoException) => error.code === "CONNECTION_CLOSED" && /fixture-host:15432/.test(error.message));
	assert.equal(attempts, 4);
});

test("TCP工厂不触发connect时也按时失败，保留host/port并销毁连接", async () => {
	const socket = new Socket();
	await assert.rejects(
		reach("fixture-host", 15432, 15, () => socket),
		(error: NodeJS.ErrnoException) => error.code === "CONNECT_TIMEOUT" && /fixture-host:15432/.test(error.message),
	);
	assert.equal(socket.destroyed, true);
	assert.equal(socket.listenerCount("connect"), 0);
});

const url = "postgres://fixture:password-not-sent@127.0.0.1:15432/fixturedb";
const target = tunnelTarget(url, "x2-db");
const auth = Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0]);
function probeSocket(reply?: Buffer) {
	const writes: Buffer[] = [];
	const stream = new Duplex({
		read() {},
		write(chunk: Buffer, _encoding, done) {
			writes.push(Buffer.from(chunk));
			if (reply)
				setImmediate(() => {
					stream.push(reply.subarray(0, 3));
					stream.push(reply.subarray(3));
				});
			done();
		},
	});
	return { socket: stream as unknown as Socket, writes };
}

test("Startup探针只发用户名库名，不含密码或SQL；完整R/E确认活性，超时关闭独立Socket", async () => {
	const packet = postgresStartup(target);
	assert.equal(packet.readUInt32BE(0), packet.length);
	assert.equal(packet.readUInt32BE(4), 196608);
	assert.deepEqual(packet.subarray(8).toString().split("\0"), ["user", "fixture", "database", "fixturedb", "", ""]);
	assert.equal(packet.includes(Buffer.from("password-not-sent")), false);
	assert.equal(postgresReply(auth), true);
	assert.equal(postgresReply(auth.subarray(0, 5)), null);
	assert.equal(postgresReply(Buffer.from("not postgres")), false);
	const body = Buffer.from("SFATAL\0C28000\0Mfixture denied\0\0"),
		error = Buffer.alloc(body.length + 5);
	error[0] = 69;
	error.writeUInt32BE(body.length + 4, 1);
	body.copy(error, 5);
	assert.equal(postgresReply(error), true);
	for (const reply of [auth, error]) {
		const f = probeSocket(reply);
		assert.equal(await probePostgres(target, async () => f.socket, 100), "healthy");
		assert.deepEqual(f.writes, [packet]);
		assert.equal(f.socket.destroyed, true);
	}
	const silent = probeSocket();
	assert.equal(await probePostgres(target, async () => silent.socket, 15), "stale");
	assert.equal(silent.socket.destroyed, true);
	assert.equal(silent.socket.listenerCount("data"), 0);
});

function manager(initial: ProbeStatus, owned: boolean) {
	let status = initial,
		tail = Promise.resolve();
	const commands: string[] = [],
		sockets: Socket[] = [];
	let locks = 0,
		released = 0,
		probes = 0;
	const ops: NonNullable<Parameters<typeof open>[2]> = {
		probe: async () => {
			probes++;
			return status;
		},
		connect: async () => {
			if (status === "absent") throw Object.assign(new Error("fixture absent"), { code: "ECONNREFUSED" });
			const socket = new Socket();
			sockets.push(socket);
			return socket;
		},
		ssh: async (action) => {
			commands.push(action);
			if (action === "check") return owned;
			status = action === "exit" ? "absent" : "healthy";
			return true;
		},
		lock: async (name, options) => {
			assert.equal(name, `db-tunnel-${target.key}`);
			assert.ok(options.timeoutMs > 0 && options.timeoutMs < 60_000);
			locks++;
			const prior = tail;
			let done!: () => void;
			tail = new Promise<void>((resolve) => {
				done = resolve;
			});
			await prior;
			return {
				release: () => {
					released++;
					done();
				},
			};
		},
	};
	return { ops, commands, sockets, counts: () => ({ locks, released, probes }) };
}

test("托管失活隧道在锁内关闭重建，探针与给驱动的连接独立；健康不重启", async () => {
	const stale = manager("stale", true);
	const socket = await open(url, "x2-db", stale.ops);
	assert.deepEqual(stale.commands, ["check", "exit", "start"]);
	assert.equal(socket, stale.sockets[0]);
	assert.deepEqual(stale.counts(), { locks: 1, released: 1, probes: 3 });
	socket.destroy();
	const healthy = manager("healthy", false);
	(await open(url, "x2-db", healthy.ops)).destroy();
	assert.deepEqual(healthy.commands, []);
	assert.deepEqual(healthy.counts(), { locks: 0, released: 0, probes: 1 });
});

test("非托管失活forward不退出、不启动、不杀进程；不存在监听时才创建", async () => {
	const unmanaged = manager("stale", false);
	await assert.rejects(open(url, "x2-db", unmanaged.ops), /127\.0\.0\.1:15432.*不受 X2 控制/);
	assert.deepEqual(unmanaged.commands, ["check"]);
	assert.equal(unmanaged.counts().released, 1);
	const absent = manager("absent", false);
	(await open(url, "x2-db", absent.ops)).destroy();
	assert.deepEqual(absent.commands, ["check", "start"]);
});

test("并发恢复在锁内重探测，后到者使用已恢复的转发，不再次退出重启", async () => {
	const f = manager("stale", true);
	const sockets = await Promise.all([open(url, "x2-db", f.ops), open(url, "x2-db", f.ops)]);
	assert.deepEqual(f.commands, ["check", "exit", "start"]);
	assert.equal(f.counts().locks, 2);
	assert.equal(f.counts().released, 2);
	for (const socket of sockets) socket.destroy();
});

test("SSH仅使用当前目标的专属控制路径与仓库配置，密码不进入路径或参数", () => {
	assert.equal(tunnelTarget(url.replace("password-not-sent", "other-secret"), "x2-db").controlPath, target.controlPath);
	assert.notEqual(tunnelTarget(url.replace("15432", "15433"), "x2-db").controlPath, target.controlPath);
	assert.notEqual(tunnelTarget(url, "another-alias").controlPath, target.controlPath);
	assert.ok(target.controlPath.length < 100);
	for (const action of ["check", "exit", "start"] as const) {
		const args = tunnelSshArgs(action, target);
		assert.equal(args[args.indexOf("-S") + 1], target.controlPath);
		assert.equal(args.at(-1), "x2-db");
		assert.equal(args.join(" ").includes("password-not-sent"), false);
		assert.equal(args.join(" ").includes("en0"), false);
	}
	assert.ok(tunnelSshArgs("start", target).includes("ControlMaster=yes"));
});
