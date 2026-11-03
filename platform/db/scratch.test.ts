// 临时库的名字：源库名 + _scratch_ + 电脑 + 进程号；只认这台电脑上这个名字的、进程不在了的才清掉，源库、别的电脑的、别的库不碰
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { copyDump, orphans, scratchOf } from "./scratch.ts";

test("临时库换掉地址里的库名，别的（用户、主机、参数）不变", () => {
	assert.deepEqual(scratchOf("postgres://localhost/x2", "ab12", 42), { name: "x2_scratch_ab12_42", url: "postgres://localhost/x2_scratch_ab12_42" });
	assert.deepEqual(scratchOf("postgres://u:p@nas:5433/x2?sslmode=disable", "ab12", 7), {
		name: "x2_scratch_ab12_7",
		url: "postgres://u:p@nas:5433/x2_scratch_ab12_7?sslmode=disable",
	});
	assert.throws(() => scratchOf("postgres://localhost/", "ab12", 1));
});

test("要清掉的只有这个源库的、这台电脑上进程不在了的临时库（库是共用的，同事的临时库进程号在这台电脑上看着像不在了）", () => {
	const names = [
		"x2",
		"x2_test",
		"x2_scratch_ab12_1",
		"x2_scratch_ab12_2",
		"x2_scratch_cd34_1",
		"x2_scratch_ab12_x",
		"x2_scratch_ab12_",
		"x3_scratch_ab12_1",
		"postgres",
	];
	assert.deepEqual(
		orphans(names, "x2", "ab12", (pid) => pid === 2),
		["x2_scratch_ab12_1"],
	);
});

function child() {
	const p = Object.assign(new EventEmitter(), {
		stdin: new PassThrough(),
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		killed: false,
		kill: (signal: NodeJS.Signals = "SIGTERM") => {
			p.killed = true;
			setImmediate(() => finish(null, signal));
			return true;
		},
	});
	const finish = (code: number | null, signal: NodeJS.Signals | null = null) => {
		p.exitCode = code;
		p.signalCode = signal;
		p.stdout.destroy();
		p.stdin.destroy();
		p.stderr.end();
		p.emit("close", code, signal);
	};
	return { p, finish, process: p as unknown as ChildProcess };
}
test("psql提前断开产生EPIPE时保留真实stderr，关闭两端后才返回失败", async () => {
	const dump = child(),
		load = child();
	// fixture吞掉旧实现未监听的stream error，断言复制函数本身能结束并清理，不让测试进程崩溃。
	load.p.stdin.on("error", () => {});
	const copied = copyDump(dump.process, load.process).then(
		() => null,
		(error: Error) => error,
	);
	load.p.stderr.write("psql: FATAL: fixture role cannot connect\n");
	load.p.stdin.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
	const result = await Promise.race([copied, new Promise<null>((resolve) => setImmediate(() => setImmediate(() => setImmediate(() => resolve(null)))))]);
	try {
		assert.match(result?.message ?? "复制尚未结束", /psql.*fixture role cannot connect/);
		assert.equal(dump.p.killed, true);
		assert.equal(dump.p.signalCode, "SIGTERM");
		assert.equal(load.p.signalCode, "SIGTERM");
	} finally {
		dump.finish(1);
		load.finish(1);
		await copied;
	}
});
test("pg_dump失败后结束等待输入的psql，保留dump诊断而非SIGTERM错误", async () => {
	const dump = child(),
		load = child();
	const copied = copyDump(dump.process, load.process);
	dump.p.stderr.write("pg_dump: error: fixture source inaccessible\n");
	dump.finish(1);
	try {
		await assert.rejects(copied, /pg_dump.*fixture source inaccessible/);
		assert.equal(load.p.killed, true);
		assert.equal(load.p.signalCode, "SIGTERM");
	} finally {
		load.finish(1);
	}
});
test("命令不存在时说明缺少哪个命令，并关闭另一复制进程", async () => {
	const dump = child(),
		load = child();
	const copied = copyDump(dump.process, load.process);
	load.p.emit("error", Object.assign(new Error("spawn psql ENOENT"), { code: "ENOENT" }));
	load.finish(-2);
	try {
		await assert.rejects(copied, /没有 psql/);
		assert.equal(dump.p.killed, true);
		assert.equal(dump.p.signalCode, "SIGTERM");
	} finally {
		dump.finish(1);
		load.finish(1);
	}
});

async function copiedBytes(input: Buffer, version: number, split = false): Promise<Buffer> {
	const dump = child(),
		load = child();
	const chunks: Buffer[] = [];
	load.p.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
	load.p.stdin.on("finish", () => {
		dump.finish(0);
		load.finish(0);
	});
	const copied = copyDump(dump.process, load.process, version);
	if (split) for (const byte of input) dump.p.stdout.write(Buffer.from([byte]));
	else dump.p.stdout.write(input);
	dump.p.stdout.end();
	await copied;
	return Buffer.concat(chunks);
}
test("旧server仅移除dump header的transaction_timeout，分段UTF-8及正文/COPY/函数相同文本逐字保留", async () => {
	const header = "-- PostgreSQL database dump\n-- 注释：商品🧪\nSET statement_timeout = 0;\nSET transaction_timeout = 0;\nSET client_encoding = 'UTF8';\n";
	const body =
		"-- Name: 商品; Type: TABLE; Schema: public\nCOPY public.商品 FROM stdin;\nSET transaction_timeout = 0;\n商品🧪\n\\.\nCREATE FUNCTION f() RETURNS text AS $$\nSET transaction_timeout = 0;\n$$ LANGUAGE sql;\n";
	const expected = Buffer.from(header.replace("SET transaction_timeout = 0;\n", "") + body);
	for (const split of [false, true]) assert.deepEqual(await copiedBytes(Buffer.from(header + body), 160000, split), expected);
});
test("新server保持完整header；无对象注释时第一条正文SQL同样结束header过滤", async () => {
	const input = Buffer.from("-- PostgreSQL database dump\nSET transaction_timeout = 0;\nCREATE TABLE t (v text);\n");
	for (const version of [170000, 180000]) assert.deepEqual(await copiedBytes(input, version, true), input);
	const body = Buffer.from("-- PostgreSQL database dump\nCREATE FUNCTION f() RETURNS text AS $$\nSET transaction_timeout = 0;\n$$ LANGUAGE sql;\n");
	assert.deepEqual(await copiedBytes(body, 160000, true), body);
});
test("header仅匹配这一条零值SET，CRLF和最后未换行字节正确保留", async () => {
	const input = Buffer.from(
		"-- PostgreSQL database dump\r\nSET transaction_timeout = 0;\r\nSET transaction_timeout = 9;\r\nSELECT '正文🧪';\r\nSET transaction_timeout = 0;",
	);
	const expected = Buffer.from("-- PostgreSQL database dump\r\nSET transaction_timeout = 9;\r\nSELECT '正文🧪';\r\nSET transaction_timeout = 0;");
	assert.deepEqual(await copiedBytes(input, 160000, true), expected);
});
