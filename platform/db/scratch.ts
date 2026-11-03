// 临时库（x2 web --scratch）：把 X2_DATABASE_URL 的库整个复制一份（pg_dump | psql），验证改了的网页时在拷贝上开，怎么点都不碰真库。
// 名字是 <库名>_scratch_<电脑>_<进程号>：几个进程各用各的；开新的时先删掉这台电脑上进程已经不在了的（kill -9 没来得及删的）。库是共用的，别的电脑的看不出进程在不在，不碰。只删照这个名字建的库
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { client } from "./index.ts";

const TAG = "_scratch_";

/** 临时库的名字和地址（源库换个库名） */
export function scratchOf(source: string, machine: string, pid: number): { name: string; url: string } {
	const u = new URL(source);
	const base = decodeURIComponent(u.pathname.slice(1));
	if (!base) throw new Error(`X2_DATABASE_URL 里没有库名：${source}`);
	const name = `${base}${TAG}${machine}_${pid}`;
	u.pathname = `/${encodeURIComponent(name)}`;
	return { name, url: u.toString() };
}

/** 这些库里哪些是这个源库的、这台电脑上进程已经不在了的临时库 */
export function orphans(names: string[], base: string, machine: string, alive: (pid: number) => boolean): string[] {
	const prefix = `${base}${TAG}${machine}_`;
	return names.filter((n) => {
		const m = n.startsWith(prefix) ? /^\d+$/.exec(n.slice(prefix.length)) : null;
		return m !== null && !alive(Number(m[0]));
	});
}

/** 库名里的电脑：机器名的短哈希（机器名可能有库名放不下的字） */
const machine = createHash("sha1").update(hostname()).digest("hex").slice(0, 8);

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

type ProcessFailure = Error & { diagnostic: boolean };
function exited(p: ChildProcess, what: string): Promise<void> {
	let err = "";
	p.stderr?.on("data", (d: Buffer) => {
		err += d;
	});
	return new Promise((ok, fail) => {
		let error: ProcessFailure | undefined;
		p.on("error", (e: NodeJS.ErrnoException) => {
			error ??= Object.assign(new Error(e.code === "ENOENT" ? `没有 ${what}：装 Postgres 的命令行工具` : `${what}：${e.message}`), { diagnostic: true });
		});
		p.once("close", (code, signal) => {
			if (error) fail(error);
			else if (code === 0) ok();
			else
				fail(Object.assign(new Error(`${what} 失败（${code ?? signal}）：${err.trim().split("\n").slice(-3).join(" ")}`), { diagnostic: Boolean(err.trim()) }));
		});
	});
}

/** 新版 pg_dump 的会话参数可能不被旧 server 支持；仅过滤对象或数据之前的 header，正文始终按原字节通过。 */
function compatibleHeader(): Transform {
	let header = true,
		removed = false,
		pending: Buffer = Buffer.alloc(0);
	const line = (bytes: Buffer) => {
		const text = bytes.toString("utf8").replace(/\r?\n$/, "");
		const session =
			text === "" ||
			(text.startsWith("--") && !/^-- (?:Name:|Data for Name:)/.test(text)) ||
			/^\\restrict\s/.test(text) ||
			/^SET [a-z_]+ = [^\r\n]*;$/.test(text) ||
			text === "SELECT pg_catalog.set_config('search_path', '', false);";
		if (!session) header = false;
		if (header && !removed && text === "SET transaction_timeout = 0;") {
			removed = true;
			return;
		}
		stream.push(bytes);
	};
	const stream = new Transform({
		transform(chunk: Buffer, _encoding, done) {
			if (!header) {
				done(null, chunk);
				return;
			}
			pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
			while (header) {
				const end = pending.indexOf(10);
				if (end === -1) break;
				const bytes = pending.subarray(0, end + 1);
				pending = pending.subarray(end + 1);
				line(bytes);
			}
			if (!header && pending.length) {
				stream.push(pending);
				pending = Buffer.alloc(0);
			}
			done();
		},
		flush(done) {
			if (pending.length) line(pending);
			done();
		},
	});
	return stream;
}

/** 复制结束后才能发布临时库，失败时由调用方删除隔离库。 */
export async function copyDump(dump: ChildProcess, load: ChildProcess, serverVersion?: number): Promise<void> {
	const children = [dump, load];
	const closed = [exited(dump, "pg_dump"), exited(load, "psql")];
	const copied =
		dump.stdout && load.stdin
			? serverVersion !== undefined && serverVersion < 170000
				? pipeline(dump.stdout, compatibleHeader(), load.stdin)
				: pipeline(dump.stdout, load.stdin)
			: Promise.reject(new Error("pg_dump / psql 复制管道不可用"));
	try {
		await Promise.all([...closed, copied]);
	} catch (error) {
		const stopped = new Set<number>();
		for (const [i, p] of children.entries()) {
			if (p.exitCode !== null || p.signalCode !== null || p.killed) continue;
			stopped.add(i);
			try {
				p.kill();
			} catch {
				/* 保留原错误，仍等待子进程关闭。 */
			}
		}
		const results = await Promise.allSettled([...closed, copied]);
		// EPIPE 常由 psql 先退出造成；优先保留命令的真实 stderr，不让清理产生的 SIGTERM 掩盖原因。
		const failures = [1, 0].flatMap((i) => {
			const result = results[i]!;
			return result.status === "rejected" ? [{ i, error: result.reason as ProcessFailure }] : [];
		});
		throw (
			failures.find((f) => !stopped.has(f.i) && f.error.diagnostic)?.error ??
			failures.find((f) => f.error.diagnostic)?.error ??
			failures.find((f) => !stopped.has(f.i))?.error ??
			error
		);
	}
}

/** 建一个源库的拷贝，回地址和删它的函数 */
export async function openScratch(source: string): Promise<{ name: string; url: string; drop: () => Promise<void> }> {
	const base = decodeURIComponent(new URL(source).pathname.slice(1));
	const { name, url } = scratchOf(source, machine, process.pid);
	const admin = client(source, 1);
	const drop = async (n: string) => {
		if (n === base || !n.startsWith(base + TAG)) throw new Error(`不删 ${n}：不是临时库`);
		await admin.unsafe(`drop database if exists "${n.replaceAll('"', '""')}" with (force)`);
	};
	try {
		const [server] = await admin<{ version: number }[]>`select current_setting('server_version_num')::int as version`;
		if (!server || !Number.isSafeInteger(server.version) || server.version <= 0) throw new Error("无法确定临时库 server 版本，未复制");
		const names = (await admin`select datname from pg_database`).map((r) => String(r.datname));
		for (const n of orphans(names, base, machine, alive)) await drop(n);
		await drop(name);
		await admin.unsafe(`create database "${name.replaceAll('"', '""')}"`);
		const dump = spawn("pg_dump", ["--no-owner", "--no-acl", "-d", source], { stdio: ["ignore", "pipe", "pipe"] });
		const load = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", url], { stdio: ["pipe", "ignore", "pipe"] });
		await copyDump(dump, load, server.version);
	} catch (e) {
		await drop(name).catch(() => {});
		await admin.end({ timeout: 5 });
		throw e;
	}
	return {
		name,
		url,
		drop: async () => {
			try {
				await drop(name);
			} finally {
				await admin.end({ timeout: 5 });
			}
		},
	};
}
