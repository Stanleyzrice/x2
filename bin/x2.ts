#!/usr/bin/env node
// x2 的命令行：x2 <命令> [参数…] [--json]。--json 给 agent 读，不加给人读。
// 输出约定：stdout 只放结果；stderr 只放进度、日志；--json 时出错也在 stdout：{ "error": { "kind", "message" } }。
// 退出码：0 成功；1 出错；2 用法不对；3 要人处理（登录、滑块、浏览器没连上）；4 写的结果未知（不许重发，先回读）
import { buy } from "../src/commands/buy.ts";
import { askCommand, showCommand } from "../src/commands/page.ts";
import { schema, site, sites, sitesHelp } from "../src/commands/site.ts";
import { EXIT, kindOf, Usage } from "../src/errors.ts";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const [cmd, ...args] = argv.filter((a) => a !== "--json");

const commands: Record<string, () => Promise<void>> = {
	ask: () => askCommand(args[0]),
	show: () => showCommand(args[0]),
	buy: () => buy(args, json),
	schema: async () => schema(),
};

const help = [
	"x2 <命令> [参数…] [--json]",
	"读站点（只读）：",
	...sitesHelp(),
	"  x2 schema  全部站点操作的说明和参数（JSON Schema）",
	"做事：",
	"  x2 buy …       采购：x2 buy order 同步订单、x2 buy 采购单、x2 buy source 找货源、x2 buy cart 加进 1688 购物车",
	"  x2 ask <声明>  渲染一个 page，等人提交，打印答案",
	"  x2 show <声明> 渲染一个 page，只看",
	"退出码：0 成功；1 出错；2 用法不对；3 要人处理（登录、滑块、浏览器没连上）；4 写的结果未知（不许重发，先回读）",
].join("\n");

try {
	if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") console.log(help);
	else if (sites.has(cmd)) await site(cmd, args, json);
	else if (cmd in commands) await commands[cmd]!();
	else throw new Usage(`没有 ${cmd} 这个命令\n${help}`);
} catch (e) {
	const kind = kindOf(e);
	const message = (e as Error).message;
	if (json) console.log(JSON.stringify({ error: { kind, message } }));
	else console.error(message);
	process.exitCode = EXIT[kind];
}
