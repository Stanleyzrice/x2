// 上品的工具（连库，test/db.ts）：publish 建商品、上架；cancel、category、drop、text、keep、estimate；备注
import assert from "node:assert/strict";
import { test } from "node:test";
import type postgres from "postgres";
import { z } from "zod";
import { platform } from "../../platform/commands.ts";
import { Usage } from "../../platform/errors.ts";
import { perform, run, type Submitted, type WriteOp } from "../../platform/writes.ts";
import { check, skip, sql, tool } from "../../test/db.ts";
import { auditKey } from "./audit.ts";
import { listing as listingKit, publishPlan, setCategory } from "./index.ts";
import { settingsOf } from "./pricing.ts";
import { productOf } from "./ready.ts";
import { listingsCheck } from "./status.ts";

const listing = (args: string[]) => tool(listingKit, args);
const resolve = (args: string[]) => tool(platform, ["resolve", ...args]);
const publish = async (db: postgres.Sql, ids: string[], o: Record<string, WriteOp>) => perform(db, await publishPlan(db, ids), {}, o);

/** 一份走到待批准的商品稿（单层两个颜色，1688 给了重量、包邮），文案写好、Gemini 查过 */
async function readyListing(db: postgres.Sql, offerId: string): Promise<string> {
	const specs = {
		tiers: [
			{
				source: "颜色",
				name: "顏色",
				options: [
					{ source: "黑色", name: "黑色", image: null },
					{ source: "绿色", name: "綠色", image: null },
				],
			},
		],
		variants: [0, 1].map((k) => ({
			sku: `LT${offerId}-${k}`,
			skuId: `${k}`,
			specId: `${k}`,
			options: [k],
			costRmb: 10,
			stock: 9,
			weightKg: 0.5,
			priceTwd: null,
		})),
	};
	const offer = {
		offerId,
		title: "雨衣",
		props: [],
		skus: [
			{ skuId: "0", attrs: ["黑色"], weightKg: 0.5 },
			{ skuId: "1", attrs: ["绿色"], weightKg: 0.5 },
		],
		tags: { freeShipping: true },
	};
	const images = { main: [{ from: "m.jpg", imageId: `m${offerId}`, width: 800, height: 800 }], detail: [], options: [] };
	const [l] = await db`insert into listings (shop, offer_id, offer, variants, images, title, description, category_path, days_to_ship, attributes, nickname)
		values ('cheeroutdoor', ${offerId}, ${db.json(offer)}, ${db.json(specs)}, ${db.json(images)}, '輕便雨衣 成人連身 防水透氣 騎車通勤', '防水雨衣，騎車通勤用', ${db.json([100637, 101324])}, 10, ${db.json([])}, ${`雨衣${offerId}`})
		returning id::text`;
	const id = l!.id as string;
	await listingsCheck(db, [id]); // 核价
	const [row] = await db`select * from listings where id = ${id}`;
	const [s] = await db`select * from shop_settings where shop = 'cheeroutdoor'`;
	await db`update listings set audit = ${db.json({ key: auditKey(productOf(row, settingsOf(s)).product!), textIssues: [], images: [] })} where id = ${id}`;
	await listingsCheck(db, [id]);
	return id;
}

/** 假的建商品、上架：做成了在库里记商品 id、上架时间（和真的一样）；result 决定提交和读回来的结果 */
function listingOps(result: Map<string, { sent: Submitted; done: boolean | null }>, sent: string[]) {
	const op = (name: string, after: (db: postgres.Sql, p: { listingId: string }) => Promise<unknown>): WriteOp<{ listingId: string }> => ({
		describe: name,
		params: z.object({ listingId: z.string() }),
		target: (p) => `listing:${p.listingId}`,
		key: (p) => `${name}:${p.listingId}`,
		display: (p) => `${name} ${p.listingId}`,
		where: (_sql, _p, fn) => fn(),
		// 和真的一样：还没建好的不上架
		prepare: async (db, p) =>
			name === "上架" && !(await db`select product_id from listings where id = ${p.listingId}`)[0]?.product_id
				? { skip: "还没建好（建商品没成功）" }
				: { params: p, before: {} },
		submit: async (_sql, p) => {
			sent.push(`${name} ${p.listingId}`);
			return result.get(name)?.sent ?? { kind: "done" };
		},
		check: async () => ({ done: result.has(name) ? result.get(name)!.done : true, readback: {} }),
		after: async (db, p) => {
			await after(db, p);
		},
	});
	return {
		建商品: op("建商品", (db, p) => db`update listings set product_id = '9001' where id = ${p.listingId}`),
		上架: op("上架", (db, p) => db`update listings set listed_at = now() where id = ${p.listingId}`),
	};
}

test("x2 listing publish：只收待批准、待上架的，马上建商品、上架、重算当前步骤；结果未知不重发", {
	skip,
}, async () => {
	const db = sql!;
	const id = await readyListing(db, "80");
	const now = async () => ({ ...(await db`select step, step_detail from listings where id = ${id}`)[0] });
	assert.equal((await now()).step, "待批准");
	const result = new Map<string, { sent: Submitted; done: boolean | null }>(),
		sent: string[] = [];
	const ops = listingOps(result, sent);
	await assert.rejects(publish(db, [id, "999999"], ops), (e: Error) => e instanceof Usage && /没有商品稿 999999\n一份都没做/.test(e.message));
	assert.deepEqual(sent, []);
	// 建商品结果未知：马上是建商品中，上架不做；再 publish 不收，x2 verify 核清，不重发
	result.set("建商品", { sent: { kind: "unknown", why: "超时" }, done: null });
	const r1 = await publish(db, [id], ops);
	assert.deepEqual(
		r1.ran.map((x) => [x.op, x.status]),
		[
			["建商品", "结果未知"],
			["上架", "未执行"],
		],
	);
	assert.deepEqual(sent, [`建商品 ${id}`]);
	const unknown = await now();
	assert.equal(unknown.step, "建商品中");
	assert.match(unknown.step_detail, /建商品：结果未知/);
	await assert.rejects(publish(db, [id], ops), (e: Error) => e instanceof Usage && /建商品中/.test(e.message));
	assert.equal((await run(db, {}, ops)).ran[0]!.status, "结果未知");
	// 读回来做成了：建好了没上架，是待上架；publish 接着上架
	result.delete("建商品");
	await run(db, {}, ops);
	assert.equal((await now()).step, "待上架");
	await publish(db, [id], ops);
	assert.deepEqual([(await now()).step, sent], ["已上架", [`建商品 ${id}`, `上架 ${id}`]]);
});

test("x2 listing publish：被拒的原因写进说明，改好了再 publish 照样交（防重复的 key 加次数）；商品稿在交之后改了不建", {
	skip,
}, async () => {
	const db = sql!;
	const id = await readyListing(db, "81");
	const result = new Map<string, { sent: Submitted; done: boolean | null }>(),
		sent: string[] = [];
	const ops = listingOps(result, sent);
	const now = async () => ({ ...(await db`select step, step_detail from listings where id = ${id}`)[0] });
	result.set("建商品", { sent: { kind: "refused", why: "10004 校验失败" }, done: false });
	const r = await publish(db, [id], ops);
	assert.deepEqual(
		r.ran.map((x) => [x.op, x.status]),
		[
			["建商品", "被拒"],
			["上架", "未执行"],
		],
	);
	const refused = await now();
	assert.equal(refused.step, "待批准");
	assert.match(refused.step_detail, /^上次建商品被拒：10004 校验失败/);
	result.delete("建商品");
	await publish(db, [id], ops);
	assert.equal((await now()).step, "已上架");
	const keys = (await db`select key, status from writes where params->>'listingId' = ${id} order by id`).map((x) => [x.key, x.status]);
	assert.deepEqual(keys, [
		[`建商品:${id}`, "被拒"],
		[`上架:${id}`, "未执行"],
		[`建商品:${id}#2`, "已核对"],
		[`上架:${id}#2`, "已核对"],
	]);
});

test("备注：x2 status 的 todo 给出人新写、改过的备注；x2 listing noted 记下看过的，备注再改又出来；人写的备注不改", {
	skip,
}, async () => {
	const db = sql!;
	const id = await readyListing(db, "82");
	const notes = async () => ((await check(db)).todo.find((x) => x.kind === "备注") as any)?.items.filter((x: any) => x.id === id) ?? [];
	assert.deepEqual(await notes(), []);
	await db`update listings set note = '标题别写「成人」' where id = ${id}`;
	assert.deepEqual(
		(await notes()).map((x: any) => x.note),
		["标题别写「成人」"],
	);
	const r = await listing(["noted", "--ids", id]);
	assert.deepEqual(
		r.map((x: any) => x.note),
		["标题别写「成人」"],
	);
	assert.deepEqual(await notes(), []);
	await db`update listings set note = '标题别写「成人」，也别写「連身」' where id = ${id}`;
	assert.equal((await notes()).length, 1);
	assert.equal((await db`select note from listings where id = ${id}`)[0]!.note, "标题别写「成人」，也别写「連身」");
	await assert.rejects(listing(["noted", "--ids", "999999"]), Usage);
	// 提醒：待批准的一家店一行，没有待批准的就不提醒
	const review = async () => (await check(db)).reminders.filter((x) => x.key === "listing-review:cheeroutdoor");
	assert.equal((await review()).length, 1);
	await db`update listings set cancelled = true where step = '待批准'`;
	assert.deepEqual(await review(), []);
});

test("x2 listing cancel：替人勾「放弃」，马上是已放弃；建了商品的要下架、建商品还没核清的先核清，有一份不行就都不勾；放弃了的不 publish", {
	skip,
}, async () => {
	const db = sql!;
	const [a, b, d] = [await readyListing(db, "83"), await readyListing(db, "84"), await readyListing(db, "86")];
	const now = async (id: string) => ({ ...(await db`select step, cancelled from listings where id = ${id}`)[0] });
	await assert.rejects(listing(["cancel"]), Usage);
	await assert.rejects(listing(["cancel", "--ids", a, "--why", " "]), Usage);
	// 建了商品的：要下架，不是放弃；有一份不行就都不勾
	await db`update listings set product_id = '9002' where id = ${b}`;
	await assert.rejects(
		listing(["cancel", "--ids", `${a},${b}`]),
		(e: Error) => e instanceof Usage && /（商品 9002，下架）：不上架就不 publish，不是放弃\n一份都没放弃$/.test(e.message),
	);
	await db`update listings set listed_at = now() where id = ${b}`;
	await assert.rejects(listing(["cancel", "--ids", b]), (e: Error) => e instanceof Usage && /已上架（商品 9002）：不卖了是下架，不是放弃/.test(e.message));
	await assert.rejects(listing(["cancel", "--ids", `${a},999999`]), (e: Error) => e instanceof Usage && /没有商品稿 999999/.test(e.message));
	assert.equal((await now(a)).cancelled, false);
	// 放弃：马上是已放弃，publish 不收；原因只回显
	const r = await listing(["cancel", "--ids", a, "--why", "和 ni1206 撞货"]);
	assert.deepEqual(
		r.map((x: any) => [x.id, x.step, x.already, x.why]),
		[[a, "已放弃", false, "和 ni1206 撞货"]],
	);
	assert.deepEqual(await now(a), { step: "已放弃", cancelled: true });
	await assert.rejects(publish(db, [a], listingOps(new Map(), [])), (e: Error) => e instanceof Usage && /已放弃/.test(e.message));
	// 再放弃一次：说一声，不算错
	assert.deepEqual(
		(await listing(["cancel", "--ids", a])).map((x: any) => x.already),
		[true],
	);
	// 建商品提交了、还没核清：可能已经建了，先核清；人核清了（没建成）才放弃得了
	const [w] =
		await db`insert into writes (batch, op, target, params, display, key, status) values (997, '建商品', 't:86', ${db.json({ listingId: d })}, '建商品', 'create:86', '结果未知') returning id::text`;
	await assert.rejects(
		listing(["cancel", "--ids", d]),
		(e: Error) => e instanceof Usage && /在建商品中（建商品：结果未知）：可能已经建了，先核清/.test(e.message),
	);
	await resolve(["--id", "999999", "--status", "被拒"]).then(
		() => assert.fail("没有这个写入也收了"),
		(e: Error) => assert.ok(e instanceof Usage),
	);
	await resolve(["--id", w!.id, "--status", "被拒"]);
	assert.deepEqual(
		(await listing(["cancel", "--ids", d])).map((x: any) => x.step),
		["已放弃"],
	);
});

test("x2 listing category：人定的类目要是叶子、在本店允许的类目里；写路径、名字，清掉属性、备货天数和类目的问题，马上是待做商品稿；建了商品的不改", {
	skip,
}, async () => {
	const db = sql!;
	const id = await readyListing(db, "87");
	const tree = async () => [
		{
			id: "100630",
			name: "居家生活",
			children: [
				{
					id: "100721",
					name: "浴室用品",
					children: [
						{ id: "101324", name: "地墊", children: [] },
						{ id: "101325", name: "浴簾", children: [] },
					],
				},
			],
		},
	];
	const now = async () => ({
		...(
			await db`select category_path, category_id::text, category_name, attributes, attributes_text, days_to_ship, problems, step from listings where id = ${id}`
		)[0],
	});
	await assert.rejects(setCategory(db, "999999", "101324", tree), (e: Error) => e instanceof Usage && /没有商品稿 999999/.test(e.message));
	await assert.rejects(
		setCategory(db, id, "100721", tree),
		(e: Error) => e instanceof Usage && /不是叶子类目，选它下面的：地墊（101324）、浴簾（101325）/.test(e.message),
	);
	await assert.rejects(setCategory(db, id, "1", tree), (e: Error) => e instanceof Usage && /类目树里没有类目 1/.test(e.message));
	await db`update shop_settings set categories = ${db.json(["101324"])} where shop = 'cheeroutdoor'`;
	await assert.rejects(
		setCategory(db, id, "101325", tree),
		(e: Error) => e instanceof Usage && /「居家生活 > 浴室用品 > 浴簾」不在 cheeroutdoor 允许的类目里/.test(e.message),
	);
	assert.equal((await now()).category_name, null);
	// 做商品稿记的类目、属性的问题不算了，照新的类目重做商品稿
	await db`update listings set problems = ${"类目：推荐的「雨衣」不在本店允许的类目里\n属性：必填的「材質」待人工填写"} where id = ${id}`;
	const r = await setCategory(db, id, "101324", tree);
	assert.deepEqual([r.category, r.categoryPath, r.step], ["居家生活 > 浴室用品 > 地墊", [100630, 100721, 101324], "待做商品稿"]);
	assert.deepEqual(await now(), {
		category_path: [100630, 100721, 101324],
		category_id: "101324",
		category_name: "居家生活 > 浴室用品 > 地墊",
		attributes: null,
		attributes_text: null,
		days_to_ship: null,
		problems: null,
		step: "待做商品稿",
	});
	// 别的问题照旧：还是待补充
	await db`update shop_settings set categories = null where shop = 'cheeroutdoor'`;
	await db`update listings set problems = ${"货源：起订量 2，无法单件购买\n备货天数：无法读取这个类目的备货天数规则"} where id = ${id}`;
	const again = await setCategory(db, id, "101325", tree);
	assert.deepEqual([again.before, again.step, (await now()).problems], ["居家生活 > 浴室用品 > 地墊", "待补充", "货源：起订量 2，无法单件购买"]);
	// 建了商品的不改
	await db`update listings set product_id = '9003' where id = ${id}`;
	await assert.rejects(setCategory(db, id, "101324", tree), (e: Error) => e instanceof Usage && /已经建了商品（商品 9003）：不改类目/.test(e.message));
	assert.equal((await now()).category_name, "居家生活 > 浴室用品 > 浴簾");
});

/** 一份做好了的商品稿：顏色（黑貓、黃狗、定製）× 尺寸（40*60、60*90），货号 LT<货源>-<各层下标> */
async function madeListing(db: postgres.Sql, offerId: string) {
	const specs = {
		tiers: [
			{
				source: "颜色",
				name: "顏色",
				options: [
					["黑猫", "黑貓"],
					["黄狗", "黃狗"],
					["定制", "定製"],
				].map(([source, name]) => ({ source, name, image: null })),
			},
			{
				source: "尺寸",
				name: "尺寸",
				options: [
					{ source: "40*60", name: "40*60" },
					{ source: "60*90", name: "60*90" },
				],
			},
		],
		variants: [0, 1, 2]
			.flatMap((a) => [0, 1].map((b) => [a, b]))
			.map((c) => ({
				sku: `LT${offerId}-${c.join("")}`,
				skuId: c.join(""),
				specId: c.join(""),
				options: c,
				costRmb: 1,
				stock: 9,
				weightKg: 0.3,
				priceTwd: 133,
			})),
	};
	const [l] =
		await db`insert into listings (shop, offer_id, offer, variants) values ('cheeroutdoor', ${offerId}, ${db.json({ offerId, props: [], skus: [] })}, ${db.json(specs)}) returning id::text`;
	return { id: l!.id as string, specs };
}

test("x2 listing drop：按结构去掉整个选项，货号记进已移除的规格；去掉单个规格会让组合不齐时不做", { skip }, async () => {
	const db = sql!;
	const { id } = await madeListing(db, "3");
	assert.deepEqual(await listing(["drop", "--id", id, "--specs", "定製"]), {
		id,
		name: `货源 3（cheeroutdoor，#${id}）`,
		dropped: ["LT3-20", "LT3-21"],
		left: 4,
		merged: false,
		recheck: false,
	});
	const [dropped] = await db`select variants, removed_variants from listings where id = ${id}`;
	assert.deepEqual(
		[dropped!.removed_variants, dropped!.variants.tiers[0].options.map((o: any) => o.name)],
		[
			["LT3-20", "LT3-21"],
			["黑貓", "黃狗"],
		],
	);
	// 去掉单个规格会让两层的组合不齐：不做，库里不变
	await assert.rejects(listing(["drop", "--id", id, "--specs", "LT3-00"]), (e: Error) => e instanceof Usage && /组合不齐/.test(e.message));
	const [same] = await db`select removed_variants from listings where id = ${id}`;
	assert.deepEqual(same!.removed_variants, ["LT3-20", "LT3-21"]);
});

test("x2 listing text：规格名交得不对（重名、层数不对）什么都不存，标题、描述也不存", { skip }, async () => {
	const db = sql!;
	const { id, specs } = await madeListing(db, "4");
	const text = (tiers: unknown) =>
		listing(["text", "--id", id, "--title", "矽藻土地墊 可愛貓咪造型 防滑吸水 浴室門口", "--description", "商品介紹", "--tiers", JSON.stringify(tiers)]);
	const tiers = [
		{ name: "款式", options: ["黑貓", "黑貓", "定製"] },
		{ name: "尺寸", options: ["40×60cm", "60×90cm"] },
	];
	const dup = await text(tiers);
	assert.deepEqual([dup.text[0].saved, dup.audit], [false, []]);
	assert.match(dup.text[0].problems.join(), /第 1 层「款式」的第 1、2 个选项都叫「黑貓」/);
	assert.match((await text(tiers.slice(0, 1))).text[0].problems.join(), /要 2 层（照 x2 listing show），交了 1 层/);
	const [row] = await db`select title, description, variants from listings where id = ${id}`;
	assert.deepEqual([row!.title, row!.description, row!.variants], [null, null, specs]);
});

test("x2 listing keep：按图的名字找图，x2 去掉的放回来、记进保留的图；人删的不放回来", { skip }, async () => {
	const db = sql!;
	const pic = (id: string, extra: object = {}) => ({ from: `${id}.jpg`, imageId: id, width: 800, height: 800, ...extra });
	const images = { main: [pic("m1"), pic("m2", { drop: "Gemini 文字检查：「质量」" })], detail: [pic("d1"), pic("d2")], options: [] };
	const [l] =
		await db`insert into listings (shop, offer_id, images, removed_images) values ('cheeroutdoor', '5', ${db.json(images)}, ${db.json(["d1"])}) returning id::text`;
	const id = l!.id as string;
	await assert.rejects(listing(["keep", "--id", id, "--images", "详情图 1"]), (e: Error) => e instanceof Usage && /详情图 1是人删的/.test(e.message));
	await assert.rejects(
		listing(["keep", "--id", id, "--images", "主图 9"]),
		(e: Error) => e instanceof Usage && /没有主图 9（有：主图 1、主图 2、详情图 1、详情图 2）/.test(e.message),
	);
	const r = await listing(["keep", "--id", id, "--images", "主图 2,详情图2"]);
	assert.deepEqual([r.kept, r.restored, r.audit[0].checked], [["主图 2", "详情图 2"], ["主图 2"], false]);
	const [now] = await db`select images, kept_images from listings where id = ${id}`;
	assert.deepEqual([now!.images.main[1].drop, now!.kept_images], [undefined, ["m2", "d2"]]);
});

test("x2 listing estimate：只填空着的「重量」「国内运费」，人填过的不动；写完马上重新核价，人改了也照着重算", {
	skip,
}, async () => {
	const db = sql!;
	const specs = {
		tiers: [
			{
				source: "颜色",
				name: "顏色",
				options: [
					{ source: "黑猫", name: "黑貓", image: null },
					{ source: "白猫", name: "白貓", image: null },
				],
			},
		],
		variants: [0, 1].map((k) => ({
			sku: `LT6-${k}`,
			skuId: `${k}`,
			specId: `${k}`,
			options: [k],
			costRmb: 10,
			stock: 9,
			weightKg: k ? null : 0.3,
			priceTwd: null,
		})),
	};
	const offer = {
		offerId: "6",
		title: "猫咪地垫",
		props: [],
		skus: [
			{ skuId: "0", attrs: ["黑猫"], weightKg: 0.3 },
			{ skuId: "1", attrs: ["白猫"] },
		],
		tags: { freeShipping: false },
	};
	const [l] =
		await db`insert into listings (shop, offer_id, offer, variants, pricing) values ('cheeroutdoor', '6', ${db.json(offer)}, ${db.json(specs)}, ${db.json({ freightRmb: null })}) returning id::text`;
	const id = l!.id as string;
	await assert.rejects(listing(["estimate", "--id", id, "--weight", "0"]), Usage);
	await assert.rejects(listing(["estimate", "--id", id]), Usage);
	const r = await listing(["estimate", "--id", id, "--weight", "1", "--freight", "10"]);
	assert.deepEqual([r.notes, r.needs, r.problems], [["重量：记为 1 kg", "国内运费：记为 10 元/件"], [], []]);
	const [now] = await db`select weight_kg, freight_rmb, variants, pricing from listings where id = ${id}`;
	assert.deepEqual([Number(now!.weight_kg), Number(now!.freight_rmb), now!.pricing.freightRmb], [1, 10, 10]);
	assert.deepEqual(
		now!.variants.variants.map((v: any) => v.weightKg),
		[0.3, 1],
	);
	assert.ok(now!.variants.variants.every((v: any) => v.priceTwd > 0));
	// 人在网页上改成 0.8：agent 再估也不改；照人改的重新核价
	await db`update listings set weight_kg = 0.8 where id = ${id}`;
	const again = await listing(["estimate", "--id", id, "--weight", "2"]);
	assert.deepEqual(again.notes, ["重量：已有 0.8 kg（人填的或估过的），不改"]);
	const [kept] = await db`select weight_kg, variants from listings where id = ${id}`;
	assert.deepEqual([Number(kept!.weight_kg), kept!.variants.variants.map((v: any) => v.weightKg)], [0.8, [0.3, 0.8]]);
	// 人又改成 0.9：下一次 x2 status 的检查就重新核价
	await db`update listings set weight_kg = 0.9 where id = ${id}`;
	await check(db);
	const [checked] = await db`select variants, step, step_detail from listings where id = ${id}`;
	assert.deepEqual(
		checked!.variants.variants.map((v: any) => v.weightKg),
		[0.3, 0.9],
	);
});

test("x2 listing text 交简称：简体、最多 12 字，不对就什么都不存；只在空着、还是自动填的时候写，人改过的不改", {
	skip,
}, async () => {
	const db = sql!;
	const { id } = await madeListing(db, "7");
	await db`update listings set offer = offer || ${db.json({ title: "浴水生财猫咪浴室地垫硅藻泥卫生间门口防滑脚垫" })}, nickname = '浴水生财猫咪浴室地垫硅藻' where id = ${id}`;
	const text = (nickname: string) =>
		listing(["text", "--id", id, "--title", "矽藻土地墊 可愛貓咪造型 防滑吸水 浴室門口", "--description", "商品介紹", "--nickname", nickname]);
	const bad = await text("浴水生財貓狗地墊");
	assert.deepEqual([bad.text[0].saved, bad.text[0].problems], [false, ["简称「浴水生財貓狗地墊」有繁体字，要用简体中文（浴水生财猫狗地垫）"]]);
	const ok = await text("浴水生财猫狗地垫");
	assert.deepEqual([ok.text[0].saved, ok.text[0].name], [true, `浴水生财猫狗地垫（cheeroutdoor，#${id}）`]);
	// 人在网页上改了：agent 再交也不改，说一声
	await db`update listings set nickname = '猫咪地垫' where id = ${id}`;
	const again = await text("可爱猫狗地垫");
	assert.deepEqual([again.text[0].saved, again.text[0].notes], [true, ["简称：已有「猫咪地垫」，不改（只在空着、还是自动填的时候写）"]]);
	const [row] = await db`select nickname, title from listings where id = ${id}`;
	assert.deepEqual([row!.nickname, row!.title], ["猫咪地垫", "矽藻土地墊 可愛貓咪造型 防滑吸水 浴室門口"]);
});
