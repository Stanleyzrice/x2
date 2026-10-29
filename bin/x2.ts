#!/usr/bin/env node
// x2 的命令行：只接线。读 .env，把全部 toolkit 注册进平台，交给平台的命令行（platform/cli.ts：照注册表生成命令、输出约定、退出码）
import "../platform/env.ts";
import { main } from "../platform/cli.ts";
import { register } from "../platform/tool.ts";
import { TOOLKITS } from "./toolkits.ts";

register(...TOOLKITS);
await main(process.argv.slice(2));
