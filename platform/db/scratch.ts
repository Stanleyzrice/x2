// 临时库（x2 web --scratch）：把 X2_DATABASE_URL 的库整个复制一份（pg_dump | psql），验证改了的网页时在拷贝上开，怎么点都不碰真库。
// 名字是 <库名>_scratch_<电脑>_<进程号>：几个进程各用各的；开新的时先删掉这台电脑上进程已经不在了的（kill -9 没来得及删的）。库是共用的，别的电脑的看不出进程在不在，不碰。只删照这个名字建的库
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
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

function exited(p: ReturnType<typeof spawn>, what: string): Promise<void> {
	let err = "";
	p.stderr?.on("data", (d: Buffer) => {
		err += d;
	});
	return new Promise((ok, fail) => {
		p.on("error", (e: NodeJS.ErrnoException) => fail(new Error(e.code === "ENOENT" ? `没有 ${what}：装 Postgres 的命令行工具` : e.message)));
		p.on("close", (code) => (code === 0 ? ok() : fail(new Error(`${what} 失败（${code}）：${err.trim().split("\n").slice(-3).join(" ")}`))));
	});
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
		const names = (await admin`select datname from pg_database`).map((r) => String(r.datname));
		for (const n of orphans(names, base, machine, alive)) await drop(n);
		await drop(name);
		await admin.unsafe(`create database "${name.replaceAll('"', '""')}"`);
		const dump = spawn("pg_dump", ["--no-owner", "--no-acl", "-d", source], { stdio: ["ignore", "pipe", "pipe"] });
		const load = spawn("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", url], { stdio: ["pipe", "ignore", "pipe"] });
		dump.stdout.pipe(load.stdin);
		await Promise.all([exited(dump, "pg_dump"), exited(load, "psql")]);
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
