import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { NeedsHuman } from "../../../platform/errors.ts";
import { currentHermesOutput } from "../../../platform/hermes-output.ts";
import { flashModel, type HermesModel, hermesModel } from "../../../platform/ui/hermes-schema.ts";

const exec = promisify(execFile);
const mcpName = "x2";
const systemEnv = new Set([
	"HOME",
	"USER",
	"LOGNAME",
	"PATH",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"TMP",
	"TEMP",
	"SYSTEMROOT",
	"WINDIR",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
]);

function hermesExecutable(): string {
	const runtime = process.platform === "win32" ? "Scripts/python.exe" : "bin/python";
	const local = fileURLToPath(new URL(`../../../artifacts/runtime/hermes-agent/.venv/${runtime}`, import.meta.url));
	return process.env.X2_HERMES_PYTHON?.trim() || (existsSync(local) ? local : "python3");
}

export function hermesConfig(model?: string) {
	const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
	if (!apiKey) throw new NeedsHuman("请先在 X2 设置中连接 DeepSeek");
	return {
		apiKey,
		executable: hermesExecutable(),
		model: model || process.env.X2_HERMES_MODEL?.trim() || flashModel,
	};
}

export function deepSeekStatus() {
	const available = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
	const model = hermesModel.safeParse(process.env.X2_HERMES_MODEL?.trim());
	return { available, model: model.success ? model.data : flashModel, error: available ? null : "请先在设置中连接 DeepSeek" };
}

export async function checkHermesConnection(apiKey: string | undefined, model: string, python?: string) {
	const key = apiKey || process.env.DEEPSEEK_API_KEY?.trim();
	if (!key) throw new NeedsHuman("请输入 DeepSeek API Key");
	try {
		await exec(
			python || hermesExecutable(),
			["-c", "from importlib.util import find_spec\nraise SystemExit(not (find_spec('run_agent') and find_spec('mcp')))"],
			{ timeout: 5000 },
		);
	} catch {
		throw new NeedsHuman("本机尚未检测到 Hermes Agent 和 MCP 运行环境");
	}
	const response = await fetch("https://api.deepseek.com/models", {
		headers: { authorization: `Bearer ${key}` },
		redirect: "error",
		signal: AbortSignal.timeout(12_000),
	}).catch(() => {
		throw new NeedsHuman("无法连接 DeepSeek，请检查网络后重试");
	});
	if (!response.ok) throw new NeedsHuman(`DeepSeek 连接测试返回 HTTP ${response.status}，请检查密钥及账户状态`);
	const models = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(await response.json().catch(() => null));
	if (!models.success || !models.data.data.some((entry) => entry.id === model)) throw new NeedsHuman("DeepSeek 未返回所选模型，请选择可用模型");
	return { ok: true, model };
}

export type ConversationTurn = { role: "user" | "assistant"; content: string };
export type HermesPrompt = string | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];

export async function runHermes(
	config: ReturnType<typeof hermesConfig>,
	cwd: string,
	prompt: HermesPrompt,
	connection: { url: string; token: string },
	history: ConversationTurn[] = [],
) {
	const directory = await mkdtemp(join(tmpdir(), "x2-hermes-"));
	try {
		const task = join(directory, "task.json");
		const profile = {
			model: { provider: "deepseek", default: config.model },
			mcp_servers: { [mcpName]: { url: connection.url, headers: { Authorization: `Bearer ${connection.token}` }, trust: "full", skip_preflight: true } },
			tools: { tool_search: { enabled: "off" } },
			memory: { memory_enabled: false, user_profile_enabled: false },
		};
		await writeFile(join(directory, "config.yaml"), JSON.stringify(profile), { mode: 0o600 });
		const receive = currentHermesOutput();
		const instructions = await readFile(new URL("./AGENTS.md", import.meta.url), "utf8");
		await writeFile(task, JSON.stringify({ prompt, history, stream: Boolean(receive), instructions }), { mode: 0o600 });
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemEnv.has(key.toUpperCase())));
		const runner = fileURLToPath(new URL("./run.py", import.meta.url));
		const launched = exec(config.executable, [runner, task, config.model, mcpName], {
			cwd,
			env: {
				...env,
				PATH: [join(homedir(), ".local", "bin"), env.PATH].filter(Boolean).join(delimiter),
				HERMES_HOME: directory,
				XDG_STATE_HOME: join(directory, "state"),
				DEEPSEEK_API_KEY: config.apiKey,
			},
			timeout: 30 * 60_000,
			maxBuffer: (receive ? 4 : 1) * 1024 * 1024,
		});
		const prefix = "x2-delta ";
		if (receive && launched.child.stdout) {
			createInterface({ input: launched.child.stdout }).on("line", (line) => {
				if (!line.startsWith(prefix)) return;
				try {
					const delta: unknown = JSON.parse(line.slice(prefix.length));
					if (typeof delta === "string" || delta === null) receive(delta);
				} catch {
					// Hermes 自身的进程日志也走标准输出。
				}
			});
		}
		const { stdout } = await launched;
		return z.object({ text: z.string().trim().min(1) }).parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "")).text;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as { code?: unknown }).code === 11)
			throw new NeedsHuman("找不到 Hermes Agent 运行环境，请安装或在 .env 填写 X2_HERMES_PYTHON");
		if ((error as { code?: unknown }).code === 12) throw new NeedsHuman("Hermes 未发现本次 X2 工具，请检查 Hermes 的 MCP 依赖");
		throw new NeedsHuman("Hermes 任务未正常结束，请检查 Hermes 版本、DeepSeek 配置与原发布回执");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

const answer = z.object({ choices: z.array(z.object({ finish_reason: z.string().nullish(), message: z.object({ content: z.string().nullish() }) })).min(1) });

export class DeepSeekOutputError extends Error {}

type Image = { bytes: Uint8Array; mime: string };
type JsonPrompt = { model: HermesModel; prompt: string; images?: readonly Image[]; maxTokens?: number; signal: AbortSignal };

async function deepSeekJson(apiKey: string, { model, prompt, images, maxTokens, signal }: JsonPrompt, request: typeof fetch) {
	const content = images?.length
		? [
				{ type: "text", text: prompt },
				...images.map(({ bytes, mime }) => ({ type: "image_url", image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` } })),
			]
		: prompt;
	const result = await request("https://api.deepseek.com/chat/completions", {
		method: "POST",
		redirect: "error",
		signal,
		headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model,
			max_tokens: maxTokens,
			thinking: { type: "disabled" },
			response_format: { type: "json_object" },
			messages: [{ role: "user", content }],
		}),
	}).catch(() => {
		signal.throwIfAborted();
		throw new Error("DeepSeek 连接失败");
	});
	if (!result.ok) {
		const message = `DeepSeek 返回 HTTP ${result.status}`;
		if ([401, 402, 403, 429].includes(result.status)) throw new NeedsHuman(`${message}，请检查密钥、权限或额度`);
		throw new Error(message);
	}
	const raw = await result.json().catch(() => {
		signal.throwIfAborted();
		return null;
	});
	const body = answer.safeParse(raw);
	if (!body.success) throw new Error("DeepSeek 没有返回有效正文");
	const { finish_reason: reason, message } = body.data.choices[0]!;
	if (reason === "content_filter") throw new Error("DeepSeek 拒绝返回本次内容");
	if (reason === "length") throw new DeepSeekOutputError("DeepSeek 的 JSON 输出被截断");
	if (!message.content?.trim()) throw new DeepSeekOutputError("DeepSeek 返回了空的 JSON 正文");
	try {
		return JSON.parse(message.content) as unknown;
	} catch {
		throw new DeepSeekOutputError("DeepSeek 没有返回有效 JSON");
	}
}

export function askDeepSeek(
	{ model, prompt, schema, images, signal, timeoutMs }: Omit<JsonPrompt, "maxTokens"> & { schema: Record<string, unknown>; timeoutMs: number },
	request: typeof fetch = fetch,
) {
	const key = process.env.DEEPSEEK_API_KEY?.trim();
	if (!key) throw new NeedsHuman("请先在设置中连接 DeepSeek");
	return deepSeekJson(
		key,
		{
			model: images?.length ? flashModel : model,
			prompt: `${prompt}\n\n只返回符合以下 JSON Schema 的 JSON 对象。\n${JSON.stringify(schema)}`,
			images,
			maxTokens: 12_288,
			signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
		},
		request,
	);
}

/** 发送真实图片字节做视觉检查，避免依赖 Agent 的工具结果能否携带像素。 */
export function inspectWithDeepSeek(apiKey: string, image: Image | readonly Image[], prompt: string, request: typeof fetch = fetch) {
	return deepSeekJson(apiKey, { model: flashModel, prompt, images: "bytes" in image ? [image] : image, signal: AbortSignal.timeout(90_000) }, request);
}
