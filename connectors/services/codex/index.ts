// Codex CLI 连接器只提供执行能力。
import { get, type Toolkit } from "../../../platform/tool.ts";
import { codexStatus } from "./api.ts";

export type { CodexAvailability, CodexProgress, CodexRequest } from "./api.ts";
export { askCodex, CodexTimeoutError, codexStatus } from "./api.ts";

export const codex: Toolkit = {
	name: "codex",
	title: "本机 Codex CLI（结构化分析）",
	kind: "service",
	tools: { status: get("检查本机Codex CLI、配置模型与结构化输出能力，不运行模型任务", undefined, () => codexStatus()) },
};
