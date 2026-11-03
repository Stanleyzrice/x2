// 本地报帐标记独立于1688源事实，按账号与订单定位，并用版本防止两处人工修改相互覆盖。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "../../platform/db/index.ts";
import { markReported, reimbursement } from "./index.ts";

function memorySql() {
	type Mark = { reported: boolean; revision: number; updatedAt: Date };
	const orders = new Map([
		["A/order", { paid: true, fact: { paidMinor: "100" } }],
		["B/order", { paid: true, fact: { paidMinor: "200" } }],
		["A/unpaid", { paid: false, fact: { paidMinor: null } }],
	]);
	const marks = new Map<string, Mark>();
	const queries: string[] = [];
	const updatedAt = new Date("2026-11-01T10:00:00Z");
	const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
		const text = strings.join("?").trim();
		queries.push(text);
		if (text.startsWith("select order_id")) return orders.get(`${values[0]}/${values[1]}`)?.paid ? [{ orderId: values[1] }] : [];
		if (text.startsWith("insert into reimbursement_marks")) {
			const key = `${values[0]}/${values[1]}`;
			if (marks.has(key)) return [];
			const mark = { reported: values[2] === true, revision: 1, updatedAt };
			marks.set(key, mark);
			return [mark];
		}
		if (text.startsWith("update reimbursement_marks")) {
			const key = `${values[1]}/${values[2]}`;
			const previous = marks.get(key);
			if (!previous || previous.revision !== values[3]) return [];
			const mark = { reported: values[0] === true, revision: previous.revision + 1, updatedAt };
			marks.set(key, mark);
			return [mark];
		}
		throw new Error(`未声明的fixture查询：${text}`);
	}) as unknown as Sql;
	return { sql, marks, orders, queries };
}

test("报帐标记可勾选和撤销，同订单号不同账号互不影响，源事实保持独立", async () => {
	const { sql, marks, orders, queries } = memorySql();
	const original = structuredClone([...orders]);
	assert.deepEqual(await markReported(sql, { account: "A", orderId: "order", reported: true, revision: 0 }), {
		account: "A",
		orderId: "order",
		reported: true,
		revision: 1,
		updatedAt: "2026-11-01T10:00:00.000Z",
	});
	await markReported(sql, { account: "B", orderId: "order", reported: true, revision: 0 });
	const changed = await markReported(sql, { accounts: ["A"], account: "A", orderId: "order", reported: false, revision: 1 });
	assert.equal(changed.reported, false);
	assert.equal(changed.revision, 2);
	assert.equal(marks.get("B/order")?.reported, true);
	assert.equal(marks.get("B/order")?.revision, 1);
	assert.deepEqual([...orders], original);
	assert.ok(queries.every((q) => q.startsWith("select") || /^(insert into|update) reimbursement_marks/.test(q)));
});

test("首次和后续并发修改都只有一个成功，旧版本不得覆盖已有选择", async () => {
	const { sql, marks } = memorySql();
	const target = { account: "A", orderId: "order" };
	const first = await Promise.allSettled([
		markReported(sql, { ...target, reported: true, revision: 0 }),
		markReported(sql, { ...target, reported: false, revision: 0 }),
	]);
	assert.equal(first.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(marks.get("A/order")?.revision, 1);
	const next = await Promise.allSettled([
		markReported(sql, { ...target, reported: false, revision: 1 }),
		markReported(sql, { ...target, reported: true, revision: 1 }),
	]);
	assert.equal(next.filter((r) => r.status === "fulfilled").length, 1);
	assert.equal(marks.get("A/order")?.revision, 2);
	await assert.rejects(markReported(sql, { ...target, reported: true, revision: 1 }), /版本已更新/);
});

test("拒绝越过页面账号范围、未知和未付款订单，不产生标记", async () => {
	const { sql, marks, queries } = memorySql();
	await assert.rejects(markReported(sql, { accounts: ["A"], account: "B", orderId: "order", reported: true, revision: 0 }), /允许范围/);
	assert.equal(queries.length, 0);
	for (const orderId of ["unpaid", "missing"]) {
		await assert.rejects(markReported(sql, { account: "A", orderId, reported: true, revision: 0 }), /没有此已付款/);
	}
	assert.equal(marks.size, 0);
});

test("mark-reported输入需要显式布尔选择和非负版本，CLI false不被当成true", () => {
	const params = reimbursement.tools["mark-reported"]!.params;
	assert.equal(params.parse({ account: "A", orderId: "order", reported: "false", revision: "0" }).reported, false);
	assert.equal(params.safeParse({ account: "A", orderId: "order", revision: 0 }).success, false);
	assert.equal(params.safeParse({ account: "A", orderId: "order", reported: true, revision: -1 }).success, false);
});
