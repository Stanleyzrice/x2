// 跨进程的锁：几个 x2 进程同时跑时，同一个浏览器的同一个站点一次只让一个进程用（browser.ts 用它排队）。
// 锁是 ~/x2/locks/ 下的一个文件（X2_HOME 可以改目录）：独占创建（wx）成功的进程拿到锁，文件里写着是谁（pid、哪台电脑、什么命令）。
// 进程正常退出、被 Ctrl-C、被 kill（TERM、HUP）时删掉自己的锁；被 kill -9 的，pid 不在了，别的进程直接清掉。
// 拿着锁的进程每 10 秒摸一下文件（mtime）；超过 1 分钟没摸的算过期（进程卡死了、pid 被别的进程用了），也清掉。
// spaced：拿着锁的时候用，两次之间至少隔多久（例 页面加载），上一次的时间是 locks/ 下另一个文件的 mtime，几个进程共用
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export type Owner = { pid: number; host: string; cmd: string; at: string; token: string };
export type Lock = { release(): void };

const HEARTBEAT_MS = 10_000;
export const EXPIRE_MS = 60_000;
const FRESH_MS = 5_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const lockDir = () => join(process.env.X2_HOME ?? join(homedir(), "x2"), "locks");

const file = (name: string, ext: string) => join(lockDir(), `${name.replace(/[^\w.-]/g, "_")}.${ext}`);

/** 这个进程还在不在（kill 0 只看不杀；EPERM 是在、只是不归我们管） */
export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function stale(owner: Owner | null, ageMs: number, isAlive: (pid: number) => boolean, host = hostname(), expireMs = EXPIRE_MS): boolean {
	if (ageMs > expireMs) return true;
	if (!owner) return ageMs > FRESH_MS;
	return owner.host === host && !isAlive(owner.pid);
}

function peek(path: string): { owner: Owner | null; ageMs: number } | null {
	try {
		const ageMs = Date.now() - statSync(path).mtimeMs;
		let owner: Owner | null = null;
		try {
			owner = JSON.parse(readFileSync(path, "utf8")) as Owner;
		} catch {}
		return { owner, ageMs };
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
}

function clear(path: string, seen: Owner | null): void {
	try {
		const now = JSON.parse(readFileSync(path, "utf8")) as Owner;
		if (!seen || now.token !== seen.token) return;
	} catch {}
	try {
		unlinkSync(path);
	} catch {}
}

const held = new Map<string, { token: string; beat: NodeJS.Timeout }>();

function release(path: string): void {
	const h = held.get(path);
	if (!h) return;
	clearInterval(h.beat);
	held.delete(path);
	try {
		if ((JSON.parse(readFileSync(path, "utf8")) as Owner).token === h.token) unlinkSync(path);
	} catch {}
}

let hooked = false;
function hookExit(): void {
	if (hooked) return;
	hooked = true;
	const all = () => {
		for (const path of [...held.keys()]) release(path);
	};
	process.on("exit", all);
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.once(signal, () => {
			all();
			// 照原来的样子退出（没有别的监听时就是被这个信号杀掉）
			process.kill(process.pid, signal);
		});
	}
}

const cmdline = () => `x2 ${process.argv.slice(2).join(" ")}`.slice(0, 120);

export async function acquire(name: string, opts: { onWait?: (owner: Owner) => void; timeoutMs?: number } = {}): Promise<Lock> {
	mkdirSync(lockDir(), { recursive: true });
	const path = file(name, "lock");
	const me: Owner = { pid: process.pid, host: hostname(), cmd: cmdline(), at: new Date().toISOString(), token: randomUUID() };
	const timeoutMs = opts.timeoutMs ?? 5 * 60_000;
	const until = Date.now() + timeoutMs;
	let told = false;
	for (;;) {
		try {
			const fd = openSync(path, "wx");
			try {
				writeSync(fd, JSON.stringify(me));
			} finally {
				closeSync(fd);
			}
			hookExit();
			const beat = setInterval(() => {
				try {
					utimesSync(path, new Date(), new Date());
				} catch {}
			}, HEARTBEAT_MS);
			beat.unref();
			held.set(path, { token: me.token, beat });
			return { release: () => release(path) };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
		const now = peek(path);
		if (!now) continue;
		if (stale(now.owner, now.ageMs, alive)) {
			clear(path, now.owner);
			continue;
		}
		if (Date.now() > until) {
			const waited = timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)} 分钟` : `${Math.round(timeoutMs / 1000)} 秒`;
			throw new Error(`等了 ${waited}还没轮到：${now.owner ? `x2 进程 ${now.owner.pid}（${now.owner.cmd}）一直在用` : "锁文件一直在"}（${path}）`);
		}
		if (!told && now.owner) {
			opts.onWait?.(now.owner);
			told = true;
		}
		await sleep(200);
	}
}

export async function spaced(name: string, gapMs: number): Promise<void> {
	mkdirSync(lockDir(), { recursive: true });
	const path = file(name, "last");
	let last = 0;
	try {
		last = statSync(path).mtimeMs;
	} catch {}
	const wait = last + gapMs - Date.now();
	if (wait > 0) await sleep(wait);
	const now = new Date();
	try {
		utimesSync(path, now, now);
	} catch {
		writeFileSync(path, "");
	}
}
