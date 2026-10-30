// 至多一次写入（at-most-once）：要保护的写（同一个写两次会出事的：加购两次车里是两倍、建商品两次是两个商品、预报两次……）都经它。
// 引擎不认识网站和业务：业务工具（tools）给写操作（WriteOp：防重复的 key、对象、显示的一行、现读还该不该做、调哪个连接器的写、拿哪个读来对账、怎么比），
// 连接器的写只发一次请求、回结果。每一项：
// - 记意图（write-ahead log）：先把写入改成「已提交」再提交（进程这时挂了，下一轮当结果未定，先读回来）
// - 只提交一次：回做了、被拒、结果未定（没拿到答复）
// - 读回对账（reconciliation）：和 before 比：做了、没做、看不出。看不出是结果未定（in-doubt，库里的状态叫「结果未知」），不重发
// 执行（run）：
// 1. 先对账：已提交、结果未定的写入读回来；还看不出的，同一个对象上的这次不做（x2 verify 只做这一步）
// 2. 这一批一个一个执行：prepare 现读还该不该做 → 记意图 → 提交一次 → 读回对账。结果未定就停下这一批，不重发；没做的标成未执行，写明原因
// 3. 执行完：告诉注册了 written 的业务工具（例 上品重算碰过的商品稿的当前步骤）
// 整个库同一时间只有一个进程碰写入（交、核清、执行、x2 resolve，exclusive）：库是几台电脑共用的，别的电脑上的进程看不出开没开着，
// 不排队的话一台记了意图还在提交，另一台核清读回来看不到，记成结果未知，人去看还没有记成被拒，它这时到了站点（买重）。拿着锁的时候库里别人的待执行、已提交都是退出了的进程留下的
// 不花钱、能重来的写不经它（业务工具直接调连接器的写）
import type postgres from "postgres";
import { z } from "zod";
import { host, type Json, type Sql } from "./db/index.ts";
import { NeedsHuman, Usage } from "./errors.ts";
import { type Planned, type Sent, toolkits, writeOps } from "./tool.ts";

/** 写入的编号（writes 的 id）：命令行参数、读库时贴上，别和商品稿编号、订单号传混 */
export const WriteId = z.string().regex(/^\d+$/, "写入的编号是数字").brand<"WriteId">();
export type WriteId = z.output<typeof WriteId>;

export type Submitted = Sent;
export type Prepared<P, B = unknown> = { skip: string } | { params: P; before: B };

/** 一个写操作。P 是参数的样子，B 是提交前现读的（对账用；记在库里，再读回来时还是它） */
export type WriteOp<P = unknown, B = unknown> = {
	describe: string;
	params: z.ZodType<P>;
	target: (p: P) => string;
	key: (p: P) => string;
	display: (p: P) => string;
	link?: string;
	untried?: string;
	where: <T>(sql: Sql, p: P, fn: () => Promise<T>) => Promise<T>;
	prepare: (sql: Sql, p: P) => Promise<Prepared<P, B>>;
	submit: (sql: Sql, p: P) => Promise<Submitted>;
	check: (p: P, before: B | undefined, fresh: boolean) => Promise<{ done: boolean | null; readback: unknown }>;
	after?: (sql: Sql, p: P) => Promise<void>;
};

/** 登记写操作：各个操作的参数、现读的样子不一样，进注册表（Toolkit 的 writes）时一律看成 unknown。
 * 引擎只把照这个操作自己的 params 解析过的参数、它自己的 prepare 回的 before（存进库再读回来）传回给它，所以这一处的转换是对的 */
export const writeOp = <P, B>(op: WriteOp<P, B>): WriteOp => op as unknown as WriteOp;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Ran = { id: WriteId; batch: string; op: string; display: string; status: string; why?: string };

type Row = {
	id: WriteId;
	batch: string;
	op: string;
	target: string;
	key: string;
	params: unknown;
	display: string;
	status: string;
	readback: { before?: unknown; after?: unknown } | null;
};

const LOST = "和库的连接断过，写入锁已经没了：停下（别的进程可能已经在核清；下一次执行会核清这一次的）";

/** 拿锁的那条连接（库里的进程号 lock）还拿着写入锁。拿锁的连接断了锁就放了，别的进程能拿到；这个进程别的连接可能经重开的隧道又连上了，所以改写入的每一句都带上它 */
const holds = (sql: Sql, lock: number) =>
	sql`exists (select 1 from pg_locks where locktype = 'advisory' and classid = ${LOCK[0]} and objid = ${LOCK[1]} and objsubid = 2 and granted and pid = ${lock})`;

/** 改一条写入的几列（值是 jsonb 的已经 sql.json 过）；锁没了不改、抛 */
async function set(sql: Sql, lock: number, id: WriteId, fields: Record<string, postgres.ParameterOrJSON<never> | Date | string | null>) {
	const rows = await sql`update writes set ${sql(fields)} where id = ${id} and ${holds(sql, lock)} returning id`;
	if (!rows.length) throw new Error(LOST);
}

type Opts = { batch?: string; tryOps?: string[] };
export type Outcome = { ran: Ran[]; unknown: boolean; blocked: string | null };

/** 写入锁：postgres 的 session advisory lock，拿在一条专用连接上，进程退出、连接断了就放 */
const LOCK = [2, 1] as const;
const WAIT = 10 * 60_000;

/** 拿着写入锁做 fn（拿到的是拿锁的那条连接在库里的进程号，改写入时带上，见 holds）。别人拿着就等（stderr 说是谁），等太久要人看。
 * 断了的专用连接不再用（postgres.js 在断了的专用连接上发查询会把进程弄崩）：放锁前先从别的连接看还拿着没有 */
export async function exclusive<T>(sql: Sql, fn: (lock: number) => Promise<T>): Promise<T> {
	const conn = await sql.reserve();
	try {
		const [{ pid }] = await conn<[{ pid: number }]>`select pg_backend_pid() as pid`;
		for (const start = Date.now(); ; ) {
			const [{ ok }] = await conn<[{ ok: boolean }]>`select pg_try_advisory_lock(${LOCK[0]}, ${LOCK[1]}) as ok`;
			if (ok) break;
			const [holder] = await sql<{ who: string }[]>`select a.application_name as who from pg_locks l join pg_stat_activity a on a.pid = l.pid
				where l.locktype = 'advisory' and l.classid = ${LOCK[0]} and l.objid = ${LOCK[1]} and l.objsubid = 2 and l.granted`;
			const who = holder?.who || "另一个 x2 进程";
			if (Date.now() - start > WAIT) throw new NeedsHuman(`${who} 拿着写入锁超过 10 分钟：问问它在做什么，卡住了就关掉它`);
			console.error(`${who} 正在执行写入，等它做完…`);
			await sleep(5000);
		}
		try {
			return await fn(pid);
		} finally {
			const [still] = await sql<{ ok: boolean }[]>`select ${holds(sql, pid)} as ok`.catch(() => []);
			if (still?.ok) await conn`select pg_advisory_unlock(${LOCK[0]}, ${LOCK[1]})`.catch(() => {});
		}
	} finally {
		conn.release();
	}
}

/** x2 verify：拿着写入锁核清 */
export const verify = (sql: Sql, ops: Record<string, WriteOp> = writeOps()) => exclusive(sql, (lock) => run(sql, lock, {}, ops));

async function run(sql: Sql, lock: number, opts: Opts, ops: Record<string, WriteOp>): Promise<Outcome> {
	const r = await execute(sql, lock, opts, ops);
	if (r.ran.length)
		for (const k of toolkits())
			await k.written?.(sql, r.ran).catch((e: Error) => console.error(`${k.title}：执行完写入后更新没成功（下一次 x2 status 会再算）：${e.message}`));
	return r;
}

const IN_FLIGHT = ["待执行", "已提交", "结果未知", "不一致"];
/** 要人到站点上看、x2 resolve 记结果的。已提交的不算：可能还在路上（进程正在提交），人看的时候还没到站点，记成被拒会再做一次；先 x2 verify 读回来 */
export const LOOK = ["结果未知", "不一致"];
const UNSETTLED = ["已提交", "结果未知", "不一致"];
const DONE = ["成功", "已核对"];

// 下面几个是纯的判断（一条写入现在该怎么办），引擎只管读写库、调写操作

/** 新交一条写入：同一个 key（含加了次数的 key#n）还有没核清的不收；做过、被拒过的再交加次数 */
export function admit(key: string, same: { id: string; status: string }[]): { key: string } | { busy: string } {
	const flying = same.find((w) => IN_FLIGHT.includes(w.status));
	if (flying) return { busy: flying.id };
	return { key: same.length ? `${key}#${same.length + 1}` : key };
}

export type Stuck = { batches: Set<string>; targets: Set<string> };
/** 轮到一条待执行的写入：能做回 null，不做回原因 */
export function gate(
	w: { op: string; batch: string; target: string },
	s: { known: boolean; blocked: string | null; stuck: Stuck; untried?: string | undefined; tried: boolean },
): string | null {
	if (!s.known) return `没有 ${w.op} 这个写操作`;
	if (s.blocked) return `没做：${s.blocked}`;
	if (s.stuck.batches.has(w.batch) || s.stuck.targets.has(w.target)) return "这一批（或同一个对象）有结果未知的写入：先核清再做";
	if (s.untried && !s.tried) return s.untried;
	return null;
}

export type Held = { id: string; key: string; target: string; status: string };
/** 记意图之前再看一遍库里同一个 key、同一个对象上的写入（别的批的也算）：没核清的挡着（一个对象上同时在路上的两条，读回对账分不清是谁做的）；
 * 同一个 key 做成过的是重复 */
export function held(w: { key: string; target: string }, others: Held[]): string | null {
	const open = others.find((o) => (o.key === w.key || o.target === w.target) && UNSETTLED.includes(o.status));
	if (open) return `同一个对象有没核清的写入 #${open.id}：先核清再做`;
	const dup = others.find((o) => o.key === w.key && DONE.includes(o.status));
	return dup ? `重复：写入 #${dup.id} 已经做过` : null;
}

/** 提交一次、读回来以后：站点的答复和读回来的结果合成写入的状态 */
export function settle(sent: Exclude<Sent, { kind: "blocked" }>, done: boolean | null): { status: string; why?: string } {
	if (done === true) return { status: "已核对" };
	if (done === false) return sent.kind === "done" ? { status: "不一致", why: "站点说做了，读回来没有" } : { status: "被拒", why: `没做成：${sent.why}` };
	return { status: "结果未知", why: `读回来看不出做没做${sent.kind === "unknown" ? `（${sent.why}）` : ""}` };
}

/** 执行、核清一条写入时抛了错：照库里它现在的状态定改成什么。还是待执行的（没记意图、没提交）是未执行；已提交、结果未知的是结果未知；
 * 已经有结果的（做成了以后 after 更新库出错）不改：改成未执行，业务会当没做过再做一次（加购的会再加一次） */
export function failed(now: string | undefined): "未执行" | "结果未知" | null {
	if (now === "待执行") return "未执行";
	if (now === "已提交" || now === "结果未知") return "结果未知";
	return null;
}

/** 这个状态要停下同一批、同一个对象上的写入 */
export const stuck = (status: string) => status === "结果未知" || status === "不一致";

type NewRow = { op: string; params: unknown; target: string; key: string; display: string };

/** 交一批写入（拿着写入锁的时候） */
async function addWrites(tx: postgres.TransactionSql, rows: NewRow[]): Promise<string> {
	const [{ batch }] = (await tx`select nextval('batch_seq')::text as batch`) as unknown as [{ batch: string }];
	for (const r of rows) {
		const same = (await tx`select id::text, status from writes where key = ${r.key} or key like ${`${r.key}#%`} order by id`) as unknown as {
			id: string;
			status: string;
		}[];
		const a = admit(r.key, same);
		if ("busy" in a) throw new Usage(`${r.display}：写入 #${a.busy} 还没核清（x2 verify），不再做新的`);
		const key = a.key;
		await tx`insert into writes (batch, op, target, params, display, key, status, host) values (${batch}, ${r.op}, ${r.target}, ${tx.json(r.params as Json)}, ${r.display}, ${key}, '待执行', ${host})`;
	}
	return batch;
}

export async function perform(sql: Sql, batches: Planned[][], opts: { try?: boolean } = {}, ops: Record<string, WriteOp> = writeOps()): Promise<Outcome> {
	return exclusive(sql, (lock) => performLocked(sql, lock, batches, opts, ops));
}

async function performLocked(sql: Sql, lock: number, batches: Planned[][], opts: { try?: boolean }, ops: Record<string, WriteOp>): Promise<Outcome> {
	const outcomes: Outcome[] = [];
	for (const b of batches) {
		const rows = b.map((w, i) => {
			const op = ops[w.op];
			if (!op) throw new Usage(`第 ${i + 1} 项：没有 ${w.op} 这个写操作（有：${Object.keys(ops).join("、")}）`);
			const parsed = op.params.safeParse(w.params);
			if (!parsed.success)
				throw new Usage(`第 ${i + 1} 项（${w.op}）参数不对：${parsed.error.issues.map((x) => `${x.path.join(".")}：${x.message}`).join("；")}`);
			const params = parsed.data;
			return { op: w.op, params, target: op.target(params), key: op.key(params), display: op.display(params) };
		});
		if (!rows.length) continue;
		const batch = await sql.begin((tx) => addWrites(tx, rows));
		const o = await run(sql, lock, { batch, tryOps: opts.try ? rows.map((r) => r.op) : [] }, ops);
		outcomes.push(o);
		if (o.blocked) break;
	}
	return { ran: outcomes.flatMap((o) => o.ran), unknown: outcomes.some((o) => o.unknown), blocked: outcomes.find((o) => o.blocked)?.blocked ?? null };
}

async function execute(sql: Sql, lock: number, opts: Opts, ops: Record<string, WriteOp>): Promise<Outcome> {
	const ran: Ran[] = [];
	const halted: Stuck = { batches: new Set(), targets: new Set() };
	let blocked: string | null = null;

	// 拿着写入锁：别的批的待执行是交了以后没执行就退出了的进程留下的，没提交过，清成未执行（不清的话同一个 key 一直「还没核清」，再也交不了）
	const cleared = await sql<Ran[]>`update writes set status = '未执行', error = '交了以后进程没执行就退出了', finished_at = now()
		where status = '待执行' ${opts.batch ? sql`and batch <> ${opts.batch}` : sql``} and ${holds(sql, lock)} returning id::text, batch::text, op, display, status`;
	for (const w of cleared) ran.push({ ...w, why: "交了以后进程没执行就退出了：没提交过，要做再交一次" });

	const unsure = (await sql`select id::text, batch::text, op, target, key, params, display, status, readback from writes
		where status in ('已提交', '结果未知') order by writes.id`) as unknown as Row[];
	for (const w of unsure) {
		const op = ops[w.op];
		if (!op) continue;
		try {
			const r = await op.where(sql, w.params, () => op.check(w.params, w.readback?.before, false));
			if (r.done) {
				await set(sql, lock, w.id, { status: "已核对", readback: sql.json({ ...w.readback, after: r.readback } as Json), finished_at: new Date() });
				await op.after?.(sql, w.params);
				ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status: "已核对", why: "读回来看到做成了" });
				continue;
			}
			await set(sql, lock, w.id, { status: "结果未知", readback: sql.json({ ...w.readback, after: r.readback } as Json) });
		} catch (e) {
			if (e instanceof NeedsHuman) {
				blocked = e.message;
				break;
			}
			const [now] = await sql`select status from writes where id = ${w.id}`;
			if (failed(now?.status) !== "结果未知") {
				ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status: String(now?.status), why: `之后出错（状态不改）：${(e as Error).message}` });
				continue;
			}
			await set(sql, lock, w.id, { status: "结果未知", error: (e as Error).message });
		}
		halted.batches.add(w.batch);
		halted.targets.add(w.target);
		ran.push({
			id: w.id,
			batch: w.batch,
			op: w.op,
			display: w.display,
			status: "结果未知",
			why: "读回来还看不出做没做：请人到站点上看一眼，x2 resolve 记成已核对或被拒",
		});
	}

	const todo = opts.batch
		? ((await sql`
		select id::text, batch::text, op, target, key, params, display, status, readback from writes
		where status = '待执行' and batch = ${opts.batch} order by writes.id`) as unknown as Row[])
		: [];
	let last = 0;
	for (const w of todo) {
		const op = ops[w.op];
		const skip = async (why: string, status = "未执行") => {
			await set(sql, lock, w.id, { status, error: why, finished_at: new Date() });
			ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status, why });
		};
		const no = gate(w, {
			known: Boolean(op),
			blocked,
			stuck: halted,
			untried: op?.untried,
			tried: Boolean(opts.tryOps?.includes(w.op)),
		});
		if (no || !op) {
			await skip(no ?? `没有 ${w.op} 这个写操作`);
			continue;
		}

		if (last && Date.now() - last < 3000) await sleep(3000 - (Date.now() - last));
		last = Date.now();
		console.error(`${w.op}：${w.display}`);
		try {
			const outcome = await op.where(sql, w.params, async () => {
				const prepared = await op.prepare(sql, w.params);
				if ("skip" in prepared) return { skip: prepared.skip };
				const params = prepared.params;
				const others = (await sql`select id::text, key, target, status from writes
					where id <> ${w.id} and (key = ${w.key} or target = ${w.target}) and status in ${sql([...UNSETTLED, ...DONE])}`) as unknown as Held[];
				const no = held(w, others);
				if (no) return { skip: no };
				await set(sql, lock, w.id, {
					status: "已提交",
					params: sql.json(params as Json),
					readback: sql.json({ before: prepared.before } as Json),
					started_at: new Date(),
					host,
				});
				const sent = await op.submit(sql, params);
				if (sent.kind === "blocked") return { blocked: sent.why, params };
				if (sent.kind === "refused") return { status: "被拒", why: sent.why, response: sent, before: undefined, after: undefined, params };
				let r: { done: boolean | null; readback: unknown };
				try {
					r = await op.check(params, prepared.before, true);
				} catch (e) {
					r = { done: null, readback: { error: (e as Error).message } };
				}
				return { ...settle(sent, r.done), response: sent, after: r.readback, before: prepared.before, params };
			});
			if ("skip" in outcome) {
				await skip(outcome.skip!);
				continue;
			}
			if ("blocked" in outcome) {
				await set(sql, lock, w.id, { started_at: null });
				blocked = outcome.blocked!;
				await skip(`没做：${blocked}`);
				continue;
			}
			await set(sql, lock, w.id, {
				status: outcome.status,
				error: outcome.why ?? null,
				response: sql.json(outcome.response as Json),
				readback: sql.json({ before: outcome.before, after: outcome.after } as Json),
				finished_at: new Date(),
			});
			if (outcome.status === "已核对") await op.after?.(sql, outcome.params);
			ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status: outcome.status!, why: outcome.why });
			if (stuck(outcome.status!)) {
				halted.batches.add(w.batch);
				halted.targets.add(w.target);
			}
		} catch (e) {
			const [now] = await sql`select status from writes where id = ${w.id}`;
			const to = failed(now?.status);
			if (e instanceof NeedsHuman) {
				blocked = e.message;
				if (to === "未执行") await skip(`没做：${blocked}`);
				continue;
			}
			if (to === "结果未知") {
				await set(sql, lock, w.id, { status: "结果未知", error: (e as Error).message });
				halted.batches.add(w.batch);
				halted.targets.add(w.target);
				ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status: "结果未知", why: (e as Error).message });
			} else if (to === "未执行") await skip((e as Error).message);
			else
				ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status: String(now?.status), why: `之后出错（状态不改）：${(e as Error).message}` });
		}
	}
	return { ran, unknown: ran.some((r) => stuck(r.status)), blocked };
}
