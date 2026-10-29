#!/usr/bin/env node
// x2 的命令行：x2 <命令> [参数…] [--json]。--json 给 agent 读，不加给人读。
// 输出约定：stdout 只放结果；stderr 只放进度、日志；--json 时出错也在 stdout：{ "error": { "kind", "message" } }。
// 退出码：0 成功；1 出错；2 用法不对；3 要人处理（登录、滑块、浏览器没连上）；4 写的结果未知（不许重发，先回读）
import "../src/core/env.ts";
import { dbCommand } from "../src/commands/db.ts";
import { listingCommand } from "../src/commands/listing.ts";
import { doCommand, handledCommand, resolveCommand, status, verifyCommand } from "../src/commands/loop.ts";
import { ruleCommand } from "../src/commands/rule.ts";
import { schema, site, sites, sitesHelp } from "../src/commands/site.ts";
import { sourceCommand } from "../src/commands/source.ts";
import { strategyCommand } from "../src/commands/strategy.ts";
import { webCommand } from "../src/commands/web.ts";
import { close } from "../src/core/db.ts";
import { EXIT, kindOf, Usage } from "../src/core/errors.ts";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const [cmd, ...args] = argv.filter((a) => a !== "--json");

const commands: Record<string, () => Promise<void>> = {
	status: () => status(args, json),
	do: () => doCommand(args, json),
	verify: () => verifyCommand(args, json),
	resolve: () => resolveCommand(args, json),
	handled: () => handledCommand(args, json),
	source: () => sourceCommand(args, json),
	listing: () => listingCommand(args, json),
	strategy: () => strategyCommand(args, json),
	rule: () => ruleCommand(args, json),
	db: () => dbCommand(args, json),
	web: () => webCommand(args, json),
	schema: async () => schema(),
};

const help = [
	"x2 <命令> [参数…] [--json]",
	"推进（见 docs/loop.md）：",
	"  x2 status                      现读站点 → 检查 → 说要人做的、agent 能做的",
	"  x2 do [--try 操作] < 一批.json   人在终端里同意了：执行一批写入（x2 status --json 的 todo 里有现成的）：先核清结果未知的，再一个一个做、读回来",
	"  x2 verify                      读回来核清结果未知的写入",
	"  x2 resolve <写入> 已核对|被拒     人到站点上看过结果未知的写入",
	"  x2 handled <key…> [--note 说明]  x2 看不到结果的事，人说做完了：不再提醒",
	"  x2 source [商品…] [--url 链接]   给店里的商品找货源（以图搜图）；不给商品就找检查算出来缺的",
	'  x2 source <商品> --spec "店里的规格名 = 货源的规格名"   记下人定的规格例外（按名字配不上时）',
	"上品（见 docs/listing.md）：",
	"  x2 listing quote <1688 链接> [--shop 店] [--weight kg] [--freight 元/件]   报价（选品用）：售价区间、每个规格的价格和重量；不做图、不存库",
	'  x2 listing add <店> <1688 链接…> [--strategy 名字 --why "选品理由"] [--evidence "依据"]   添加货源；按策略选的要写理由，记下当时的策略和选品规矩',
	'  x2 listing why <商品稿> --why "选品理由" [--evidence "依据"] [--force]   给加进来的商品稿补记理由（已有理由的要 --force 才覆盖）',
	"  x2 listing make [商品稿…] [--jobs N]   做商品稿：读货源、规格和核价、图（筛字、译图、译图检查、水印、传图）、类目属性；几份同时做（默认 3）",
	"  x2 listing estimate <商品稿> [--weight kg] [--freight 元/件]   估 1688 没给的重量、读不到的国内运费（只填空着的），马上重新核价",
	"  x2 listing show <商品稿>          写文案要用的事实",
	"  x2 listing text <商品稿> --title … --description … [--tiers JSON] [--nickname 简称]   agent 写的标题、描述、规格名和简称",
	"  x2 listing category <商品稿> <类目 id>   人定的类目（人在终端里定了时；叶子、本店允许的）；再 x2 listing make",
	"  x2 listing publish <商品稿…>      人在终端里说了批准：建商品、上架",
	"  x2 listing cancel <商品稿…> [--why 原因]   替人勾「放弃」（人在终端里说了放弃时）；建了商品的要下架，不是放弃",
	"  x2 listing noted <商品稿…>        照人写的「备注」做完：记下看过的备注",
	"  x2 listing list                  所有商品稿走到哪了",
	"  x2 strategy add | set | list | log   选品的策略（假设、选品方法、版本号）；set 要 --why，版本号加 1；log 看变更记录",
	"  x2 rule add | retire | list       选品规矩（所有策略共用）：add、retire 要 --why；停用的不删",
	"  x2 web [--host 127.0.0.1] [--port 5170]   开网页：商品稿（审稿、删图）、订单、货源、设置；人在这里看、填",
	"  x2 db migrate                  建表、加列",
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
