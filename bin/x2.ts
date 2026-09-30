#!/usr/bin/env node
// x2 的命令行：x2 <命令> [参数…] [--json]。--json 给 agent 读，不加给人读
import { buy } from "../src/commands/buy.ts";
import { askCommand, showCommand } from "../src/commands/page.ts";
import { sync } from "../src/commands/sync.ts";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const [cmd, ...args] = argv.filter((a) => a !== "--json");

const commands: Record<string, () => Promise<void>> = {
	sync: () => sync(json),
	ask: () => askCommand(args[0]),
	show: () => showCommand(args[0]),
	buy: () => buy(args, json),
};

const run = commands[cmd ?? ""];
if (!run) {
	console.error(`命令：${Object.keys(commands).join("、")}`);
	process.exit(2);
}
try {
	await run();
} catch (e) {
	console.error((e as Error).message);
	process.exit(1);
}
