// 采购历史同步：独占连接的账号锁覆盖浏览器采集与发布；进度单独持久化，失败不改有效记录，后台与手动共享同一入口。
import { randomUUID } from "node:crypto";
import { account } from "../../connectors/sites/1688/api.ts";
import { type PurchaseFact, purchaseFacts } from "../../connectors/sites/1688/purchases.ts";
import { inAccount, logins } from "../../platform/browser/browser.ts";
import type { Json, Sql } from "../../platform/db/index.ts";
import { collectAccountHistory, type Progress, preservePayment, type StoredPurchase } from "./facts.ts";

export type Account = { id: string; name: string };
export type RefreshResult = { account: string; status: "succeeded" | "failed" | "running"; error?: string };
const pending = new Map<string, Promise<RefreshResult>>();
let allPending: Promise<RefreshResult[]> | null = null;
const GLOBAL_LOCK = "reimbursement:all-history";
type Session = Awaited<ReturnType<Sql["reserve"]>>;
type ReadAccount = (who: Account, progress: (p: Progress) => Promise<void>) => Promise<PurchaseFact[]>;

function isSession(sql: Sql): sql is Session {
	return "release" in sql && typeof sql.release === "function";
}

/** 一参数bigint advisory锁在pg_locks中拆为高低32位；必须核对具体键，不能将同session的其他任务锁算作存活。 */
export function runLockPresent(sql: Sql) {
	const key = sql`hashtextextended(case when r.account_id is null then ${GLOBAL_LOCK} else 'reimbursement:' || r.account_id end, 0)`;
	return sql`exists (select 1 from pg_locks l where l.pid = r.backend_pid and l.locktype = 'advisory' and l.granted
 and l.classid = ((${key} >> 32) & 4294967295)::oid and l.objid = (${key} & 4294967295)::oid and l.objsubid = 1)`;
}

async function assertLock(conn: Sql, key: string, pid: number) {
	const [held] = await conn<{ held: boolean }[]>`select pg_backend_pid() = ${pid} and exists (
 select 1 from pg_locks l where l.pid = ${pid} and l.locktype = 'advisory' and l.granted
 and l.classid = ((hashtextextended(${key}, 0) >> 32) & 4294967295)::oid
 and l.objid = (hashtextextended(${key}, 0) & 4294967295)::oid and l.objsubid = 1) as held`;
	if (!held?.held) throw new Error("数据库连接或同步锁已丢失，不发布本次数据");
}

const readAccount: ReadAccount = (who, progress) =>
	inAccount("1688", who.id, () => collectAccountHistory(who.id, async () => (await account())?.userId ?? null, purchaseFacts, progress));

async function refresh(sql: Sql, who: Account, read: ReadAccount): Promise<RefreshResult> {
	const id = randomUUID();
	const borrowed = isSession(sql);
	const conn = borrowed ? sql : await sql.reserve();
	let started = false;
	let locked = false;
	let transaction = false;
	try {
		const [lock] = await conn<
			{ locked: boolean; pid: number }[]
		>`select pg_try_advisory_lock(hashtextextended(${`reimbursement:${who.id}`}, 0)) as locked, pg_backend_pid() as pid`;
		if (!lock!.locked) return { account: who.id, status: "running" };
		locked = true;
		await conn`insert into reimbursement_accounts (account_id, name) values (${who.id}, ${who.name}) on conflict (account_id) do update set name = excluded.name`;
		await conn`update reimbursement_runs set status = 'failed', finished_at = now(), error = '上次同步进程已中断；保留最后成功记录' where account_id = ${who.id} and status = 'running'`;
		await conn`insert into reimbursement_runs (id, account_id, status, backend_pid) values (${id}, ${who.id}, 'running', ${lock!.pid})`;
		started = true;
		const facts = await read(who, async (p) => {
			await conn`update reimbursement_runs set page = ${p.page}, pages = ${p.pages}, observed = ${p.observed}, total = ${p.total} where id = ${id}`;
		});
		await conn.unsafe("begin");
		transaction = true;
		await assertLock(conn, `reimbursement:${who.id}`, lock!.pid);
		const capturedAt = new Date();
		const previous = new Map(
			(await conn<{ orderId: string; fact: StoredPurchase }[]>`select order_id as "orderId", fact from reimbursement_orders where account_id = ${who.id}`).map(
				(r) => [r.orderId, r.fact],
			),
		);
		let paid = 0;
		for (const fact of facts) {
			const saved = preservePayment(previous.get(fact.orderId), fact, id);
			if (saved.receipt.paidAt !== null) paid++;
			await conn`insert into reimbursement_orders (account_id, order_id, fact, paid_at, captured_at, revision) values (${who.id}, ${fact.orderId}, ${conn.json(saved as Json)}, ${saved.receipt.paidAt}, ${capturedAt}, ${id}) on conflict (account_id, order_id) do update set fact = excluded.fact, paid_at = excluded.paid_at, captured_at = excluded.captured_at, revision = excluded.revision`;
			await conn`insert into reimbursement_order_history (run_id, account_id, order_id, fact, captured_at) values (${id}, ${who.id}, ${fact.orderId}, ${conn.json(fact as Json)}, ${capturedAt})`;
		}
		await conn`update reimbursement_accounts set last_success_at = ${capturedAt}, revision = ${id} where account_id = ${who.id}`;
		await conn`update reimbursement_runs set status = 'succeeded', finished_at = ${capturedAt}, paid_count = ${paid}, unknown_count = ${facts.length - paid} where id = ${id}`;
		await conn.unsafe("commit");
		transaction = false;
		return { account: who.id, status: "succeeded" };
	} catch (e) {
		if (transaction) await conn.unsafe("rollback").catch(() => {});
		const error = (e as Error).message;
		if (started) await conn`update reimbursement_runs set status = 'failed', finished_at = now(), error = ${error} where id = ${id} and status = 'running'`;
		return { account: who.id, status: "failed", error };
	} finally {
		if (locked) await conn`select pg_advisory_unlock(hashtextextended(${`reimbursement:${who.id}`}, 0))`.catch(() => {});
		if (!borrowed) conn.release();
	}
}

export function refreshAccount(sql: Sql, who: Account, read: ReadAccount = readAccount): Promise<RefreshResult> {
	const running = pending.get(who.id);
	if (running) return running;
	const task = refresh(sql, who, read).finally(() => pending.delete(who.id));
	pending.set(who.id, task);
	return task;
}

async function discover(sql: Sql): Promise<Account[]> {
	const saved = await sql<{ id: string; name: string }[]>`select account_id as id, name from reimbursement_accounts order by name`;
	const accounts = new Map(saved.map((a) => [a.id, a]));
	try {
		for (const login of await logins("1688")) accounts.set(login.account.id, { id: login.account.id, name: login.account.name });
	} catch (e) {
		if (!saved.length) throw e;
	}
	if (!accounts.size) throw new Error("没有可读取的 1688 账号：打开已登录的 Chrome 并连接 booey");
	return [...accounts.values()];
}

export async function refreshAll(sql: Sql, run = { discover, account: refreshAccount }): Promise<RefreshResult[]> {
	if (allPending) return allPending;
	allPending = (async () => {
		const id = randomUUID();
		const borrowed = isSession(sql);
		const conn = borrowed ? sql : await sql.reserve();
		let locked = false;
		let started = false;
		try {
			const [lock] = await conn<
				{ locked: boolean; pid: number }[]
			>`select pg_try_advisory_lock(hashtextextended(${GLOBAL_LOCK}, 0)) as locked, pg_backend_pid() as pid`;
			if (!lock?.locked) throw new Error("其他进程正在刷新全部采购账号，未重复启动");
			locked = true;
			await conn`update reimbursement_runs set status = 'failed', finished_at = now(), error = '上次同步进程已中断；保留最后成功记录' where account_id is null and status = 'running'`;
			await conn`insert into reimbursement_runs (id, status, backend_pid) values (${id}, 'running', ${lock.pid})`;
			started = true;
			const results: RefreshResult[] = [];
			for (const who of await run.discover(conn)) results.push(await run.account(conn, who));
			const errors = results.filter((r) => r.status !== "succeeded").map((r) => `${r.account}: ${r.error ?? "其他进程正在刷新，当前批次未重复执行"}`);
			if (errors.length) throw new Error(errors.join("；"));
			await assertLock(conn, GLOBAL_LOCK, lock.pid);
			await conn`update reimbursement_runs set status = 'succeeded', finished_at = now() where id = ${id} and backend_pid = ${lock.pid} and status = 'running'`;
			return results;
		} catch (e) {
			if (started)
				await conn`update reimbursement_runs set status = 'failed', finished_at = now(), error = ${(e as Error).message} where id = ${id} and status = 'running'`;
			throw e;
		} finally {
			if (locked) await conn`select pg_advisory_unlock(hashtextextended(${GLOBAL_LOCK}, 0))`.catch(() => {});
			if (!borrowed) conn.release();
		}
	})().finally(() => {
		allPending = null;
	});
	return allPending;
}
