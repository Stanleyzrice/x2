// 本机 Codex CLI：只传分析输入、收 JSON；不保存业务数据或解释业务规则。
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const DEFAULT_BINARY = "/opt/homebrew/bin/codex";
// 这是本连接器的显式执行配置；状态检查不调用模型，不能用它证明服务端已接受请求。
export const CODEX_MODEL = "gpt-6.1-sol";
export const CODEX_REASONING_EFFORT = "medium";
const MAX_OUTPUT = 8 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 30_000;
export type CodexProgress = { type: string; message: string; elapsedMs?: number; timeoutMs?: number };
export class CodexTimeoutError extends Error {
	readonly code = "CODEX_TIMEOUT";
	readonly timeoutMs: number;
	readonly elapsedMs: number;
	constructor(timeoutMs: number, elapsedMs: number) {
		super(`Codex 分析超时：单次上限${Math.ceil(timeoutMs / 1000)}秒，已等待${Math.ceil(elapsedMs / 1000)}秒`);
		this.name = "CodexTimeoutError";
		this.timeoutMs = timeoutMs;
		this.elapsedMs = elapsedMs;
	}
}
export type CodexRequest = {
	prompt: string;
	schema: Record<string, unknown>;
	cwd: string;
	images?: readonly Uint8Array[];
	signal?: AbortSignal;
	timeoutMs?: number;
	onEvent?: (event: CodexProgress) => void;
	executable?: string;
};
export type CodexAvailability = {
	available: boolean;
	version: string | null;
	error: string | null;
	model: string;
	reasoningEffort: string;
};

/** 不把 CLI 原始 stderr 或模型工具参数写进业务日志。 */
export function safeCodexError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/abort|cancel|取消/i.test(message)) return "Codex 分析已取消";
	if (/timed? ?out|超时/i.test(message)) return "Codex 分析超时";
	if (/ENOENT|not found/i.test(message)) return "未找到本机 Codex CLI";
	return message
		.replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
		.replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[已隐藏]")
		.replace(/https?:\/\/[^\s]+/gi, "[地址已隐藏]")
		.slice(0, 300);
}

/** 固定无 shell 参数；模型只判读传入事实，外站操作由调用方的白名单工具执行。 */
export function codexArgs(cwd: string, schemaPath: string, outputPath: string, images: readonly string[] = []): string[] {
	return [
		"exec",
		"--ignore-user-config",
		"--model",
		CODEX_MODEL,
		"-c",
		`model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
		"--ephemeral",
		"--sandbox",
		"read-only",
		"--json",
		"--color",
		"never",
		"--disable",
		"shell_tool",
		"--disable",
		"unified_exec",
		"--disable",
		"apps",
		"--disable",
		"plugins",
		"--disable",
		"hooks",
		"--disable",
		"browser_use",
		"--disable",
		"computer_use",
		"--disable",
		"code_mode_host",
		"--disable",
		"multi_agent",
		"--disable",
		"skill_search",
		"-c",
		'web_search="disabled"',
		"-c",
		"mcp_servers={}",
		...images.flatMap((path) => ["--image", path]),
		"--output-schema",
		schemaPath,
		"--output-last-message",
		outputPath,
		"-C",
		cwd,
		"-",
	];
}

const eventShape = z.looseObject({ type: z.string(), item: z.looseObject({ type: z.string().optional() }).optional() });
export function progressOf(line: string): CodexProgress | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	const result = eventShape.safeParse(raw);
	if (!result.success) return null;
	const event = result.data;
	// 不转发模型文本、命令参数、会话编号或账号上下文。
	if (event.type === "thread.started") return { type: event.type, message: "智能体会话已开始" };
	if (event.type === "turn.started") return { type: event.type, message: "智能体正在分析" };
	if (event.type === "turn.completed") return { type: event.type, message: "智能体分析已返回，正在校验结构" };
	if (event.type === "item.completed" && event.item?.type === "agent_message") return { type: event.type, message: "智能体已生成结构化结论" };
	return null;
}

type ProcessResult = { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null };
export async function runCodexProcess(input: {
	executable: string;
	args: string[];
	cwd: string;
	prompt?: string;
	signal?: AbortSignal;
	timeoutMs: number;
	onEvent?: (event: CodexProgress) => void;
	progressIntervalMs?: number;
}): Promise<ProcessResult> {
	if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw new Error("Codex 单次分析上限须为正数毫秒");
	if (input.progressIntervalMs !== undefined && (!Number.isFinite(input.progressIntervalMs) || input.progressIntervalMs <= 0))
		throw new Error("Codex 进度间隔须为正数毫秒");
	input.signal?.throwIfAborted();
	return new Promise((resolve, reject) => {
		const startedAt = performance.now();
		const elapsedMs = () => Math.max(0, Math.round(performance.now() - startedAt));
		const child = spawn(input.executable, input.args, {
			cwd: input.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let stdout = "",
			stderr = "",
			pending = "";
		let stopped: "cancelled" | "timeout" | "output-limit" | null = null;
		let settled = false;
		let forceTimer: ReturnType<typeof setTimeout> | undefined;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		const emit = (event: CodexProgress) => {
			if (!stopped && !settled) input.onEvent?.(event);
		};
		const kill = (signal: NodeJS.Signals) => {
			try {
				if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
				else child.kill(signal);
			} catch {
				/* 进程可能刚好已退出，close 才是最终结果。 */
			}
		};
		const stop = (reason: typeof stopped) => {
			if (stopped) return;
			stopped = reason;
			if (heartbeat) clearInterval(heartbeat);
			kill("SIGTERM");
			forceTimer = setTimeout(() => kill("SIGKILL"), 1500);
			forceTimer.unref();
		};
		const abort = () => stop("cancelled");
		input.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(() => stop("timeout"), input.timeoutMs);
		const cleanup = () => {
			clearTimeout(timer);
			if (heartbeat) clearInterval(heartbeat);
			if (forceTimer) clearTimeout(forceTimer);
			input.signal?.removeEventListener("abort", abort);
		};
		if (input.onEvent)
			heartbeat = setInterval(() => {
				const elapsed = elapsedMs();
				emit({
					type: "analysis.waiting",
					message: `智能体仍在分析，已等待${Math.ceil(elapsed / 1000)}秒（单次上限${Math.ceil(input.timeoutMs / 1000)}秒）`,
					elapsedMs: elapsed,
					timeoutMs: input.timeoutMs,
				});
			}, input.progressIntervalMs ?? PROGRESS_INTERVAL_MS);
		heartbeat?.unref();
		// 主进程已退出时仍可能留下继承进程组但未继承管道的子进程；确认整组停止后才能允许调用方重试。
		const finishStopping = async () => {
			if (process.platform === "win32" || !child.pid) return true;
			const exists = () => {
				try {
					process.kill(-child.pid!, 0);
					return true;
				} catch (error) {
					return (error as NodeJS.ErrnoException).code !== "ESRCH";
				}
			};
			if (!exists()) return true;
			kill("SIGKILL");
			const until = performance.now() + 1000;
			while (exists() && performance.now() < until) await new Promise<void>((done) => setTimeout(done, 20));
			return !exists();
		};
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (stopped) return;
			stdout += chunk;
			pending += chunk;
			if (stdout.length + stderr.length > MAX_OUTPUT) {
				stop("output-limit");
				return;
			}
			let at = pending.indexOf("\n");
			while (at >= 0) {
				const line = pending.slice(0, at);
				pending = pending.slice(at + 1);
				const event = progressOf(line);
				if (event) emit(event);
				at = pending.indexOf("\n");
			}
		});
		child.stderr.on("data", (chunk: string) => {
			if (stopped) return;
			stderr += chunk;
			if (stdout.length + stderr.length > MAX_OUTPUT) stop("output-limit");
		});
		child.stdin.on("error", () => {
			/* EPIPE 随后由 error/close 汇报。 */
		});
		child.once("error", (error) => {
			settled = true;
			cleanup();
			reject(new Error(safeCodexError(error)));
		});
		child.once("close", async (code, signal) => {
			settled = true;
			if (stopped && !(await finishStopping())) {
				cleanup();
				reject(Object.assign(new Error("Codex 分析进程未能确认停止，不能自动重试"), { code: "CODEX_PROCESS_STOP_FAILED" }));
				return;
			}
			cleanup();
			if (stopped === "cancelled" || input.signal?.aborted) {
				reject(new Error("Codex 分析已取消"));
				return;
			}
			if (stopped === "timeout") {
				reject(new CodexTimeoutError(input.timeoutMs, elapsedMs()));
				return;
			}
			if (stopped === "output-limit") {
				reject(new Error("Codex 输出超过允许大小"));
				return;
			}
			resolve({ stdout, stderr, code, signal });
		});
		if (input.signal?.aborted) abort();
		child.stdin.end(input.prompt ?? "");
	});
}

export async function codexStatus(executable = DEFAULT_BINARY): Promise<CodexAvailability> {
	const configuration = { model: CODEX_MODEL, reasoningEffort: CODEX_REASONING_EFFORT };
	try {
		const version = await runCodexProcess({ executable, args: ["--version"], cwd: process.cwd(), timeoutMs: 5000 });
		if (version.code !== 0) return { ...configuration, available: false, version: null, error: "Codex CLI 版本检查失败" };
		const help = await runCodexProcess({ executable, args: ["exec", "--help"], cwd: process.cwd(), timeoutMs: 5000 });
		const required = ["--ignore-user-config", "--model", "--config", "--ephemeral", "--sandbox", "--json", "--output-schema", "--output-last-message"];
		const missing = required.filter((flag) => !help.stdout.includes(flag));
		return missing.length || help.code !== 0
			? { ...configuration, available: false, version: version.stdout.trim().slice(0, 100), error: "本机 Codex CLI 缺少结构化执行能力，请更新后再试" }
			: { ...configuration, available: true, version: version.stdout.trim().slice(0, 100), error: null };
	} catch (error) {
		return { ...configuration, available: false, version: null, error: safeCodexError(error) };
	}
}

export async function askCodex(request: CodexRequest): Promise<unknown> {
	if (!request.prompt.trim()) throw new Error("Codex 输入为空");
	request.signal?.throwIfAborted();
	const dir = await mkdtemp(join(tmpdir(), "x2-codex-"));
	try {
		const schemaPath = join(dir, "schema.json"),
			outputPath = join(dir, "result.json");
		await writeFile(schemaPath, JSON.stringify(request.schema), { mode: 0o600 });
		const images = await Promise.all(
			(request.images ?? []).map(async (bytes, index) => {
				const extension = bytes[0] === 0xff && bytes[1] === 0xd8 ? "jpg" : bytes[0] === 0x89 && bytes[1] === 0x50 ? "png" : "webp";
				const path = join(dir, `image-${index + 1}.${extension}`);
				await writeFile(path, bytes, { mode: 0o600 });
				return path;
			}),
		);
		const result = await runCodexProcess({
			executable: request.executable ?? DEFAULT_BINARY,
			args: codexArgs(request.cwd, schemaPath, outputPath, images),
			cwd: request.cwd,
			prompt: request.prompt,
			signal: request.signal,
			timeoutMs: request.timeoutMs ?? 240_000,
			onEvent: request.onEvent,
		});
		request.signal?.throwIfAborted();
		if (result.code !== 0 || result.signal) throw new Error(`Codex 分析未成功退出（${result.signal ?? result.code ?? "未知"}），请检查CLI登录或网络`);
		const message = await readFile(outputPath, "utf8").catch(() => {
			throw new Error("Codex 未生成最终结构化结果");
		});
		try {
			return JSON.parse(message) as unknown;
		} catch {
			throw new Error("Codex 最终结果不是有效JSON");
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
