// 连库的测试：x2 do → 执行 → 结果未知停下 → 核清；商品稿 publish、提醒、网页。用 X2_TEST_DATABASE_URL 指的库（会清空它的 public schema），没设就跳过
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import postgres from "postgres";
import { z } from "zod";
import { TOOLKITS } from "../bin/toolkits.ts";
import { runTool } from "../platform/cli.ts";
import { platform } from "../platform/commands.ts";
import { close, migrate } from "../platform/db/index.ts";
import { Usage } from "../platform/errors.ts";
import { status } from "../platform/status.ts";
import { register, type Toolkit } from "../platform/tool.ts";
import { serve } from "../platform/web/server.ts";
import { createSession, push, showSession } from "../platform/web/sessions.ts";
import { perform, run, type Submitted, type WriteOp } from "../platform/writes.ts";
import { auditKey } from "../skills/listing/audit.ts";
import { listing as listingKit, publishPlan, setCategory } from "../skills/listing/index.ts";
import { settingsOf } from "../skills/listing/pricing.ts";
import { productOf } from "../skills/listing/ready.ts";
import { listingsCheck } from "../skills/listing/status.ts";
import { orders } from "../skills/orders/index.ts";
import type { Reads } from "../skills/orders/read.ts";
import { setException } from "../skills/orders/source.ts";
import { ordersCheck } from "../skills/orders/status.ts";
import { selection } from "../skills/selection/index.ts";

const url = process.env.X2_TEST_DATABASE_URL;
const sql = url ? postgres(url, { onnotice: () => {}, max: 2 }) : null;

// 一个假的写操作：n 是对象；outcome 决定提交和读回来的结果
const outcome = new Map<number, { sent: Submitted; done: boolean | null }>();
const submitted: number[] = [];
const fake: WriteOp<{ n: number }> = {
	describe: "试写",
	params: z.object({ n: z.number() }),
	target: (p) => `t:${p.n}`,
	key: (p) => `k:${p.n}`,
	display: (p) => `第 ${p.n} 项`,
	where: (_sql, _p, fn) => fn(),
	prepare: async (_sql, p) => ({ params: p, before: { n: p.n } }),
	submit: async (_sql, p) => {
		submitted.push(p.n);
		return outcome.get(p.n)?.sent ?? { kind: "done" };
	},
	check: async (p) => ({ done: outcome.has(p.n) ? outcome.get(p.n)!.done : true, readback: { n: p.n } }),
};
const ops = { 试写: fake };

/** 这一轮现读的结果（假的）：只读了 chanboss 订单 */
const reads = (): Reads => ({ cart: [], purchases: [], accounts: new Map(), buyAccount: null, results: [{ what: "订单", who: "chanboss", ok: true }] });
// 订单的检查用假的现读（不碰站点）；假的写操作「试写」也注册进引擎
register({ ...orders, check: (sql) => ordersCheck(sql, reads()) }, { name: "test", title: "试", kind: "skill", tools: {}, writes: ops }, ...TOOLKITS);
/** x2 status：问每个 skill 的检查 */
const check = async (db: postgres.Sql) => {
	const r = await status(db);
	return { reminders: r.human, todo: r.todo };
};
/** 交一批（skill 的写工具排好的）马上执行 */
const perform1 = (db: postgres.Sql, writes: { op: string; params: unknown }[], o: Record<string, WriteOp> = ops) => perform(db, [writes], {}, o);
const publish = async (db: postgres.Sql, ids: string[], o: Record<string, WriteOp>) => perform(db, await publishPlan(db, ids), {}, o);

before(async () => {
	if (!sql) return;
	await sql.unsafe("drop schema public cascade; create schema public");
	await migrate(sql);
});
after(async () => {
	await sql?.end();
	await close();
});

test("写入：x2 do 交的一批马上做；结果未知停下这一批（剩下的未执行），不重发；没核清的同一个对象不再做；x2 verify 核清", {
	skip: !sql && "没设 X2_TEST_DATABASE_URL",
}, async () => {
	const db = sql!;
	outcome.set(1, { sent: { kind: "unknown", why: "超时" }, done: null });
	const r1 = await perform1(db, [
		{ op: "试写", params: { n: 1 } },
		{ op: "试写", params: { n: 2 } },
	]);
	assert.equal(r1.unknown, true);
	assert.deepEqual(
		r1.ran.map((x) => [x.display, x.status]),
		[
			["第 1 项", "结果未知"],
			["第 2 项", "未执行"],
		],
	);
	assert.deepEqual(submitted, [1]);

	// 同一个对象还没核清：不再做
	await assert.rejects(perform1(db, [{ op: "试写", params: { n: 1 } }]), (e: Error) => e instanceof Usage && /还没核清/.test(e.message));

	// 核清：还看不出就还是结果未知，也不重发；提醒人去看
	assert.equal((await run(db, {}, ops)).ran[0]!.status, "结果未知");
	assert.deepEqual(submitted, [1]);
	const unknown = (await check(db)).reminders.filter((x) => x.kind === "结果未知");
	assert.equal(unknown.length, 1);

	// 读回来看到做成了：已核对；没做的第 2 项再交一次
	outcome.set(1, { sent: { kind: "unknown", why: "超时" }, done: true });
	assert.deepEqual(
		(await run(db, {}, ops)).ran.map((x) => [x.display, x.status]),
		[["第 1 项", "已核对"]],
	);
	assert.deepEqual(
		(await perform1(db, [{ op: "试写", params: { n: 2 } }])).ran.map((x) => [x.display, x.status]),
		[["第 2 项", "已核对"]],
	);
	assert.deepEqual(submitted, [1, 2]);
	assert.deepEqual(
		(await check(db)).reminders.filter((x) => x.kind === "结果未知"),
		[],
	);
});

test("写入：被拒的记下原因；同一个 key 被拒过的再交加次数", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	outcome.set(4, { sent: { kind: "refused", why: "库存不够" }, done: false });
	const r = await perform1(db, [{ op: "试写", params: { n: 4 } }]);
	assert.deepEqual(
		r.ran.map((x) => [x.display, x.status, x.why]),
		[["第 4 项", "被拒", "库存不够"]],
	);
	outcome.delete(4);
	await perform1(db, [{ op: "试写", params: { n: 4 } }]);
	const rows = await db`select key, status from writes where params->>'n' = '4' order by id`;
	assert.deepEqual(
		rows.map((x) => [x.key, x.status]),
		[
			["k:4", "被拒"],
			["k:4#2", "已核对"],
		],
	);
});

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

test("x2 listing publish：只收待批准、待上架的，马上建商品、上架、重算当前步骤；结果未知不重发；建商品、上架不经 x2 do", {
	skip: !sql && "没设 X2_TEST_DATABASE_URL",
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
	skip: !sql && "没设 X2_TEST_DATABASE_URL",
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
	skip: !sql && "没设 X2_TEST_DATABASE_URL",
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
	skip: !sql && "没设 X2_TEST_DATABASE_URL",
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
	skip: !sql && "没设 X2_TEST_DATABASE_URL",
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

test("提醒：每次 x2 status 现算；人说做完了（x2 handled）就不再提醒", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
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

test("规格例外：x2 source --spec 写进选用的货源那一行；两边都要对得上，同一个规格写过的换掉", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
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

/** 跑一个工具（命令行的参数），回它的输出（照 --json 的样子） */
async function tool(kit: Toolkit, args: string[]): Promise<any> {
	process.env.X2_DATABASE_URL = url!;
	const r = await runTool(kit, args);
	assert.ok("value" in r);
	return JSON.parse(JSON.stringify(r.value));
}
const listing = (args: string[]) => tool(listingKit, args);
const strategy = ([sub, ...args]: string[]) => tool(selection, [`strategy-${sub}`, ...args]);
const rule = ([sub, ...args]: string[]) => tool(selection, [`rule-${sub}`, ...args]);
const resolve = (args: string[]) => tool(platform, ["resolve", ...args]);
const handled = (args: string[]) => tool(platform, ["handled", ...args]);

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

test("x2 listing drop：按结构去掉整个选项，货号记进已移除的规格；去掉单个规格会让组合不齐时不做", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
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

test("x2 listing text：规格名交得不对（重名、层数不对）什么都不存，标题、描述也不存", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
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

test("x2 listing keep：按图的名字找图，x2 去掉的放回来、记进保留的图；人删的不放回来", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
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
	skip: !sql && "没设 X2_TEST_DATABASE_URL",
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
	skip: !sql && "没设 X2_TEST_DATABASE_URL",
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

test("x2 strategy：add 是第 1 版；set 要 --why，每次改版本号加 1、变更记录记改之前和改之后；没变的不加", {
	skip: !sql && "没设 X2_TEST_DATABASE_URL",
}, async () => {
	const db = sql!;
	assert.deepEqual(await strategy(["add", "--name", "搜索缺口", "--bet", "搜得多、卖的少", "--how", "知虾热搜词", "--why", "先试"]), {
		name: "搜索缺口",
		version: 1,
		bet: "搜得多、卖的少",
		how: "知虾热搜词",
		status: "试验中",
	});
	await assert.rejects(strategy(["set", "--name", "搜索缺口", "--how", "换个选法"]), (e: Error) => e instanceof Usage && /--why/.test(e.message));
	await assert.rejects(strategy(["set", "--name", "搜索缺口", "--why", "没说改什么"]), Usage);
	const set = await strategy(["set", "--name", "搜索缺口", "--how", "热搜词，剔掉 NT$1 的", "--status", "使用中", "--why", "NT$1 的是客製化链接"]);
	assert.deepEqual([set.version, set.before, set.after], [2, { status: "试验中", how: "知虾热搜词" }, { status: "使用中", how: "热搜词，剔掉 NT$1 的" }]);
	// 和现在一样：不加版本号、不记
	assert.deepEqual(await strategy(["set", "--name", "搜索缺口", "--status", "使用中", "--why", "再说一遍"]), { name: "搜索缺口", version: 2, changed: false });
	const log = await strategy(["log", "--name", "搜索缺口"]);
	assert.deepEqual(
		log.changes.map((c: any) => [c.version, c.before, c.after, c.why]),
		[
			[1, null, { status: "试验中", bet: "搜得多、卖的少", how: "知虾热搜词" }, "先试"],
			[2, { status: "试验中", how: "知虾热搜词" }, { status: "使用中", how: "热搜词，剔掉 NT$1 的" }, "NT$1 的是客製化链接"],
		],
	);
	const list = await strategy(["list"]);
	assert.equal(list.find((r: any) => r.name === "搜索缺口").version, 2);
	const [row] = await db`select version, how, status from strategies where name = '搜索缺口'`;
	assert.deepEqual({ ...row }, { version: 2, how: "热搜词，剔掉 NT$1 的", status: "使用中" });
});

test("x2 rule：add、retire 要 --why；停用的不删，写结束时间和停用原因；list 默认只列在用的", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	await assert.rejects(rule(["add", "--rule", "起订量 1"]), Usage);
	const a = await rule(["add", "--rule", "1688 一件代发、48 小时发货、起订量 1", "--why", "不压货"]);
	const b = await rule(["add", "--rule", "售价不超过 NT$500", "--why", "先做低价"]);
	await assert.rejects(rule(["retire", "--id", b.id]), Usage);
	const retired = await rule(["retire", "--id", b.id, "--why", "限制太死"]);
	assert.deepEqual([retired.retire_why, Boolean(retired.ended_at)], ["限制太死", true]);
	await assert.rejects(rule(["retire", "--id", b.id, "--why", "再停一次"]), (e: Error) => e instanceof Usage && /已经停用/.test(e.message));
	assert.deepEqual(
		(await rule(["list"])).map((r: any) => r.id),
		[a.id],
	);
	assert.deepEqual(
		(await rule(["list", "--all"])).map((r: any) => [r.id, r.ended_at === null]),
		[
			[a.id, true],
			[b.id, false],
		],
	);
	const [kept] = await db`select rule, why, retire_why from selection_rules where id = ${b.id}`;
	assert.deepEqual({ ...kept }, { rule: "售价不超过 NT$500", why: "先做低价", retire_why: "限制太死" });
});

test("x2 listing add：按策略选的要 --why；记下选品理由、依据和当时的策略、在用的选品规矩；x2 listing why 补记", {
	skip: !sql && "没设 X2_TEST_DATABASE_URL",
}, async () => {
	const db = sql!;
	await strategy(["add", "--name", "季节", "--bet", "换季", "--how", "看月份"]);
	await strategy(["set", "--name", "季节", "--bet", "换季前一个月", "--why", "要提前"]);
	await db`update selection_rules set ended_at = now() where ended_at is null`;
	const [r1] = await db`insert into selection_rules (rule, why) values ('起订量 1', '不压货') returning id::text`;
	await db`insert into selection_rules (rule, why, ended_at) values ('停了的', '试试', now())`;
	await assert.rejects(
		listing(["add", "--shop", "cheeroutdoor", "--links", "901", "--strategy", "季节"]),
		(e: Error) => e instanceof Usage && /--why 必填/.test(e.message),
	);
	const added = await listing([
		"add",
		"--shop",
		"cheeroutdoor",
		"--links",
		"901,902",
		"--strategy",
		"季节",
		"--why",
		"冬天到了",
		"--evidence",
		"暖桌搜索量 2 万",
	]);
	assert.deepEqual(
		added.map((a: any) => [a.offerId, a.isNew, a.why, a.evidence]),
		[
			["901", true, "冬天到了", "暖桌搜索量 2 万"],
			["902", true, "冬天到了", "暖桌搜索量 2 万"],
		],
	);
	const [l] = await db`select strategy, pick_why, pick_evidence, pick_snapshot from listings where id = ${added[0].id}`;
	const { at, ...snap } = l!.pick_snapshot;
	assert.ok(Math.abs(Date.parse(at) - Date.now()) < 60_000);
	assert.deepEqual(snap, {
		backfilled: false,
		strategy: { name: "季节", version: 2, bet: "换季前一个月", how: "看月份", status: "试验中" },
		rules: [{ id: r1!.id, rule: "起订量 1" }],
	});
	// 以后策略改了：加进来时的快照不变
	await strategy(["set", "--name", "季节", "--how", "看节气", "--why", "更准"]);
	const [same] = await db`select pick_snapshot from listings where id = ${added[0].id}`;
	assert.equal(same!.pick_snapshot.strategy.version, 2);
	// 已经有的再加：理由、快照不改
	const again = await listing(["add", "--shop", "cheeroutdoor", "--links", "901", "--strategy", "季节", "--why", "另一个理由"]);
	assert.deepEqual([again[0].isNew, again[0].why], [false, "冬天到了"]);
	// 人选的不用 --why
	const human = await listing(["add", "--shop", "cheeroutdoor", "--links", "903"]);
	assert.deepEqual([human[0].why, human[0].snapshot.strategy.name], [null, "人选"]);

	// 补记：没有快照的照现在补一份，标明补记；已有理由的要 --force
	const [old] = await db`insert into listings (shop, offer_id, strategy) values ('cheeroutdoor', '904', '季节') returning id::text`;
	await assert.rejects(listing(["why", "--id", old!.id]), Usage);
	const w = await listing(["why", "--id", old!.id, "--why", "补的理由", "--evidence", "当时的数据"]);
	assert.deepEqual(
		[w.why, w.evidence, w.backfilled, w.replaced, w.snapshot.backfilled, w.snapshot.strategy.version],
		["补的理由", "当时的数据", true, false, true, 3],
	);
	await assert.rejects(listing(["why", "--id", old!.id, "--why", "改一下"]), (e: Error) => e instanceof Usage && /--force/.test(e.message));
	const forced = await listing(["why", "--id", old!.id, "--why", "改一下", "--force"]);
	assert.deepEqual([forced.why, forced.evidence, forced.replaced, forced.backfilled, forced.snapshot.at], ["改一下", "当时的数据", true, false, w.snapshot.at]);
	// 人选的、加进来时有快照的：补理由，快照不动
	const h = await listing(["why", "--id", human[0].id, "--why", "运营贴的"]);
	assert.deepEqual([h.backfilled, h.snapshot.backfilled, h.snapshot.at], [false, false, human[0].snapshot.at]);
});

test("网页：只收人能改的格，照类型和条件收；删图记进已删除的图；表单添一行", { skip: !sql && "没设 X2_TEST_DATABASE_URL" }, async () => {
	const db = sql!;
	const { port, stop } = await serve(db, { host: "127.0.0.1", port: 0, dist: "/nonexistent" });
	const call = async (method: string, body?: unknown, path = "/api/rows") => {
		const r = await fetch(`http://127.0.0.1:${port}${path}`, {
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: r.status, body: (await r.json()) as any };
	};
	const set = (table: string, key: Record<string, string>, col: string, value: unknown) => call("PATCH", { table, key, col, value });
	try {
		const meta = (await call("GET", undefined, "/api/meta")).body as any[];
		const listing = meta.find((m) => m.name === "listings");
		assert.deepEqual(
			listing.columns.filter((c: any) => ["cancelled", "pics", "step"].includes(c.name)).map((c: any) => [c.name, c.type, Boolean(c.edit)]),
			[
				["step", "text", false],
				["pics", "pics", true],
				["cancelled", "bool", true],
			],
		);

		// 不是人改的列、条件不成立的行：不收
		const [l] = await db`insert into listings (shop, offer_id, images, step) values ('cheeroutdoor', '777901', ${db.json({
			main: [
				{ from: "a.jpg", imageId: "m1", width: 800, height: 800 },
				{ from: "b.jpg", imageId: "m2", width: 800, height: 800 },
			],
			detail: [],
			options: [],
		})}, '待写文案') returning id::text`;
		const key = { id: l!.id as string };
		assert.equal((await set("listings", key, "step", "已上架")).status, 400);
		// 照类型收：重量是数，空的是 null
		assert.equal((await set("listings", key, "weight_kg", "很重")).status, 400);
		assert.equal((await set("listings", key, "weight_kg", 0.8)).body.weight_kg, 0.8);
		assert.equal((await set("listings", key, "note", "")).body.note, null);

		// 删图、放回：记进、移出已删除的图；规格图、没有的图不收
		const removed = await set("listings", key, "pics", { id: "m1", removed: true });
		assert.deepEqual(
			removed.body.pics.map((p: any) => [p.label, p.state]),
			[
				["主图 1", "removed"],
				["主图 2", "used"],
			],
		);
		assert.deepEqual((await db`select removed_images from listings where id = ${key.id}`)[0]!.removed_images, ["m1"]);
		assert.equal((await set("listings", key, "pics", { id: "nope", removed: true })).status, 400);
		await set("listings", key, "pics", { id: "m1", removed: false });
		assert.deepEqual((await db`select removed_images from listings where id = ${key.id}`)[0]!.removed_images, []);

		// 条件不成立的行：建了商品的不能勾「放弃」
		await db`update listings set product_id = '9009' where id = ${key.id}`;
		assert.match((await set("listings", key, "cancelled", true)).body.error, /现在不能改「放弃」/);
		assert.deepEqual((await set("listings", key, "note", "明天再看")).body._readonly.includes("cancelled"), true);

		// 库里的约束：说原话
		assert.match((await set("shop_settings", { shop: "cheeroutdoor" }, "fx", -1)).body.error, /fx_check/);
		assert.equal((await set("shop_settings", { shop: "cheeroutdoor" }, "watermark_position", "左边")).status, 400);

		// 写入：结果未知的才能改成已核对、被拒
		const [wr] = await db`insert into writes (batch, op, target, params, key, status) values (99, '加购', 't', '{}', 'k99', '成功') returning id::text`;
		assert.equal((await set("writes", { id: wr!.id }, "status", "已核对")).status, 400);
		await db`update writes set status = '结果未知' where id = ${wr!.id}`;
		assert.equal((await set("writes", { id: wr!.id }, "status", "已核对")).body.status, "已核对");

		// 选用：一个商品只用一个货源
		await db`insert into sources (item_id, offer_id, chosen) values ('W1', 'a', true), ('W1', 'b', false)`;
		await set("sources", { item_id: "W1", offer_id: "b" }, "chosen", true);
		assert.deepEqual(
			(await db`select offer_id from sources where item_id = 'W1' and chosen`).map((r) => r.offer_id),
			["b"],
		);

		// 表单：必填的要填；添加货源认 1688 链接
		assert.match((await call("POST", { table: "arrival_issues", values: { item: "红T L" } })).body.error, /要填「订单号」/);
		const issue = await call("POST", { table: "arrival_issues", values: { sn: "S1", kind: "少件", qty: "2" } });
		assert.deepEqual(
			(await db`select sn, kind, qty from arrival_issues where id = ${issue.body.key.id}`).map((r) => ({ ...r })),
			[{ sn: "S1", kind: "少件", qty: 2 }],
		);
		const added = await call("POST", { table: "listings", values: { shop: "ni1206", offer_id: "https://detail.1688.com/offer/123456.html" } });
		assert.deepEqual(
			(await db`select shop, offer_id, strategy from listings where id = ${added.body.key}`).map((r) => ({ ...r })),
			[{ shop: "ni1206", offer_id: "123456", strategy: "人选" }],
		);
	} finally {
		await stop();
	}
});

test("会话：push 照组件的参数校验，说哪一格不对；interactive 的同一个引用换掉不另开；网页按引用筛行，人能关掉右边的 tab", {
	skip: !sql && "没设 X2_TEST_DATABASE_URL",
}, async () => {
	const db = sql!;
	const s = await createSession(db, "试会话");
	await assert.rejects(push(db, s.id, { component: "nope", props: {} }), (e: Error) => e instanceof Usage && /没有组件 nope/.test(e.message));
	await assert.rejects(
		push(db, s.id, { component: "chart", props: { type: "pie", data: [{ d: "一", n: 1 }], x: "zz", y: ["n", "m"] } }),
		(e: Error) => e instanceof Usage && /x：data 里没有 x 这一列；y：pie 只画一列/.test(e.message),
	);
	await assert.rejects(
		push(db, s.id, { component: "datagrid", props: { table: "listings", filter: { title_secret: "x" } } }),
		(e: Error) => e instanceof Usage && /不能按「title_secret」筛/.test(e.message),
	);
	await assert.rejects(
		push(db, "999999", { component: "markdown", props: { text: "hi" } }),
		(e: Error) => e instanceof Usage && /没有会话 999999/.test(e.message),
	);
	await push(db, s.id, { component: "markdown", props: { text: "hi" } });
	const ref = { table: "listings", view: "全部", filter: { shop: "ni1206" } };
	const a = await push(db, s.id, { component: "datagrid", props: ref });
	const b = await push(db, s.id, { component: "datagrid", props: { ...ref, title: "ni1206 的商品稿" } });
	assert.deepEqual([a.replaced, b.replaced, b.id], [false, true, a.id]);
	// 筛几列：键的先后、一个值写不写成数组都算同一个引用（jsonb 会重排键）
	const c = await push(db, s.id, { component: "datagrid", props: { table: "listings", filter: { step: "待批准", shop: ["ni1206"] } } });
	const d = await push(db, s.id, { component: "datagrid", props: { table: "listings", filter: { shop: "ni1206", step: ["待批准"] } } });
	assert.deepEqual([c.replaced, d.replaced, d.id], [false, true, c.id]);
	await db`delete from session_items where id = ${c.id}`;
	const shown = await showSession(db, s.id);
	assert.deepEqual(
		shown.items.map((i) => i.component),
		["markdown", "datagrid"],
	);

	const [l] = await db`insert into listings (shop, offer_id) values ('ni1206', '777950') returning id::text`;
	const { port, stop } = await serve(db, { host: "127.0.0.1", port: 0, dist: "/nonexistent" });
	try {
		const get = async (path: string) => {
			const r = await fetch(`http://127.0.0.1:${port}${path}`);
			return { status: r.status, body: (await r.json()) as any };
		};
		const rows = await get(`/api/rows?table=listings&view=全部&filter=${encodeURIComponent(JSON.stringify(ref.filter))}`);
		assert.ok(rows.body.length >= 1 && rows.body.every((r: any) => r.shop === "ni1206"));
		assert.ok(rows.body.some((r: any) => r._key.id === l!.id));
		assert.equal((await get(`/api/rows?table=listings&filter=${encodeURIComponent('{"title_secret":"x"}')}`)).status, 400);
		assert.equal((await get(`/api/session?id=${s.id}`)).body.items.length, 2);
		await fetch(`http://127.0.0.1:${port}/api/session/item?id=${a.id}`, { method: "DELETE" });
		assert.deepEqual(
			(await showSession(db, s.id)).items.map((i) => i.component),
			["markdown"],
		);
	} finally {
		await stop();
	}
});
