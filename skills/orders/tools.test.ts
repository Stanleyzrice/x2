// 订单的工具（连库，test/db.ts）：提醒每次现算、人说做完了不再提醒；规格例外
import assert from "node:assert/strict";
import { test } from "node:test";
import { platform } from "../../platform/commands.ts";
import { check, skip, sql, tool } from "../../test/db.ts";
import { setException } from "./source.ts";

const handled = (args: string[]) => tool(platform, ["handled", ...args]);

test("提醒：每次 x2 status 现算；人说做完了（x2 handled）就不再提醒", { skip }, async () => {
	const db = sql!;
	const soon = new Date(Date.now() + 86400_000);
	await db`insert into orders (sn, shop, ship_by, platform_status, chanboss_status, chanboss_id, chanboss_time, items, created_at)
		values ('S1', 'ni1206', ${soon}, '待出货', '已预报', 'c1', 1, ${db.json([{ itemId: "I", modelId: "M", chanbossModelId: "cM", name: "红T", spec: "L", qty: 1, image: "" }])}, now())`;
	const late = async () => (await check(db)).reminders.filter((x) => x.key === "late:S1").map((x) => x.kind);
	assert.deepEqual(await late(), ["快到期"]);
	await handled(["--keys", "late:S1", "--note", "跟买家说好了晚两天"]);
	assert.deepEqual(await late(), []);
	assert.equal((await db`select note from handled where key = 'late:S1'`)[0]!.note, "跟买家说好了晚两天");
});

test("规格例外：x2 orders spec 写进选用的货源那一行；两边都要对得上，同一个规格写过的换掉", { skip }, async () => {
	const db = sql!;
	await db`insert into orders (sn, shop, platform_status, chanboss_status, chanboss_id, chanboss_time, items, created_at)
		values ('S3', 'ni1206', '待出货', '待处理', 'c3', 1, ${db.json([{ itemId: "RACK", modelId: "M3", chanbossModelId: "cM3", name: "衣帽架", spec: "特粗26管雙層側三網150金+輪", qty: 1, image: "" }])}, now())`;
	const skus = ["顶配侧三层置物网+双层置物架+双杆150金+万向轮", "顶配侧三层置物网+双层置物架+双杆150白+万向轮"].map((name, i) => ({
		skuId: `K${i}`,
		specId: "",
		name,
		price: 1,
		stock: 9,
		image: "",
	}));
	await assert.rejects(setException(db, "RACK", "特粗26管雙層側三網150金+輪 = 顶配侧三层置物网+双层置物架+双杆150金+万向轮"), /还没定货源/);
	await db`insert into sources (item_id, offer_id, title, skus, chosen) values ('RACK', 'O9', '衣帽架货源', ${db.json(skus)}, true)`;
	await assert.rejects(setException(db, "RACK", "特粗26管 = 顶配侧三层置物网+双层置物架+双杆150金+万向轮"), /卖过的规格里没有/);
	await assert.rejects(setException(db, "RACK", "特粗26管雙層側三網150金+輪 = 顶配150银"), /最像的：顶配/);
	await setException(db, "RACK", "特粗26管双层侧三网150金+轮 = 顶配侧三层置物网+双层置物架+双杆150白+万向轮");
	const r = await setException(db, "RACK", "特粗26管雙層側三網150金+輪=顶配侧三层置物网+双层置物架+双杆150金+万向轮");
	assert.equal(r.spec, "特粗26管雙層側三網150金+輪");
	const [row] = await db`select sku_exceptions from sources where item_id = 'RACK'`;
	assert.equal(row!.sku_exceptions, "特粗26管雙層側三網150金+輪 = 顶配侧三层置物网+双层置物架+双杆150金+万向轮");
});
