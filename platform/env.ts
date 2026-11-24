import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { parseEnv } from "node:util";

const file = new URL("../.env", import.meta.url);
const setup = new URL("../.x2-setup.json", import.meta.url);
const setupKeys = [
	"X2_DATABASE_URL",
	"X2_DEFAULT_SHOP",
	"X2_SETUP_COMPLETE",
	"DEEPSEEK_API_KEY",
	"X2_HERMES_MODEL",
	"X2_HERMES_PYTHON",
	"XIANGJI_USER_KEY",
	"XIANGJI_IMG_TRANS_KEY",
] as const;
type SetupKey = (typeof setupKeys)[number];
type SetupSettings = Partial<Record<SetupKey, string>>;

function readSetup(): SetupSettings {
	if (!existsSync(setup)) return {};
	const value = JSON.parse(readFileSync(setup, "utf8")) as SetupSettings;
	return Object.fromEntries(setupKeys.flatMap((key) => (typeof value[key] === "string" ? [[key, value[key]]] : [])));
}

const { XIANGJI_USER_KEY, XIANGJI_IMG_TRANS_KEY, ...startup } = readSetup();
if (XIANGJI_USER_KEY && XIANGJI_IMG_TRANS_KEY) Object.assign(process.env, { XIANGJI_USER_KEY, XIANGJI_IMG_TRANS_KEY });
for (const [k, v] of Object.entries(startup)) process.env[k] ??= v;
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
