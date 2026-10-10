#!/usr/bin/env node
// x2 的命令行：x2 <命令> [参数…] [--json]。--json 给 agent 读，不加给人读。
// 输出约定：stdout 只放结果；stderr 只放进度、日志；--json 时出错也在 stdout：{ "error": { "kind", "message" } }。
// 退出码：0 成功；1 出错；2 用法不对；3 要人处理（登录、滑块、浏览器没连上）；4 写的结果未知（不许重发，先回读）
import "../src/env.ts";
import { dbCommand } from "../src/commands/db.ts";
import { listingCommand } from "../src/commands/listing.ts";
import { strategyCommand } from "../src/commands/strategy.ts";
import { approveCommand, proposeCommand, runCommand, status } from "../src/commands/loop.ts";
import { schema, site, sites, sitesHelp } from "../src/commands/site.ts";
import { nocodbCommand } from "../src/commands/nocodb.ts";
import { sourceCommand } from "../src/commands/source.ts";
import { close } from "../src/db/index.ts";
import { EXIT, kindOf, Usage } from "../src/errors.ts";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const [cmd, ...args] = argv.filter((a) => a !== "--json");

const commands: Record<string, () => Promise<void>> = {
	status: () => status(args, json),
	propose: () => proposeCommand(args, json),
	approve: () => approveCommand(args, json),
	run: () => runCommand(args, json),
	source: () => sourceCommand(args, json),
	listing: () => listingCommand(args, json),
	strategy: () => strategyCommand(args, json),
	db: () => dbCommand(args, json),
	nocodb: () => nocodbCommand(args, json),
	schema: async () => schema(),
};

const help = [
	"x2 <命令> [参数…] [--json]",
	"推进（见 docs/loop.md）：",
	"  x2 status                      现读站点 → 检查 → 更新收件箱 → 说要做什么",
	"  x2 propose < 一批.json          写一批待批准的写入（x2 status --json 的 todo 里有现成的）；收件箱加一行「批准」",
	"  x2 approve <批次>               替人勾「批准」（人在终端里说了批准时）",
	"  x2 run [--batch N] [--try 操作]  执行批准了的写入：先核清结果未知的，再一个一个做、读回来",
	"  x2 source [商品…] [--url 链接]   给店里的商品找货源（以图搜图）；不给商品就找检查算出来缺的",
	"  x2 source <商品> --spec \"店里的规格名 = 货源的规格名\"   记下人定的规格例外（按名字配不上时）",
	"上品（见 docs/listing.md）：",
	"  x2 listing add <店> <1688 链接…>  添加货源（--strategy 名字：从哪个策略来）",
	"  x2 listing make [商品稿…]         做商品稿：读货源、规格和核价、图（筛字、译图、译图检查、水印、传图）、类目属性",
	"  x2 listing show <商品稿>          写文案要用的事实",
	"  x2 listing text <商品稿> --title … --description …   agent 写的标题和描述",
	"  x2 listing list                  所有商品稿走到哪了",
	"  x2 strategy add | set | list     选品的策略（假设、选品方法）；每个策略出了几份商品稿、上架了几个",
	"  x2 db migrate | import | import-shops   建表；把 ~/x2 的 JSON、lilto 的店铺设置迁进库（只用一次）",
	"  x2 nocodb                       按 docs/loop.md「视图」建 NocoDB：连库、中文名、视图（可以重复跑）",
	"读站点（只读）：",
	...sitesHelp(),
	"  x2 schema  全部站点操作的说明和参数（JSON Schema）",
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
} finally {
	await close();
}
