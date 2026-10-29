// 跨进程的锁：拿、放、等、过期、进程被杀以后别的进程拿得到。锁放在临时目录（X2_HOME），不碰 ~/x2
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { acquire, lockDir, type Owner, spaced, stale } from "../platform/browser/lock.ts";

process.env.X2_HOME = mkdtempSync(join(tmpdir(), "x2-lock-"));
const LOCK = fileURLToPath(new URL("../platform/browser/lock.ts", import.meta.url));
const path = (name: string) => join(lockDir(), `${name}.lock`);
const owner = (o: Partial<Owner>): Owner => ({ pid: process.pid, host: hostname(), cmd: "x2 测试", at: new Date().toISOString(), token: "t", ...o });

/** 写一个别人的锁文件，mtime 是 ageMs 以前 */
function plant(name: string, content: string, ageMs = 0) {
	mkdirSync(lockDir(), { recursive: true });
	writeFileSync(path(name), content);
	const t = new Date(Date.now() - ageMs);
	utimesSync(path(name), t, t);
}

/** 一个已经退出的进程的 pid */
async function deadPid(): Promise<number> {
	const c = spawn(process.execPath, ["-e", ""]);
	await new Promise((r) => c.on("exit", r));
	return c.pid!;
}

/** 起一个子进程拿着锁不放；回子进程（stdout 打出 held 才回） */
async function holder(name: string): Promise<ChildProcess> {
	const c = spawn(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`const { acquire } = await import(${JSON.stringify(LOCK)}); await acquire(${JSON.stringify(name)}); console.log("held"); setInterval(() => {}, 1000);`,
		],
		{ env: process.env, stdio: ["ignore", "pipe", "inherit"] },
	);
	await new Promise<void>((ok, bad) => {
		c.stdout!.on("data", (d) => {
			if (String(d).includes("held")) ok();
		});
		c.on("exit", (code) => bad(new Error(`拿锁的子进程退出了：${code}`)));
	});
	return c;
}

test("锁算不算数：过期（超过 1 分钟没摸）、同一台电脑上进程不在了的不算；读不出是谁的，刚建的还算", () => {
	const yes = () => true,
		no = () => false;
	assert.equal(stale(owner({}), 1000, yes), false);
	assert.equal(stale(owner({}), 61_000, yes), true);
	assert.equal(stale(owner({}), 1000, no), true);
	assert.equal(stale(owner({ host: "别的电脑" }), 1000, no), false);
	assert.equal(stale(null, 1000, yes), false);
	assert.equal(stale(null, 6000, yes), true);
});

test("拿锁写下自己是谁，放了就删掉；同一把锁再拿要等，等到超时报错、说是谁占着", async () => {
	const lock = await acquire("t-basic");
	const o = JSON.parse(readFileSync(path("t-basic"), "utf8")) as Owner;
	assert.equal(o.pid, process.pid);
	let waited: Owner | null = null;
	const t0 = Date.now();
	await assert.rejects(
		acquire("t-basic", {
			timeoutMs: 600,
			onWait: (w) => {
				waited = w;
			},
		}),
		/还没轮到/,
	);
	assert.ok(Date.now() - t0 >= 500);
	assert.equal(waited!.pid, process.pid);
	lock.release();
	assert.equal(existsSync(path("t-basic")), false);
	(await acquire("t-basic")).release();
});

test("不算数的锁清掉再拿：进程不在了的、过期的、写坏了很久的", async () => {
	plant("t-dead", JSON.stringify(owner({ pid: await deadPid(), token: "dead" })));
	(await acquire("t-dead", { timeoutMs: 1000 })).release();
	plant("t-old", JSON.stringify(owner({ token: "old" })), 2 * 60_000);
	(await acquire("t-old", { timeoutMs: 1000 })).release();
	plant("t-bad", "{", 10_000);
	(await acquire("t-bad", { timeoutMs: 1000 })).release();
	// 刚建、还没写进内容的不清
	plant("t-fresh", "");
	await assert.rejects(acquire("t-fresh", { timeoutMs: 500 }), /还没轮到/);
});

test("另一个进程拿着锁：等它；它被 kill（TERM）时自己删锁，被 kill -9 时看 pid 不在了清掉", async () => {
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		const name = `t-cross-${signal}`;
		const c = await holder(name);
		let waited = false;
		const got = acquire(name, {
			timeoutMs: 10_000,
			onWait: () => {
				waited = true;
			},
		});
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(waited, true);
		const t0 = Date.now();
		c.kill(signal);
		const lock = await got;
		assert.ok(Date.now() - t0 < 3000);
		lock.release();
	}
});

test("两次之间至少隔 gapMs（几个进程共用上一次的时间）", async () => {
	await spaced("t-pace", 400);
	const t0 = Date.now();
	await spaced("t-pace", 400);
	assert.ok(Date.now() - t0 >= 350);
	const t1 = Date.now();
	await new Promise((r) => setTimeout(r, 450));
	await spaced("t-pace", 400);
	assert.ok(Date.now() - t1 < 600);
});
