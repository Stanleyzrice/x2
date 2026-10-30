// datagrid 的引用怎么变成查询：只认给人看的列和主键，值走参数，不给 sort 按主键排
import assert from "node:assert/strict";
import { test } from "node:test";
import { props } from "../ui/interactable/datagrid/schema.ts";
import { checkRef, refQuery } from "./grid.ts";
import type { Table } from "./tables.ts";

const T: Table = {
	name: "listings",
	title: "商品稿",
	key: ["id"],
	columns: { nickname: "简称", step: "当前步骤", pics: "图", cancelled: "放弃" },
	computed: { pics: { type: "pics", of: () => [] } },
	edit: { nickname: {}, cancelled: { when: "product_id is null" } },
};
const ref = (p: unknown) => props.parse(p);

test("引用：筛、排、分组拼成参数化的 SQL；有 when 的格带上这一行能不能改", () => {
	const q = refQuery(T, ref({ table: "listings", filter: { step: ["待批准", "待补充"], id: "3" }, sort: [{ col: "step", desc: true }, { col: "id" }] }), 1000);
	assert.equal(
		q.text,
		`select *, (product_id is null) as "_can_cancelled" from "listings" where "step"::text in ($1, $2) and "id"::text in ($3) order by "step" desc nulls last, "id" asc nulls last limit 1000`,
	);
	assert.deepEqual(q.values, ["待批准", "待补充", "3"]);
});

test("引用：不给 sort 按主键排；不给 filter 没有 where", () => {
	assert.equal(
		refQuery(T, ref({ table: "listings" }), 10).text,
		`select *, (product_id is null) as "_can_cancelled" from "listings" order by "id" asc nulls last limit 10`,
	);
});

test("引用：没有的表、不给人看的列、算出来的列不能筛排分组，一格一句", () => {
	assert.deepEqual(checkRef([T], ref({ table: "nope" })), ["table：没有表 nope（有：listings）"]);
	assert.deepEqual(checkRef([T], ref({ table: "listings", columns: ["step", "pics"], filter: { step: "待批准" }, group: { col: "step" } })), []);
	const bad = checkRef([T], ref({ table: "listings", columns: ["secret"], filter: { "1=1; --": "x" }, sort: [{ col: "pics" }], group: { col: "product_id" } }));
	assert.equal(bad.length, 4);
	assert.match(bad[0]!, /^columns：商品稿没有给人看的列「secret」/);
	assert.match(bad[1]!, /^filter\.1=1; --：商品稿不能按「1=1; --」筛（能：id、nickname、step、cancelled）/);
	assert.match(bad[2]!, /^sort：商品稿不能按「pics」排/);
	assert.match(bad[3]!, /^group：商品稿不能按「product_id」分组/);
});
