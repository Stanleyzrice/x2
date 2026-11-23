import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { NeedsHuman } from "../../../platform/errors.ts";
import { flashModel } from "../../../platform/ui/hermes-schema.ts";

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
		await writeFile(task, JSON.stringify({ prompt, history }), { mode: 0o600 });
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => systemEnv.has(key.toUpperCase())));
		const runner = fileURLToPath(new URL("./run.py", import.meta.url));
		const { stdout } = await exec(config.executable, [runner, task, config.model, mcpName], {
			cwd,
			env: {
				...env,
				PATH: [join(homedir(), ".local", "bin"), env.PATH].filter(Boolean).join(delimiter),
				HERMES_HOME: directory,
				XDG_STATE_HOME: join(directory, "state"),
				DEEPSEEK_API_KEY: config.apiKey,
			},
			timeout: 30 * 60_000,
			maxBuffer: 1024 * 1024,
		});
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

const answer = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().trim().min(1) }) })).min(1) });

/** 发送真实图片字节做视觉检查，避免依赖 Agent 的工具结果能否携带像素。 */
export async function inspectWithDeepSeek(apiKey: string, image: { bytes: Uint8Array; mime: string }, prompt: string, request: typeof fetch = fetch) {
	const result = await request("https://api.deepseek.com/chat/completions", {
		method: "POST",
		redirect: "error",
		signal: AbortSignal.timeout(90_000),
		headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
		body: JSON.stringify({
			model: flashModel,
			thinking: { type: "disabled" },
			response_format: { type: "json_object" },
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: prompt },
						{ type: "image_url", image_url: { url: `data:${image.mime};base64,${Buffer.from(image.bytes).toString("base64")}` } },
					],
				},
			],
		}),
	});
	if (!result.ok) throw new NeedsHuman(`DeepSeek 视觉检查返回 HTTP ${result.status}`);
	const body = answer.safeParse(await result.json());
	if (!body.success) throw new Error("DeepSeek 视觉检查没有返回有效正文");
	try {
		return JSON.parse(body.data.choices[0]!.message.content) as unknown;
	} catch {
		throw new Error("DeepSeek 视觉检查没有返回有效 JSON");
	}
}
