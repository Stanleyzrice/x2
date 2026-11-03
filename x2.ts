#!/usr/bin/env node
// x2 的装配：把连接器、业务工具登记进平台的注册表，交给平台的命令行（platform/cli.ts）。唯一同时认识三层的文件：只 import platform、连接器和业务工具的入口（index.ts）。
// node x2.ts <命令> 跑命令行；别的文件（测试）import 它拿全部 toolkit，不跑命令行
import "./platform/env.ts";
import { gemini } from "./connectors/services/gemini/index.ts";
import { image } from "./connectors/services/image/index.ts";
import { market } from "./connectors/services/market/index.ts";
import { xiangji } from "./connectors/services/xiangji/index.ts";
import { alibaba } from "./connectors/sites/1688/index.ts";
import { chanboss } from "./connectors/sites/chanboss/index.ts";
import { shopee } from "./connectors/sites/shopee/index.ts";
import { zhixia } from "./connectors/sites/zhixia/index.ts";
import { main } from "./platform/cli.ts";
import { page, platform } from "./platform/commands.ts";
import { register, type Toolkit } from "./platform/tool.ts";
import { catalog } from "./tools/catalog/index.ts";
import { chat } from "./tools/chat/index.ts";
import { listing } from "./tools/listing/index.ts";
import { orders } from "./tools/orders/index.ts";
import { refreshAll, reimbursement } from "./tools/reimbursement/index.ts";
import { selection } from "./tools/selection/index.ts";

catalog.workspaces = ["ni1206", "cheeroutdoor"].map((shop) => ({
	key: `catalog-${shop}`,
	title: "Catalog",
	group: shop,
	component: "catalog",
	props: { shop, defaultStatus: "1" },
	icon: "package",
}));
chat.workspaces = ["ni1206", "cheeroutdoor"].map((shop) => ({
	key: `chat-${shop}`,
	title: "Chat",
	group: shop,
	component: "chat",
	props: { shop, policyPath: ".agents/skills/chat/SKILL.md", historyDays: 7 },
	icon: "message",
}));
const reimbursementRefresh = { name: "reimbursement-refresh", hour: 20, timeZone: "Asia/Shanghai", run: refreshAll };
reimbursement.jobs = [reimbursementRefresh];
reimbursement.workspaces = [
	{
		key: "reimbursement",
		title: "Reimbursement",
		group: "采购",
		component: "reimbursement",
		props: { schedule: { hour: reimbursementRefresh.hour, timeZone: reimbursementRefresh.timeZone } },
		icon: "receipt",
	},
];

export const TOOLKITS: Toolkit[] = [
	platform,
	page,
	orders,
	listing,
	selection,
	catalog,
	chat,
	reimbursement,
	shopee,
	alibaba,
	chanboss,
	zhixia,
	market,
	gemini,
	xiangji,
	image,
];

if (import.meta.main) {
	register(...TOOLKITS);
	await main(process.argv.slice(2));
}
