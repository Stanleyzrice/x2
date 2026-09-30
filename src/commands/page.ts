// x2 ask <声明>：渲染、等人提交，把答案 JSON 打印出来（agent 读它）
// x2 show <声明>：渲染、打开，只看
// <声明> 是一个 JSON 文件的路径、views/ 下的名字（x2 show today），或 -（从标准输入读）。
// 表格写了 from（例 "buy todo"）的，渲染前现跑 x2 <from> --json，把结果当行：存下来的视图每次打开都是新的数据
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
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

/** 表格的 from：现跑那个 x2 命令，它的 --json 输出（一个数组）就是行 */
function fill(page: Page): Page {
	return {
		...page,
		blocks: page.blocks.map((b) => {
			if (b.type !== "table" || !b.from) return b;
			const out = execFileSync(process.execPath, [bin, ...b.from.split(/\s+/), "--json"], { encoding: "utf8" });
			const rows = JSON.parse(out) as unknown;
			if (!Array.isArray(rows)) throw new Error(`x2 ${b.from} --json 的输出不是一个数组，当不了表格的行`);
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
