// 网页的服务和会话（连库，test/db.ts）：只收人能改的格；表单添一行；会话照组件的参数校验、按引用筛行
import assert from "node:assert/strict";
import { test } from "node:test";
import { skip, sql } from "../../test/db.ts";
import { Usage } from "../errors.ts";
import { serve } from "./server.ts";
import { createSession, push, showSession } from "./sessions.ts";

test("网页：只收人能改的格，照类型和条件收；删图记进已删除的图；表单添一行", { skip }, async () => {
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
	skip,
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
