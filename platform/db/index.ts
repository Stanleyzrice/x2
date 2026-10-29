// 库：Postgres，唯一的数据。地址在 X2_DATABASE_URL（先在本机开发，以后指到 NAS）；凭证留在环境变量里，不进库。
// 表的结构：平台的在 schema.sql，每个业务工具（tools/<名字>）的在它自己的 schema.sql（toolkit 的 schema，注册时记下）。每个进程第一次用库时按先后跑一遍（只建没有的、加没有的列）
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import postgres from "postgres";
import { NeedsHuman } from "../errors.ts";

export type Sql = postgres.Sql;
/** 写进 jsonb 的值：postgres 的类型只认 JSONValue。我们写进去的都是 JSON 能表示的（解析过的参数、回包、算出来的对象），写的地方 as Json */
export type Json = postgres.JSONValue;

let conn: Sql | null = null;
let ready: Promise<void> | null = null;

export const host = hostname();

const schemas: URL[] = [new URL("./schema.sql", import.meta.url)];

export function addSchema(file: URL): void {
	if (!schemas.some((s) => s.href === file.href)) schemas.push(file);
}

export async function migrate(sql: Sql): Promise<void> {
	for (const file of schemas) await sql.unsafe(await readFile(file, "utf8"));
}

export async function db(): Promise<Sql> {
	if (!conn) {
		const url = process.env.X2_DATABASE_URL;
		if (!url) throw new NeedsHuman("没有设 X2_DATABASE_URL（库的地址，例 postgres://localhost/x2）");
		// numeric 回字符串（postgres 的默认），bigint 也回字符串：id 一律是字符串
		conn = postgres(url, { onnotice: () => {}, max: 4 });
		ready = migrate(conn).catch((e: Error) => {
			if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|does not exist|password/.test(e.message)) throw new NeedsHuman(`连不上库（X2_DATABASE_URL）：${e.message}`);
			throw e;
		});
	}
	await ready;
	return conn;
}

/** 进程结束前关掉连接（不关进程不退出） */
export async function close(): Promise<void> {
	const c = conn;
	conn = null;
	ready = null;
	await c?.end({ timeout: 5 });
}
