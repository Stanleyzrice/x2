import { readFile } from "node:fs/promises";
import { z } from "zod";
import { db, type Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { get, type Toolkit } from "../../platform/tool.ts";
import { snapshotSchema } from "../../platform/ui/interactable/store-monitor/schema.ts";
import { collectDay } from "./daily.ts";
import { collectSnapshot } from "./snapshot.ts";

const params = z.object({ shop: z.string().min(1) });
type Shop = z.output<typeof params>["shop"];

async function configuredShopId(sql: Sql | import("postgres").TransactionSql, shop: Shop): Promise<string> {
	const [account] = await sql<{ shop_id: string }[]>`select shop_id from shop_settings where shop = ${shop}`;
	if (!account) throw new Usage(`没有已配置的店铺 ${shop}`);
	return account.shop_id;
}

async function readSnapshot(sql: Sql, shop: Shop) {
	const [saved] = await sql<{ snapshot: unknown }[]>`select snapshot from store_monitor_snapshots where shop = ${shop}`;
	if (saved) return snapshotSchema.parse(saved.snapshot);
	if (shop !== "cheeroutdoor") return null;
	try {
		const file = new URL("../../artifacts/store-monitor/cheeroutdoor.json", import.meta.url);
		return snapshotSchema.parse(JSON.parse(await readFile(file, "utf8")));
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

async function refreshSnapshot(sql: Sql, shop: Shop) {
	return sql.begin(async (tx) => {
		const [lock] = await tx<{ acquired: boolean }[]>`select pg_try_advisory_xact_lock(hashtext('x2 store monitor'), hashtext(${shop})) as acquired`;
		if (!lock?.acquired) throw new Usage("店铺数据正在刷新，请稍后查看");
		const snapshot = await collectSnapshot(shop, await configuredShopId(tx, shop));
		await tx`insert into store_monitor_snapshots (shop, snapshot) values (${shop}, ${tx.json(snapshot)})
			on conflict (shop) do update set snapshot = excluded.snapshot`;
		return snapshot;
	});
}

export const storeMonitor: Toolkit = {
	name: "store-monitor",
	title: "店铺监控",
	kind: "tool",
	schema: new URL("./schema.sql", import.meta.url),
	workspaces: [
		{
			key: "store-monitor-cheeroutdoor",
			title: "店铺监控",
			group: "cheeroutdoor",
			component: "store-monitor",
			props: { shop: "cheeroutdoor", title: "店铺监控" },
			icon: "activity",
			order: 5,
		},
	],
	tools: {
		snapshot: get("读取上次成功保存的店铺监控快照", params, async ({ shop }) => readSnapshot(await db(), shop)),
		refresh: get("重新读取虾皮流量、商品表现及全状态目录，采集成功后保存快照", params, async ({ shop }) => refreshSnapshot(await db(), shop)),
		daily: get("读取台湾单日的商品访客及搜索、推荐点击", params.extend({ date: z.iso.date() }), async ({ shop, date }) =>
			collectDay(shop, await configuredShopId(await db(), shop), date),
		),
	},
};
