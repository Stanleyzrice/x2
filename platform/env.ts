// 本机的 .env（仓库根目录）：外部服务的 key（Gemini、象寄）、库的地址这类只在本机的设置。
// 命令行启动时最先读一次（x2.ts 第一个 import），环境里已经有的不覆盖。.env 不进 git、不进库
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const file = new URL("../.env", import.meta.url);
if (existsSync(file)) for (const [k, v] of Object.entries(parseEnv(readFileSync(file, "utf8")))) process.env[k] ??= v;
