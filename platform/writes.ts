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
// 不花钱、能重来的写不经它（业务工具直接调连接器的写）
import type postgres from "postgres";
import type { z } from "zod";
import { host, type Sql } from "./db/index.ts";
import { NeedsHuman, Usage } from "./errors.ts";
import { type Planned, type Sent, toolkits, writeOps } from "./tool.ts";

export type Submitted = Sent;
export type Prepared<P> = { skip: string } | { params: P; before: unknown };

export type WriteOp<P = any> = {
	describe: string;
	params: z.ZodType<P>;
	target: (p: P) => string;
	key: (p: P) => string;
	display: (p: P) => string;
	link?: string;
	untried?: string;
	where: <T>(sql: Sql, p: P, fn: () => Promise<T>) => Promise<T>;
	prepare: (sql: Sql, p: P) => Promise<Prepared<P>>;
	submit: (sql: Sql, p: P) => Promise<Submitted>;
	check: (p: P, before: any, fresh: boolean) => Promise<{ done: boolean | null; readback: unknown }>;
	after?: (sql: Sql, p: P) => Promise<void>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Ran = { id: string; batch: string; op: string; display: string; status: string; why?: string };

type Row = { id: string; batch: string; op: string; target: string; key: string; params: any; display: string; status: string; readback: any };

async function set(sql: Sql, id: string, fields: Record<string, unknown>) {
	await sql`update writes set ${sql(fields as any)} where id = ${id}`;
}

type Opts = { batch?: string; tryOps?: string[] };
export type Outcome = { ran: Ran[]; unknown: boolean; blocked: string | null };

export async function run(sql: Sql, opts: Opts = {}, ops: Record<string, WriteOp> = writeOps()): Promise<Outcome> {
	const r = await execute(sql, opts, ops);
	if (r.ran.length)
		for (const k of toolkits())
			await k.written?.(sql, r.ran).catch((e: Error) => console.error(`${k.title}：执行完写入后更新没成功（下一次 x2 status 会再算）：${e.message}`));
	return r;
}

const IN_FLIGHT = ["待执行", "已提交", "结果未知", "不一致"];
const DONE_OR_FLYING = ["成功", "已核对", "已提交", "结果未知", "不一致"];

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
	s: { known: boolean; blocked: string | null; stuck: Stuck; untried?: string | undefined; tried: boolean; dup: string | null },
): string | null {
	if (!s.known) return `没有 ${w.op} 这个写操作`;
	if (s.blocked) return `没做：${s.blocked}`;
	if (s.stuck.batches.has(w.batch) || s.stuck.targets.has(w.target)) return "这一批（或同一个对象）有结果未知的写入：先核清再做";
	if (s.untried && !s.tried) return s.untried;
	if (s.dup) return `重复：写入 #${s.dup} 已经做过（或还没核清）`;
	return null;
}

/** 提交一次、读回来以后：站点的答复和读回来的结果合成写入的状态 */
export function settle(sent: Exclude<Sent, { kind: "blocked" }>, done: boolean | null): { status: string; why?: string } {
	if (done === true) return { status: "已核对" };
	if (done === false) return sent.kind === "done" ? { status: "不一致", why: "站点说做了，读回来没有" } : { status: "被拒", why: `没做成：${sent.why}` };
	return { status: "结果未知", why: `读回来看不出做没做${sent.kind === "unknown" ? `（${sent.why}）` : ""}` };
}

/** 这个状态要停下同一批、同一个对象上的写入 */
export const stuck = (status: string) => status === "结果未知" || status === "不一致";

type NewRow = { op: string; params: unknown; target: string; key: string; display: string };

export async function addWrites(tx: Sql | postgres.TransactionSql, rows: NewRow[]): Promise<string> {
	const [{ batch }] = (await tx`select nextval('batch_seq')::text as batch`) as any;
	for (const r of rows) {
		const same = (await tx`select id::text, status from writes where key = ${r.key} or key like ${`${r.key}#%`} order by id`) as unknown as {
			id: string;
			status: string;
		}[];
		const a = admit(r.key, same);
		if ("busy" in a) throw new Usage(`${r.display}：写入 #${a.busy} 还没核清（x2 verify），不再做新的`);
		const key = a.key;
		await tx`insert into writes (batch, op, target, params, display, key, status, host) values (${batch}, ${r.op}, ${r.target}, ${tx.json(r.params as any)}, ${r.display}, ${key}, '待执行', ${host})`;
	}
	return batch;
}

export async function perform(sql: Sql, batches: Planned[][], opts: { try?: boolean } = {}, ops: Record<string, WriteOp> = writeOps()): Promise<Outcome> {
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
		const o = await run(sql, { batch, tryOps: opts.try ? rows.map((r) => r.op) : [] }, ops);
		outcomes.push(o);
		if (o.blocked) break;
	}
	return { ran: outcomes.flatMap((o) => o.ran), unknown: outcomes.some((o) => o.unknown), blocked: outcomes.find((o) => o.blocked)?.blocked ?? null };
}

async function execute(sql: Sql, opts: Opts, ops: Record<string, WriteOp>): Promise<Outcome> {
	const ran: Ran[] = [];
	const halted: Stuck = { batches: new Set(), targets: new Set() };
	let blocked: string | null = null;

	const unsure =
		(await sql`select id::text, batch::text, op, target, key, params, display, status, readback from writes where status in ('已提交', '结果未知') order by writes.id`) as unknown as Row[];
	for (const w of unsure) {
		const op = ops[w.op];
		if (!op) continue;
		try {
			const r = await op.where(sql, w.params, () => op.check(w.params, w.readback?.before, false));
			if (r.done) {
				await set(sql, w.id, { status: "已核对", readback: sql.json({ ...w.readback, after: r.readback } as any), finished_at: new Date() });
				await op.after?.(sql, w.params);
				ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status: "已核对", why: "读回来看到做成了" });
				continue;
			}
			await set(sql, w.id, { status: "结果未知", readback: sql.json({ ...w.readback, after: r.readback } as any) });
		} catch (e) {
			if (e instanceof NeedsHuman) {
				blocked = e.message;
				break;
			}
			await set(sql, w.id, { status: "结果未知", error: (e as Error).message });
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
			await set(sql, w.id, { status, error: why, finished_at: new Date() });
			ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status, why });
		};
		const dup = op && !blocked ? await sql`select id::text from writes where key = ${w.key} and id <> ${w.id} and status in ${sql(DONE_OR_FLYING)}` : [];
		const no = gate(w, {
			known: Boolean(op),
			blocked,
			stuck: halted,
			untried: op?.untried,
			tried: Boolean(opts.tryOps?.includes(w.op)),
			dup: (dup[0]?.id as string | undefined) ?? null,
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
				await set(sql, w.id, {
					status: "已提交",
					params: sql.json(params as any),
					readback: sql.json({ before: prepared.before } as any),
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
				await set(sql, w.id, { started_at: null });
				blocked = outcome.blocked!;
				await skip(`没做：${blocked}`);
				continue;
			}
			await set(sql, w.id, {
				status: outcome.status,
				error: outcome.why ?? null,
				response: sql.json(outcome.response as any),
				readback: sql.json({ before: outcome.before, after: outcome.after } as any),
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
			if (e instanceof NeedsHuman) {
				blocked = e.message;
				if (now?.status !== "已提交") await skip(`没做：${blocked}`);
				continue;
			}
			if (now?.status === "已提交") {
				await set(sql, w.id, { status: "结果未知", error: (e as Error).message });
				halted.batches.add(w.batch);
				halted.targets.add(w.target);
				ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status: "结果未知", why: (e as Error).message });
			} else await skip((e as Error).message);
		}
	}
	return { ran, unknown: ran.some((r) => stuck(r.status)), blocked };
}
