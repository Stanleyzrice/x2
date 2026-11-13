// 独立 PostgreSQL 启动探针确认转发可达；锁内只经 X2 专属控制路径重建自有 SSH 隧道，不接管其他监听者。
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect, Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquire, type Lock, lockDir } from "../browser/lock.ts";
import { NeedsHuman } from "../errors.ts";

const CONFIG = fileURLToPath(new URL("../../ops/ssh_config", import.meta.url));
const CONNECT_MS = 2000,
	PROBE_MS = 2000,
	CONTROL_MS = 3000,
	START_MS = 25_000,
	LOCK_MS = 45_000;
type AddressedSocket = Socket & { host?: string; port?: number };
const endpoint = (host: string, port: number) => `${host}:${port}`;
const failure = (message: string, code: string) => Object.assign(new NeedsHuman(message), { code });

/** postgres 的 socket 工厂直接抛错会耗尽连接池；转为连接的 error/close 事件，保留原错误并让池释放后重试。 */
export async function postgresSocket(openSocket: () => Promise<Socket>): Promise<Socket> {
	try {
		const socket = await openSocket();
		if (socket.destroyed || socket.closed || socket.pending || !socket.writable || socket.readableEnded) {
			const address = socket as AddressedSocket;
			socket.destroy();
			throw failure(
				`数据库连接已关闭或不可写（${address.host ?? socket.remoteAddress ?? "未知主机"}:${address.port ?? socket.remotePort ?? "未知端口"}）`,
				"CONNECTION_CLOSED",
			);
		}
		return socket;
	} catch (error) {
		const failed = new Socket();
		// 驱动会先写启动包；缓冲写入，等它装好监听再发出原错误，避免未连接写入的错误抢先覆盖。
		failed.cork();
		setImmediate(() => failed.destroy(error instanceof Error ? error : new Error(String(error))));
		return failed;
	}
}

/** postgres.js 的连接计时器在自定义 socket 工厂返回后才启动，所以 TCP 等待也单独限时。 */
export function reach(host: string, port: number, timeoutMs = CONNECT_MS, create: () => Socket = () => connect({ host, port })): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = create();
		const cleanup = () => {
			clearTimeout(timer);
			socket.off("connect", connected).off("error", errored).off("close", closed);
		};
		const fail = (code: string) => {
			cleanup();
			socket.destroy();
			reject(failure(`连接数据库隧道 ${endpoint(host, port)} 失败（${code}）`, code));
		};
		const connected = () => {
			if (socket.destroyed || !socket.writable) return fail("CONNECTION_CLOSED");
			cleanup();
			resolve(Object.assign(socket, { host, port }));
		};
		const errored = (error: NodeJS.ErrnoException) => fail(error.code ?? "CONNECT_FAILED");
		const closed = () => fail("CONNECTION_CLOSED");
		const timer = setTimeout(() => fail("CONNECT_TIMEOUT"), timeoutMs);
		socket.once("connect", connected).once("error", errored).once("close", closed);
		if (socket.destroyed || socket.closed) fail("CONNECTION_CLOSED");
		else if (!socket.pending && !socket.connecting) connected();
	});
}

export type TunnelTarget = { host: string; port: number; user: string; database: string; alias: string; key: string; controlPath: string };
export type ProbeStatus = "healthy" | "absent" | "stale";
type SshAction = "check" | "exit" | "start";
type TunnelOps = {
	probe(target: TunnelTarget): Promise<ProbeStatus>;
	connect(host: string, port: number): Promise<Socket>;
	ssh(action: SshAction, target: TunnelTarget): Promise<boolean>;
	lock(name: string, options: { timeoutMs: number }): Promise<Lock>;
};

export function tunnelTarget(url: string, alias: string): TunnelTarget {
	const u = new URL(url),
		host = u.hostname.replace(/^\[|\]$/g, ""),
		port = Number(u.port || 5432);
	const user = decodeURIComponent(u.username),
		database = decodeURIComponent(u.pathname.slice(1));
	if (!user || !database || user.includes("\0") || database.includes("\0"))
		throw failure(`数据库隧道 ${endpoint(host, port)} 缺少有效的 URL 用户名或数据库名`, "INVALID_DATABASE_URL");
	const key = createHash("sha256")
		.update(JSON.stringify([CONFIG, lockDir(), alias, host, port]))
		.digest("hex")
		.slice(0, 20);
	// macOS 系统临时目录太长，Unix 控制套接字使用短的、仅当前用户可访问的专属目录。
	const controlPath = join("/tmp", `x2-db-${process.getuid?.() ?? "user"}`, `${key}.sock`);
	return { host, port, user, database, alias, key, controlPath };
}

/** 仅包含 URL 的用户名、库名；不含密码、不执行 SQL，也不继续认证。 */
export function postgresStartup(target: Pick<TunnelTarget, "user" | "database">): Buffer {
	const params = Buffer.from(`user\0${target.user}\0database\0${target.database}\0\0`);
	const packet = Buffer.alloc(8 + params.length);
	packet.writeInt32BE(packet.length, 0);
	packet.writeInt32BE(196608, 4);
	params.copy(packet, 8);
	return packet;
}

/** 只认完整、合法的认证请求或错误响应；认证被拒也能证明远端 PostgreSQL 在回应。 */
export function postgresReply(bytes: Buffer): boolean | null {
	if (bytes.length < 5) return null;
	const length = bytes.readUInt32BE(1);
	if (length < 4 || length > 1024 * 1024) return false;
	if (bytes.length < length + 1) return null;
	if (bytes[0] === 82) return length >= 8 && [0, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12].includes(bytes.readUInt32BE(5));
	if (bytes[0] !== 69 || bytes[length] !== 0) return false;
	const fields = bytes
		.subarray(5, length + 1)
		.toString("utf8")
		.split("\0");
	return fields.some((field) => /^C[A-Z\d]{5}$/.test(field)) && fields.some((field) => /^M.+/.test(field)) && fields.some((field) => /^S.+/.test(field));
}

export async function probePostgres(target: TunnelTarget, dial: TunnelOps["connect"] = reach, timeoutMs = PROBE_MS): Promise<ProbeStatus> {
	let socket: Socket;
	try {
		socket = await dial(target.host, target.port);
	} catch {
		return "absent";
	}
	return new Promise((resolve) => {
		let bytes = Buffer.alloc(0),
			settled = false;
		const finish = (status: ProbeStatus) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.off("data", data).off("error", failed).off("close", failed);
			socket.destroy();
			resolve(status);
		};
		const data = (chunk: Buffer) => {
			bytes = Buffer.concat([bytes, chunk]);
			const valid = postgresReply(bytes);
			if (valid !== null) finish(valid ? "healthy" : "stale");
		};
		const failed = () => finish("stale");
		const timer = setTimeout(failed, timeoutMs);
		socket.on("data", data).once("error", failed).once("close", failed);
		try {
			socket.write(postgresStartup(target));
		} catch {
			failed();
		}
	});
}

export function tunnelSshArgs(action: SshAction, target: TunnelTarget): string[] {
	const base = ["-F", CONFIG, "-S", target.controlPath, "-o", "BatchMode=yes"];
	return action === "start"
		? [
				...base,
				"-fN",
				"-o",
				"ControlMaster=yes",
				"-o",
				"ControlPersist=no",
				"-o",
				"ExitOnForwardFailure=yes",
				"-o",
				"ConnectTimeout=10",
				"-o",
				"ConnectionAttempts=1",
				target.alias,
			]
		: [...base, "-O", action, target.alias];
}

async function ssh(action: SshAction, target: TunnelTarget): Promise<boolean> {
	if (action === "start") {
		const directory = dirname(target.controlPath);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
			throw failure(`数据库隧道 ${endpoint(target.host, target.port)} 的控制目录不属于当前用户或权限不安全`, "INVALID_CONTROL_PATH");
		try {
			unlinkSync(target.controlPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	try {
		const child = spawn("ssh", tunnelSshArgs(action, target), { stdio: "ignore", timeout: action === "start" ? START_MS : CONTROL_MS, killSignal: "SIGKILL" });
		const [code] = await once(child, "exit");
		return code === 0;
	} catch {
		return false;
	}
}

async function waitClosed(target: TunnelTarget, dial: TunnelOps["connect"]): Promise<void> {
	const until = Date.now() + CONNECT_MS;
	do {
		try {
			(await dial(target.host, target.port)).destroy();
		} catch {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() < until);
	throw failure(`X2 托管数据库隧道 ${endpoint(target.host, target.port)} 关闭后端口仍被占用，未重建`, "TUNNEL_STILL_LISTENING");
}

/** 锁内重探测：健康转发直接使用；失活转发只关闭本项目、目标专属 ControlPath 对应的自有 SSH。 */
export async function open(url: string, alias: string, overrides: Partial<TunnelOps> = {}): Promise<Socket> {
	const target = tunnelTarget(url, alias);
	const ops: TunnelOps = { probe: probePostgres, connect: reach, ssh, lock: acquire, ...overrides };
	if ((await ops.probe(target)) === "healthy") return ops.connect(target.host, target.port);
	const lock = await ops.lock(`db-tunnel-${target.key}`, { timeoutMs: LOCK_MS });
	try {
		const status = await ops.probe(target);
		if (status === "healthy") return await ops.connect(target.host, target.port);
		const managed = await ops.ssh("check", target);
		if (status === "stale" && !managed)
			throw failure(
				`数据库隧道 ${endpoint(target.host, target.port)} 本地仍监听但远端无有效响应；该转发不受 X2 控制，未停止任何进程，请确认原隧道后处理`,
				"UNMANAGED_TUNNEL_STALE",
			);
		if (managed) {
			if (!(await ops.ssh("exit", target))) throw failure(`无法关闭 X2 托管数据库隧道 ${endpoint(target.host, target.port)}，未重建`, "TUNNEL_STOP_FAILED");
			await waitClosed(target, ops.connect);
		}
		if (!(await ops.ssh("start", target)))
			throw failure(`开不了 X2 托管数据库隧道 ${endpoint(target.host, target.port)}（${alias}）：检查 SSH 钥匙与仓库 ops/ssh_config`, "TUNNEL_START_FAILED");
		if ((await ops.probe(target)) !== "healthy")
			throw failure(`X2 托管数据库隧道 ${endpoint(target.host, target.port)} 启动后仍无有效 PostgreSQL 响应`, "TUNNEL_PROBE_FAILED");
		return await ops.connect(target.host, target.port);
	} finally {
		lock.release();
	}
}
