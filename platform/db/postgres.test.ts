// 真实驱动配内存协议流复现保留连接断线后的延迟写入，验证持久依赖补丁，不访问网络或数据库。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

for (const mode of ["esm", "cjs"] as const) {
	test(`postgres ${mode} 断线后的缓冲写入拒绝所有待处理查询，进程继续退出`, () => {
		const fixture = `
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const postgres = ${mode === "esm" ? "(await import('postgres')).default" : "createRequire(import.meta.url)('postgres')"};
const ready = Buffer.from([90, 0, 0, 0, 5, 73]);
class FakeSocket extends Duplex {
  host = 'fixture'; port = 1;
  _read() {}
  _write(_chunk, _encoding, done) {
    done();
    queueMicrotask(() => { if (!this.destroyed) this.push(ready); });
  }
  setKeepAlive() {}
}
const socket = new FakeSocket();
const sql = postgres('postgres://fixture:fixture@127.0.0.1:1/fixture', {
  max: 1, fetch_types: false, prepare: false, socket: async () => socket
});
await sql.unsafe('select 1', [], { simple: true });
const reserved = await sql.reserve();
const closed = once(socket, 'close');
socket.destroy();
await closed;
const codes = await Promise.all([1, 2].map(() =>
  reserved.unsafe('select 1', [], { simple: true }).then(() => 'unexpected success', e => e.code)
));
await sql.end({ timeout: 0 });
console.log(JSON.stringify({ codes, survived: true }));
`;
		const result = spawnSync(process.execPath, ["--input-type=module", "-e", fixture], {
			cwd: new URL("../../", import.meta.url),
			encoding: "utf8",
			timeout: 3000,
		});
		assert.equal(result.status, 0, `${result.error?.message ?? ""}\n${result.stderr}`);
		assert.deepEqual(JSON.parse(result.stdout), { codes: ["CONNECTION_CLOSED", "CONNECTION_CLOSED"], survived: true });
	});
}
