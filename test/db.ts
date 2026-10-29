// 连库的测试共用的：X2_TEST_DATABASE_URL 指的库（每个测试文件开头清空它的 public schema、建表），没设就跳过（skip）。
// 注册全部 toolkit，订单的检查用假的现读（不碰站点）；tool 照命令行的参数跑一个工具，回 --json 的样子
import assert from "node:assert/strict";
import { after, before } from "node:test";
import postgres from "postgres";
import { runTool } from "../platform/cli.ts";
import { close, migrate } from "../platform/db/index.ts";
import { status } from "../platform/status.ts";
import { register, type Toolkit } from "../platform/tool.ts";
import { orders } from "../tools/orders/index.ts";
import type { Reads } from "../tools/orders/read.ts";
import { ordersCheck } from "../tools/orders/status.ts";
import { TOOLKITS } from "../x2.ts";

export const url = process.env.X2_TEST_DATABASE_URL;
export const sql = url ? postgres(url, { onnotice: () => {}, max: 2 }) : null;
export const skip = !sql && "没设 X2_TEST_DATABASE_URL";

const reads = (): Reads => ({ cart: [], purchases: [], accounts: new Map(), buyAccount: null, results: [{ what: "订单", who: "chanboss", ok: true }] });
register({ ...orders, check: (s) => ordersCheck(s, reads()) }, ...TOOLKITS);

before(async () => {
	if (!sql) return;
	await sql.unsafe("drop schema public cascade; create schema public");
	await migrate(sql);
});
after(async () => {
	await sql?.end();
	await close();
});

export async function check(db: postgres.Sql) {
	const r = await status(db);
	return { reminders: r.human, todo: r.todo };
}

export async function tool(kit: Toolkit, args: string[]): Promise<any> {
	process.env.X2_DATABASE_URL = url!;
	const r = await runTool(kit, args);
	assert.ok("value" in r);
	return JSON.parse(JSON.stringify(r.value));
}
