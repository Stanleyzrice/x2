// x2 web：开网页（docs/loop.md「网页」）。先照 web/ 打包界面，再在 --host、--port 上发；关掉用 Ctrl-C
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { serve } from "../../web/server.ts";
import { db } from "../db/index.ts";
import { Usage } from "../errors.ts";

const flag = (args: string[], name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const root = fileURLToPath(new URL("../..", import.meta.url));

export async function webCommand(args: string[], json: boolean): Promise<void> {
	const a = z
		.object({ host: z.string().min(1).default("127.0.0.1"), port: z.coerce.number().int().min(1).max(65535).default(5170) })
		.safeParse({ host: flag(args, "--host"), port: flag(args, "--port") });
	if (!a.success) throw new Usage("x2 web [--host 127.0.0.1] [--port 5170]（--host 0.0.0.0：同一个网络里别的电脑也能开）");
	const { build } = await import("vite");
	await build({ configFile: `${root}web/ui/vite.config.ts`, logLevel: "warn" });
	const { stop } = await serve(await db(), { ...a.data, dist: `${root}web/ui/dist` });
	const url = `http://${a.data.host === "0.0.0.0" ? "localhost" : a.data.host}:${a.data.port}`;
	console.log(json ? JSON.stringify({ url }) : `网页：${url}（Ctrl-C 关掉）`);
	await new Promise<void>((ok) => process.once("SIGINT", ok).once("SIGTERM", ok));
	await stop();
}
