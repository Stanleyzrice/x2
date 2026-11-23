// 本机的 .env（仓库根目录）：外部服务的 key（Gemini、象寄）、库的地址这类只在本机的设置。
// 命令行启动时最先读一次（x2.ts 第一个 import），环境里已经有的不覆盖。.env 不进 git、不进库

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const file = new URL("../.env", import.meta.url);
const setup = new URL("../.x2-setup.json", import.meta.url);
const setupKeys = ["X2_DATABASE_URL", "X2_DEFAULT_SHOP", "X2_SETUP_COMPLETE", "DEEPSEEK_API_KEY", "X2_HERMES_MODEL", "X2_HERMES_PYTHON"] as const;
type SetupKey = (typeof setupKeys)[number];
type SetupSettings = Partial<Record<SetupKey, string>>;

function readSetup(): SetupSettings {
	if (!existsSync(setup)) return {};
	const value = JSON.parse(readFileSync(setup, "utf8")) as SetupSettings;
	return Object.fromEntries(setupKeys.flatMap((key) => (typeof value[key] === "string" ? [[key, value[key]]] : [])));
}

for (const [k, v] of Object.entries(readSetup())) process.env[k] ??= v;
if (existsSync(file)) for (const [k, v] of Object.entries(parseEnv(readFileSync(file, "utf8")))) process.env[k] ??= v;

let pending = Promise.resolve();

/** 仅更新首次设置拥有的字段。用原子替换避免同时保存或掉电留下半份密钥。 */
export function saveSetupSettings(settings: SetupSettings, persist: boolean): Promise<void> {
	const task = pending.then(async () => {
		if (persist) {
			const temporary = new URL(`.x2-setup-${randomUUID()}.tmp`, setup);
			try {
				await writeFile(temporary, JSON.stringify({ ...readSetup(), ...settings }, null, 2), { mode: 0o600, flag: "wx" });
				await rename(temporary, setup);
			} finally {
				await rm(temporary, { force: true });
			}
		}
		for (const key of setupKeys) if (settings[key] !== undefined) process.env[key] = settings[key];
	});
	pending = task.catch(() => {});
	return task;
}
