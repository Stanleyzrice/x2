// x2 ask <声明>：渲染、等人提交，把答案 JSON 打印出来（agent 读它）
// x2 show <声明>：渲染、打开，只看
// <声明> 是一个 JSON 文件的路径、views/ 下的名字（x2 show buy），或 -（从标准输入读）。
// 表格写了 from（例 "buy"）的，渲染前现跑 x2 <from> --json，把结果（或它的 key 字段）当行：存下来的视图每次打开都是新的数据。
// 同一个 from 只跑一次
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { NeedsHuman } from "../errors.ts";
import { ask, show } from "../page/serve.ts";
import { Page } from "../page/spec.ts";

const views = new URL("../../views/", import.meta.url).pathname;
const bin = new URL("../../bin/x2.ts", import.meta.url).pathname;

function load(arg: string | undefined): { page: Page; name: string } {
	if (!arg) throw new Error("要一份声明：JSON 文件的路径、views/ 下的名字，或 -（标准输入）");
	const path = arg === "-" ? null : existsSync(arg) ? arg : join(views, `${arg}.json`);
	if (path !== null && !existsSync(path)) throw new Error(`没有这份声明：${arg}`);
	const raw = JSON.parse(path === null ? readFileSync(0, "utf8") : readFileSync(path, "utf8"));
	const parsed = Page.safeParse(raw);
	if (!parsed.success) throw new Error(`声明不对，没有渲染：\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}：${i.message}`).join("\n")}`);
	return { page: parsed.data, name: path === null ? "page" : basename(path, ".json") };
}

/** 表格的 from：现跑那个 x2 命令，它的 --json 输出（一个数组，或对象里 key 那个字段）就是行 */
function fill(page: Page): Page {
	const runs = new Map<string, unknown>();
	const run = (from: string) => {
		if (!runs.has(from)) {
			let out: string;
			try {
				out = execFileSync(process.execPath, [bin, ...from.split(/\s+/), "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
			} catch (e) {
				// 出错时 --json 的 stdout 是 { error: { message } }
				let said: { kind?: string; message?: string } | undefined;
				try { said = JSON.parse(String((e as { stdout?: string }).stdout || "null"))?.error; } catch { /* stdout 不是 JSON：用原来的错 */ }
				const message = `x2 ${from} 出错：${said?.message ?? (e as Error).message}`;
				throw said?.kind === "human" ? new NeedsHuman(message) : new Error(message);
			}
			runs.set(from, JSON.parse(out));
		}
		return runs.get(from);
	};
	return {
		...page,
		blocks: page.blocks.map((b) => {
			if (b.type !== "table" || !b.from) return b;
			const out = run(b.from);
			const rows = b.key ? (out as Record<string, unknown>)?.[b.key] : out;
			if (!Array.isArray(rows)) throw new Error(`x2 ${b.from} --json 的输出${b.key ? `的 ${b.key}` : ""}不是一个数组，当不了表格的行`);
			return { ...b, rows: rows as Record<string, unknown>[] };
		}),
	};
}

export async function askCommand(arg: string | undefined): Promise<void> {
	const { page } = load(arg);
	if (!page.submit) throw new Error("ask 的声明要有 submit（提交按钮）；只看的用 x2 show");
	console.log(JSON.stringify(await ask(fill(page))));
}

export async function showCommand(arg: string | undefined): Promise<void> {
	const { page, name } = load(arg);
	console.log(await show(fill(page), name));
}
