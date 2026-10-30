// 库：Postgres，唯一的数据，大家共用香港服务器上的一个（经 SSH 隧道，见 tunnel.ts）。地址在 X2_DATABASE_URL，每人一个库账号；凭证留在环境变量里，不进库。
// 表的结构：平台的在 schema.sql，每个业务工具（tools/<名字>）的在它自己的 schema.sql（toolkit 的 schema，注册时记下）。每个进程第一次用库时按先后跑一遍（只建没有的、加没有的列）
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import postgres from "postgres";
import { NeedsHuman } from "../errors.ts";
import { open } from "./tunnel.ts";

export type Sql = postgres.Sql;
/** 写进 jsonb 的值：postgres 的类型只认 JSONValue。我们写进去的都是 JSON 能表示的（解析过的参数、回包、算出来的对象），写的地方 as Json */
export type Json = postgres.JSONValue;

let conn: Sql | null = null;
let ready: Promise<void> | null = null;
let target: string | null = null;

export const host = hostname();

const schemas: URL[] = [new URL("./schema.sql", import.meta.url)];

export function addSchema(file: URL): void {
	if (!schemas.some((s) => s.href === file.href)) schemas.push(file);
}

/** 几个进程同时第一次连库时排着队跑（同时跑 alter table 会死锁）：一个事务里先拿 advisory lock，跑完提交时放 */
export async function migrate(sql: Sql): Promise<void> {
	await sql.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(hashtext('x2 schema'))`;
		for (const file of schemas) await tx.unsafe(await readFile(file, "utf8"));
	});
}

/** 连一个库：numeric、bigint 回字符串（postgres 的默认，id 一律是字符串）；设了 X2_DATABASE_SSH，每条连接经 tunnel.ts 连 */
export function client(url: string, max: number): Sql {
	const ssh = process.env.X2_DATABASE_SSH;
	// postgres.js 支持 socket，类型里没写，所以不写成字面量
	const options = { onnotice: () => {}, max, ...(ssh ? { socket: () => open(url, ssh) } : {}) };
	return postgres(url, options);
}

export async function db(): Promise<Sql> {
	if (!conn) {
		const url = target ?? process.env.X2_DATABASE_URL;
		if (!url)
			throw new NeedsHuman(
				"没有设 X2_DATABASE_URL：库是共用的，在服务器上，不用在本机装 Postgres；连库的两行（X2_DATABASE_URL、X2_DATABASE_SSH）找管服务器的人要（ops/db-user.sh）",
			);
		conn = client(url, 4);
		ready = migrate(conn).catch((e: Error) => {
			if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|does not exist|password/.test(e.message)) throw new NeedsHuman(`连不上库（X2_DATABASE_URL）：${e.message}`);
			throw e;
		});
	}
	await ready;
	return conn;
}

/** 这个进程改用另一个库（x2 web --scratch 的临时库）：在第一次 db() 之前调 */
export function setDatabase(url: string): void {
	if (conn) throw new Error("已经连上 X2_DATABASE_URL 的库了，换不了");
	target = url;
}

/** 进程结束前关掉连接（不关进程不退出） */
export async function close(): Promise<void> {
	const c = conn;
	conn = null;
	ready = null;
	await c?.end({ timeout: 5 });
}
