// 连库的测试：propose → 批准 → run → 结果未知停下 → 人核清 → 接着做。用 X2_TEST_DATABASE_URL 指的库（会清空它的 public schema），没设就跳过
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { z } from "zod";
import { check, syncImages } from "../src/check/index.ts";
import type { Reads } from "../src/read.ts";
import { listingCommand } from "../src/commands/listing.ts";
import { ruleCommand } from "../src/commands/rule.ts";
import { strategyCommand } from "../src/commands/strategy.ts";
import { close, migrate } from "../src/db/index.ts";
import { Usage } from "../src/errors.ts";
import { approve, propose } from "../src/propose.ts";
import { run } from "../src/run.ts";
import { setException } from "../src/source.ts";
import type { Submitted, WriteOp } from "../src/site/writes.ts";

const url = process.env.X2_TEST_DATABASE_URL;
const sql = url ? postgres(url, { onnotice: () => {}, max: 2 }) : null;

// 一个假的写操作：n 是对象；outcome 决定提交和读回来的结果
const outcome = new Map<number, { sent: Submitted; done: boolean | null }>();
const submitted: number[] = [];
const fake: WriteOp<{ n: number }> = {
	describe: "试写", params: z.object({ n: z.number() }),
	target: (p) => `t:${p.n}`, key: (p) => `k:${p.n}`, display: (p) => `第 ${p.n} 项`,
	where: (_sql, _p, fn) => fn(),
	prepare: async (_sql, p) => ({ params: p, before: { n: p.n } }),
	submit: async (_sql, p) => { submitted.push(p.n); return outcome.get(p.n)?.sent ?? { kind: "done" }; },
	check: async (p) => ({ done: outcome.has(p.n) ? outcome.get(p.n)!.done : true, readback: { n: p.n } }),
};
const ops = { 试写: fake };

/** 这一轮现读的结果（假的）：只读了 chanboss 订单，ok 是成没成 */
const reads = (ok = true): Reads => ({ cart: [], purchases: [], accounts: new Map(), buyAccount: null, results: [{ what: "订单", who: "chanboss", ok }] });

before(async () => {
	if (!sql) return;
	await sql.unsafe("drop schema public cascade; create schema public");
	await migrate(sql);
});
after(async () => { await sql?.end(); await close(); });

test("写入：批准了才做；结果未知停下这一批，不重发；人核清以后接着做", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const p = await propose(db, { title: "试两项", writes: [{ op: "试写", params: { n: 1 } }, { op: "试写", params: { n: 2 } }] }, ops);
	assert.deepEqual(p.writes.map((w) => w.status), ["待批准", "待批准"]);
	const [inbox] = await db`select kind, open, approve from inbox where key = ${`approve:${p.batch}`}`;
	assert.deepEqual({ ...inbox }, { kind: "批准", open: true, approve: null });

	// 没批准：不做
	assert.equal((await run(db, {}, ops)).ran.length, 0);
	assert.equal(submitted.length, 0);

	// 同一个对象还在等批准：不再准备
	await assert.rejects(propose(db, { title: "再来", writes: [{ op: "试写", params: { n: 1 } }] }, ops), Usage);

	// 批准；第 1 项提交后读回来看不出：结果未知，第 2 项不做
	await approve(db, p.batch);
	outcome.set(1, { sent: { kind: "unknown", why: "超时" }, done: null });
	const r1 = await run(db, {}, ops);
	assert.equal(r1.unknown, true);
	assert.deepEqual(r1.ran.map((x) => [x.display, x.status]), [["第 1 项", "结果未知"], ["第 2 项", "已批准"]]);
	assert.deepEqual(submitted, [1]);

	// 再跑：先核清，还看不出就还是停着，也不重发
	const r2 = await run(db, {}, ops);
	assert.deepEqual(submitted, [1]);
	assert.equal(r2.ran[0]!.status, "结果未知");

	// 读回来看到做成了：已核对，第 2 项接着做
	outcome.set(1, { sent: { kind: "unknown", why: "超时" }, done: true });
	const r3 = await run(db, {}, ops);
	assert.deepEqual(r3.ran.map((x) => [x.display, x.status]), [["第 1 项", "已核对"], ["第 2 项", "已核对"]]);
	assert.deepEqual(submitted, [1, 2]);

	// 这一批没有待批准的了：检查关掉「批准」那一行
	await check(db, reads());
	const [closed] = await db`select open from inbox where key = ${`approve:${p.batch}`}`;
	assert.equal(closed!.open, false);
});

test("写入：取消勾的不做；被拒的记下原因", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const p = await propose(db, { title: "再试两项", writes: [{ op: "试写", params: { n: 3 } }, { op: "试写", params: { n: 4 } }] }, ops);
	await db`update writes set include = false where batch = ${p.batch} and params->>'n' = '3'`;
	outcome.set(4, { sent: { kind: "refused", why: "库存不够" }, done: false });
	await approve(db, p.batch);
	const r = await run(db, {}, ops);
	assert.deepEqual(r.ran.map((x) => [x.display, x.status, x.why]), [["第 4 项", "被拒", "库存不够"]]);
	const rows = await db`select params->>'n' as n, status from writes where batch = ${p.batch} order by id`;
	assert.deepEqual(rows.map((x) => [x.n, x.status]), [["3", "未执行"], ["4", "被拒"]]);
});

test("收件箱：每轮重算，只更新不重复；这一轮读成功了才关", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const soon = new Date(Date.now() + 86400_000);
	await db`insert into orders (sn, shop, ship_by, platform_status, chanboss_status, chanboss_id, chanboss_time, items, created_at)
		values ('S1', 'ni1206', ${soon}, '待出货', '已预报', 'c1', 1, ${db.json([{ itemId: "I", modelId: "M", chanbossModelId: "cM", name: "红T", spec: "L", qty: 1, image: "" }])}, now())`;
	await check(db, reads());
	await check(db, reads());
	const open = await db`select key, open from inbox where key = 'late:S1'`;
	assert.deepEqual(open.map((x) => ({ ...x })), [{ key: "late:S1", open: true }]);

	// 订单打包了，但这一轮 chanboss 没读成：不关
	await db`update orders set chanboss_status = '已打包' where sn = 'S1'`;
	await check(db, reads(false));
	assert.equal((await db`select open from inbox where key = 'late:S1'`)[0]!.open, true);
	// 读成了：关
	await check(db, reads(true));
	assert.equal((await db`select open from inbox where key = 'late:S1'`)[0]!.open, false);
});

test("收件箱：人勾「已处理」就关，以后不再开", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const soon = new Date(Date.now() + 86400_000);
	await db`insert into orders (sn, shop, ship_by, platform_status, chanboss_status, chanboss_id, chanboss_time, items, created_at)
		values ('S2', 'ni1206', ${soon}, '待出货', '已预报', 'c2', 1, ${db.json([{ itemId: "I", modelId: "M", chanbossModelId: "cM", name: "白T", spec: "L", qty: 1, image: "" }])}, now())`;
	await check(db, reads());
	assert.deepEqual({ ...(await db`select open, role from inbox where key = 'late:S2'`)[0] }, { open: true, role: "运营" });
	await db`update inbox set done = true where key = 'late:S2'`;
	await check(db, reads());
	await check(db, reads());
	assert.equal((await db`select open from inbox where key = 'late:S2'`)[0]!.open, false);
});

test("规格例外：x2 source --spec 写进选用的货源那一行；两边都要对得上，同一个规格写过的换掉", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	await db`insert into orders (sn, shop, platform_status, chanboss_status, chanboss_id, chanboss_time, items, created_at)
		values ('S3', 'ni1206', '待出货', '待处理', 'c3', 1, ${db.json([{ itemId: "RACK", modelId: "M3", chanbossModelId: "cM3", name: "衣帽架", spec: "特粗26管雙層側三網150金+輪", qty: 1, image: "" }])}, now())`;
	const skus = ["顶配侧三层置物网+双层置物架+双杆150金+万向轮", "顶配侧三层置物网+双层置物架+双杆150白+万向轮"].map((name, i) => ({ skuId: `K${i}`, specId: "", name, price: 1, stock: 9, image: "" }));
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

test("商品稿的图和 NocoDB 附件：x2 放上去；人删了哪张记下来，以后不用；新做好的照样加进去", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const pic = (id: string) => ({ from: `${id}.jpg`, imageId: id, width: 800, height: 800 });
	const images = { main: [pic("m1"), pic("m2"), { from: "m3.jpg", drop: "有供应商痕迹" }], detail: [pic("d1")], options: [] };
	const [l] = await db`insert into listings (shop, offer_id, images) values ('cheeroutdoor', '1', ${db.json(images)}) returning *`;
	await syncImages(db, l);
	const ids = (col: string) => (JSON.parse(l![col]) as { url: string }[]).map((a) => a.url.split("/").pop());
	assert.deepEqual(ids("main_images"), ["m1", "m2"]);
	assert.deepEqual(ids("detail_images"), ["d1"]);
	// 人在 NocoDB 删了 m1
	await db`update listings set main_images = ${JSON.stringify([{ url: "https://down-tw.img.susercontent.com/file/m2", title: "主图 2" }])} where id = ${l!.id}`;
	const [after] = await db`select * from listings where id = ${l!.id}`;
	await syncImages(db, after);
	const [now] = await db`select removed_images, main_images from listings where id = ${l!.id}`;
	assert.deepEqual(now!.removed_images, ["m1"]);
	// 重做商品稿以后多了一张 m4：照样加进去，m1 还是不用
	await db`update listings set images = ${db.json({ ...images, main: [...images.main, pic("m4")], shown: after!.images.shown })} where id = ${l!.id}`;
	const [again] = await db`select * from listings where id = ${l!.id}`;
	await syncImages(db, again);
	const [last] = await db`select main_images from listings where id = ${l!.id}`;
	assert.deepEqual((JSON.parse(last!.main_images) as { url: string }[]).map((a) => a.url.split("/").pop()), ["m2", "m4"]);
});

test("商品稿的规格图：第一层每个选项一张附件，标题是选项名；只给人看，人删了不记、下一轮写回去", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const pic = (id: string, from: string) => ({ from, imageId: id, width: 800, height: 800 });
	const names = [["黑猫", "水生財黑貓咪", "a.jpg"], ["黄狗", "遇水生財黃蘋狗", "b.jpg"], ["白猫", "白貓", "c.jpg"]];
	const specs = {
		tiers: [{ source: "颜色", name: "款式", options: names.map(([source, name, image]) => ({ source, name, image })) }],
		variants: names.map((_, k) => ({ sku: `LT2-${k}`, skuId: `${k}`, specId: `${k}`, options: [k], costRmb: 1, stock: 9, weightKg: 0.3, priceTwd: 133 })),
	};
	const images = { main: [pic("m1", "m1.jpg")], detail: [], options: [pic("o1", "a.jpg"), pic("o2", "b.jpg"), { from: "c.jpg", drop: "有供应商痕迹" }] };
	const [l] = await db`insert into listings (shop, offer_id, images, variants) values ('cheeroutdoor', '2', ${db.json(images)}, ${db.json(specs)}) returning *`;
	await syncImages(db, l);
	const att = (t: string) => (JSON.parse(t) as { url: string; title: string }[]).map((a) => [a.title, a.url.split("/").pop()]);
	assert.deepEqual(att(l!.option_images), [["水生財黑貓咪", "o1"], ["遇水生財黃蘋狗", "o2"]]);
	// 人在 NocoDB 删了一张规格图：不记成已删除的图，下一轮写回去
	await db`update listings set option_images = ${JSON.stringify([{ url: "https://down-tw.img.susercontent.com/file/o2", title: "遇水生財黃蘋狗" }])} where id = ${l!.id}`;
	const [edited] = await db`select * from listings where id = ${l!.id}`;
	await syncImages(db, edited);
	const [now] = await db`select removed_images, option_images from listings where id = ${l!.id}`;
	assert.deepEqual([now!.removed_images, att(now!.option_images)], [[], [["水生財黑貓咪", "o1"], ["遇水生財黃蘋狗", "o2"]]]);
});

/** x2 的一条命令（--json），回它的输出 */
async function command(fn: (args: string[], json: boolean) => Promise<void>, args: string[]): Promise<any> {
	process.env.X2_DATABASE_URL = url!;
	const printed: string[] = [];
	const log = console.log;
	console.log = (s: string) => { printed.push(s); };
	try { await fn(args, true); } finally { console.log = log; }
	return JSON.parse(printed.join("\n"));
}
const listing = (args: string[]) => command(listingCommand, args);
const strategy = (args: string[]) => command(strategyCommand, args);
const rule = (args: string[]) => command(ruleCommand, args);

/** 一份做好了的商品稿：顏色（黑貓、黃狗、定製）× 尺寸（40*60、60*90），货号 LT<货源>-<各层下标> */
async function madeListing(db: postgres.Sql, offerId: string) {
	const specs = {
		tiers: [
			{ source: "颜色", name: "顏色", options: [["黑猫", "黑貓"], ["黄狗", "黃狗"], ["定制", "定製"]].map(([source, name]) => ({ source, name, image: null })) },
			{ source: "尺寸", name: "尺寸", options: [{ source: "40*60", name: "40*60" }, { source: "60*90", name: "60*90" }] },
		],
		variants: [0, 1, 2].flatMap((a) => [0, 1].map((b) => [a, b])).map((c) => ({ sku: `LT${offerId}-${c.join("")}`, skuId: c.join(""), specId: c.join(""), options: c, costRmb: 1, stock: 9, weightKg: 0.3, priceTwd: 133 })),
	};
	const [l] = await db`insert into listings (shop, offer_id, offer, variants) values ('cheeroutdoor', ${offerId}, ${db.json({ offerId, props: [], skus: [] })}, ${db.json(specs)}) returning id::text`;
	return { id: l!.id as string, specs };
}

test("x2 listing drop：按结构去掉整个选项，货号记进已移除的规格；去掉单个规格会让组合不齐时不做", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const { id } = await madeListing(db, "3");
	assert.deepEqual(await listing(["drop", id, "定製"]), { id, name: `货源 3（cheeroutdoor，#${id}）`, dropped: ["LT3-20", "LT3-21"], left: 4, merged: false });
	const [dropped] = await db`select variants, removed_variants from listings where id = ${id}`;
	assert.deepEqual([dropped!.removed_variants, dropped!.variants.tiers[0].options.map((o: any) => o.name)], [["LT3-20", "LT3-21"], ["黑貓", "黃狗"]]);
	// 去掉单个规格会让两层的组合不齐：不做，库里不变
	await assert.rejects(listing(["drop", id, "LT3-00"]), (e: Error) => e instanceof Usage && /组合不齐/.test(e.message));
	const [same] = await db`select removed_variants from listings where id = ${id}`;
	assert.deepEqual(same!.removed_variants, ["LT3-20", "LT3-21"]);
});

test("x2 listing text：规格名交得不对（重名、层数不对）什么都不存，标题、描述也不存", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const { id, specs } = await madeListing(db, "4");
	const text = (tiers: unknown) => listing(["text", id, "--title", "矽藻土地墊 可愛貓咪造型 防滑吸水 浴室門口", "--description", "商品介紹", "--tiers", JSON.stringify(tiers)]);
	const tiers = [{ name: "款式", options: ["黑貓", "黑貓", "定製"] }, { name: "尺寸", options: ["40×60cm", "60×90cm"] }];
	const dup = await text(tiers);
	assert.deepEqual([dup.text[0].saved, dup.audit], [false, []]);
	assert.match(dup.text[0].problems.join(), /第 1 层「款式」的第 1、2 个选项都叫「黑貓」/);
	assert.match((await text(tiers.slice(0, 1))).text[0].problems.join(), /要 2 层（照 x2 listing show），交了 1 层/);
	const [row] = await db`select title, description, variants from listings where id = ${id}`;
	assert.deepEqual([row!.title, row!.description, row!.variants], [null, null, specs]);
});

test("x2 listing keep：按附件上的名字找图，x2 去掉的放回来、记进保留的图；人删的不放回来", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const pic = (id: string, extra: object = {}) => ({ from: `${id}.jpg`, imageId: id, width: 800, height: 800, ...extra });
	const images = { main: [pic("m1"), pic("m2", { drop: "Gemini 文字检查：「质量」" })], detail: [pic("d1"), pic("d2")], options: [] };
	const [l] = await db`insert into listings (shop, offer_id, images, removed_images) values ('cheeroutdoor', '5', ${db.json(images)}, ${db.json(["d1"])}) returning id::text`;
	const id = l!.id as string;
	await assert.rejects(listing(["keep", id, "详情图 1"]), (e: Error) => e instanceof Usage && /详情图 1是人在 NocoDB 删的/.test(e.message));
	await assert.rejects(listing(["keep", id, "主图 9"]), (e: Error) => e instanceof Usage && /没有主图 9（有：主图 1、主图 2、详情图 1、详情图 2）/.test(e.message));
	const r = await listing(["keep", id, "主图", "2", "详情图2"]);
	assert.deepEqual([r.kept, r.restored, r.audit[0].checked], [["主图 2", "详情图 2"], ["主图 2"], false]);
	const [now] = await db`select images, kept_images, main_images, detail_images from listings where id = ${id}`;
	assert.deepEqual([now!.images.main[1].drop, now!.kept_images], [undefined, ["m2", "d2"]]);
	// 附件跟着变：放回来的「主图 2」又在了；人删的「详情图 1」不在，「详情图 2」的名字不变
	const titles = (t: string) => (JSON.parse(t) as { title: string }[]).map((a) => a.title);
	assert.deepEqual([titles(now!.main_images), titles(now!.detail_images)], [["主图 1", "主图 2"], ["详情图 2"]]);
});

test("x2 listing estimate：只填空着的「重量」「国内运费」，人填过的不动；写完马上重新核价，人改了也照着重算", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const specs = {
		tiers: [{ source: "颜色", name: "顏色", options: [{ source: "黑猫", name: "黑貓", image: null }, { source: "白猫", name: "白貓", image: null }] }],
		variants: [0, 1].map((k) => ({ sku: `LT6-${k}`, skuId: `${k}`, specId: `${k}`, options: [k], costRmb: 10, stock: 9, weightKg: k ? null : 0.3, priceTwd: null })),
	};
	const offer = { offerId: "6", title: "猫咪地垫", props: [], skus: [{ skuId: "0", attrs: ["黑猫"], weightKg: 0.3 }, { skuId: "1", attrs: ["白猫"] }], tags: { freeShipping: false } };
	const [l] = await db`insert into listings (shop, offer_id, offer, variants, pricing) values ('cheeroutdoor', '6', ${db.json(offer)}, ${db.json(specs)}, ${db.json({ freightRmb: null })}) returning id::text`;
	const id = l!.id as string;
	await assert.rejects(listing(["estimate", id, "--weight", "0"]), Usage);
	await assert.rejects(listing(["estimate", id]), Usage);
	const r = await listing(["estimate", id, "--weight", "1", "--freight", "10"]);
	assert.deepEqual([r.notes, r.needs, r.problems], [["重量：记为 1 kg", "国内运费：记为 10 元/件"], [], []]);
	const [now] = await db`select weight_kg, freight_rmb, variants, pricing from listings where id = ${id}`;
	assert.deepEqual([Number(now!.weight_kg), Number(now!.freight_rmb), now!.pricing.freightRmb], [1, 10, 10]);
	assert.deepEqual(now!.variants.variants.map((v: any) => v.weightKg), [0.3, 1]);
	assert.ok(now!.variants.variants.every((v: any) => v.priceTwd > 0));
	// 人在 NocoDB 改成 0.8：agent 再估也不改；照人改的重新核价
	await db`update listings set weight_kg = 0.8 where id = ${id}`;
	const again = await listing(["estimate", id, "--weight", "2"]);
	assert.deepEqual(again.notes, ["重量：已有 0.8 kg（人填的或估过的），不改"]);
	const [kept] = await db`select weight_kg, variants from listings where id = ${id}`;
	assert.deepEqual([Number(kept!.weight_kg), kept!.variants.variants.map((v: any) => v.weightKg)], [0.8, [0.3, 0.8]]);
	// 人又改成 0.9：下一次 x2 status 的检查就重新核价
	await db`update listings set weight_kg = 0.9 where id = ${id}`;
	await check(db, reads());
	const [checked] = await db`select variants, step, step_detail from listings where id = ${id}`;
	assert.deepEqual(checked!.variants.variants.map((v: any) => v.weightKg), [0.3, 0.9]);
});

test("x2 listing text 交简称：简体、最多 12 字，不对就什么都不存；只在空着、还是自动填的时候写，人改过的不改", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const { id } = await madeListing(db, "7");
	await db`update listings set offer = offer || ${db.json({ title: "浴水生财猫咪浴室地垫硅藻泥卫生间门口防滑脚垫" })}, nickname = '浴水生财猫咪浴室地垫硅藻' where id = ${id}`;
	const text = (nickname: string) => listing(["text", id, "--title", "矽藻土地墊 可愛貓咪造型 防滑吸水 浴室門口", "--description", "商品介紹", "--nickname", nickname]);
	const bad = await text("浴水生財貓狗地墊");
	assert.deepEqual([bad.text[0].saved, bad.text[0].problems], [false, ["简称「浴水生財貓狗地墊」有繁体字，要用简体中文（浴水生财猫狗地垫）"]]);
	const ok = await text("浴水生财猫狗地垫");
	assert.deepEqual([ok.text[0].saved, ok.text[0].name], [true, `浴水生财猫狗地垫（cheeroutdoor，#${id}）`]);
	// 人在 NocoDB 改了：agent 再交也不改，说一声
	await db`update listings set nickname = '猫咪地垫' where id = ${id}`;
	const again = await text("可爱猫狗地垫");
	assert.deepEqual([again.text[0].saved, again.text[0].notes], [true, ["简称：已有「猫咪地垫」，不改（只在空着、还是自动填的时候写）"]]);
	const [row] = await db`select nickname, title from listings where id = ${id}`;
	assert.deepEqual([row!.nickname, row!.title], ["猫咪地垫", "矽藻土地墊 可愛貓咪造型 防滑吸水 浴室門口"]);
});

test("x2 strategy：add 是第 1 版；set 要 --why，每次改版本号加 1、变更记录记改之前和改之后；没变的不加", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	assert.deepEqual(await strategy(["add", "搜索缺口", "--bet", "搜得多、卖的少", "--how", "知虾热搜词", "--why", "先试"]), { name: "搜索缺口", version: 1, bet: "搜得多、卖的少", how: "知虾热搜词", status: "试验中" });
	await assert.rejects(strategy(["set", "搜索缺口", "--how", "换个选法"]), (e: Error) => e instanceof Usage && /--why 必填/.test(e.message));
	await assert.rejects(strategy(["set", "搜索缺口", "--why", "没说改什么"]), Usage);
	const set = await strategy(["set", "搜索缺口", "--how", "热搜词，剔掉 NT$1 的", "--status", "使用中", "--why", "NT$1 的是客製化链接"]);
	assert.deepEqual([set.version, set.before, set.after], [2, { status: "试验中", how: "知虾热搜词" }, { status: "使用中", how: "热搜词，剔掉 NT$1 的" }]);
	// 和现在一样：不加版本号、不记
	assert.deepEqual(await strategy(["set", "搜索缺口", "--status", "使用中", "--why", "再说一遍"]), { name: "搜索缺口", version: 2, changed: false });
	const log = await strategy(["log", "搜索缺口"]);
	assert.deepEqual(log.changes.map((c: any) => [c.version, c.before, c.after, c.why]), [
		[1, null, { status: "试验中", bet: "搜得多、卖的少", how: "知虾热搜词" }, "先试"],
		[2, { status: "试验中", how: "知虾热搜词" }, { status: "使用中", how: "热搜词，剔掉 NT$1 的" }, "NT$1 的是客製化链接"],
	]);
	const list = await strategy(["list"]);
	assert.equal(list.find((r: any) => r.name === "搜索缺口").version, 2);
	const [row] = await db`select version, how, status from strategies where name = '搜索缺口'`;
	assert.deepEqual({ ...row }, { version: 2, how: "热搜词，剔掉 NT$1 的", status: "使用中" });
});

test("x2 rule：add、retire 要 --why；停用的不删，写结束时间和停用原因；list 默认只列在用的", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	await assert.rejects(rule(["add", "起订量 1"]), Usage);
	const a = await rule(["add", "1688 一件代发、48 小时发货、起订量 1", "--why", "不压货"]);
	const b = await rule(["add", "售价不超过 NT$500", "--why", "先做低价"]);
	await assert.rejects(rule(["retire", b.id]), Usage);
	const retired = await rule(["retire", b.id, "--why", "限制太死"]);
	assert.deepEqual([retired.retire_why, Boolean(retired.ended_at)], ["限制太死", true]);
	await assert.rejects(rule(["retire", b.id, "--why", "再停一次"]), (e: Error) => e instanceof Usage && /已经停用/.test(e.message));
	assert.deepEqual((await rule(["list"])).map((r: any) => r.id), [a.id]);
	assert.deepEqual((await rule(["list", "--all"])).map((r: any) => [r.id, r.ended_at === null]), [[a.id, true], [b.id, false]]);
	const [kept] = await db`select rule, why, retire_why from selection_rules where id = ${b.id}`;
	assert.deepEqual({ ...kept }, { rule: "售价不超过 NT$500", why: "先做低价", retire_why: "限制太死" });
});

test("x2 listing add：按策略选的要 --why；记下选品理由、依据和当时的策略、在用的选品规矩；x2 listing why 补记", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	await strategy(["add", "季节", "--bet", "换季", "--how", "看月份"]);
	await strategy(["set", "季节", "--bet", "换季前一个月", "--why", "要提前"]);
	await db`update selection_rules set ended_at = now() where ended_at is null`;
	const [r1] = await db`insert into selection_rules (rule, why) values ('起订量 1', '不压货') returning id::text`;
	await db`insert into selection_rules (rule, why, ended_at) values ('停了的', '试试', now())`;
	await assert.rejects(listing(["add", "cheeroutdoor", "901", "--strategy", "季节"]), (e: Error) => e instanceof Usage && /--why 必填/.test(e.message));
	const added = await listing(["add", "cheeroutdoor", "901", "902", "--strategy", "季节", "--why", "冬天到了", "--evidence", "暖桌搜索量 2 万"]);
	assert.deepEqual(added.map((a: any) => [a.offerId, a.isNew, a.why, a.evidence]), [["901", true, "冬天到了", "暖桌搜索量 2 万"], ["902", true, "冬天到了", "暖桌搜索量 2 万"]]);
	const [l] = await db`select strategy, pick_why, pick_evidence, pick_snapshot from listings where id = ${added[0].id}`;
	const { at, ...snap } = l!.pick_snapshot;
	assert.ok(Math.abs(Date.parse(at) - Date.now()) < 60_000);
	assert.deepEqual(snap, { backfilled: false, strategy: { name: "季节", version: 2, bet: "换季前一个月", how: "看月份", status: "试验中" }, rules: [{ id: r1!.id, rule: "起订量 1" }] });
	// 以后策略改了：加进来时的快照不变
	await strategy(["set", "季节", "--how", "看节气", "--why", "更准"]);
	const [same] = await db`select pick_snapshot from listings where id = ${added[0].id}`;
	assert.equal(same!.pick_snapshot.strategy.version, 2);
	// 已经有的再加：理由、快照不改
	const again = await listing(["add", "cheeroutdoor", "901", "--strategy", "季节", "--why", "另一个理由"]);
	assert.deepEqual([again[0].isNew, again[0].why], [false, "冬天到了"]);
	// 人选的不用 --why
	const human = await listing(["add", "cheeroutdoor", "903"]);
	assert.deepEqual([human[0].why, human[0].snapshot.strategy.name], [null, "人选"]);

	// 补记：没有快照的照现在补一份，标明补记；已有理由的要 --force
	const [old] = await db`insert into listings (shop, offer_id, strategy) values ('cheeroutdoor', '904', '季节') returning id::text`;
	await assert.rejects(listing(["why", old!.id]), Usage);
	const w = await listing(["why", old!.id, "--why", "补的理由", "--evidence", "当时的数据"]);
	assert.deepEqual([w.why, w.evidence, w.backfilled, w.replaced, w.snapshot.backfilled, w.snapshot.strategy.version], ["补的理由", "当时的数据", true, false, true, 3]);
	await assert.rejects(listing(["why", old!.id, "--why", "改一下"]), (e: Error) => e instanceof Usage && /--force/.test(e.message));
	const forced = await listing(["why", old!.id, "--why", "改一下", "--force"]);
	assert.deepEqual([forced.why, forced.evidence, forced.replaced, forced.backfilled, forced.snapshot.at], ["改一下", "当时的数据", true, false, w.snapshot.at]);
	// 人选的、加进来时有快照的：补理由，快照不动
	const h = await listing(["why", human[0].id, "--why", "运营贴的"]);
	assert.deepEqual([h.backfilled, h.snapshot.backfilled, h.snapshot.at], [false, false, human[0].snapshot.at]);
});
