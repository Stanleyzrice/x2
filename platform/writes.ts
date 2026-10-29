// 写入引擎：改外面的系统（站点、服务）都经它。skill 的写工具排好一批或几批（tool.ts 的 plan），人在终端里同意了 agent 才调；x2 verify 只做第 1 步。
// 写操作（WriteOp，toolkit 的 writes 注册）分四步，这里按顺序调：
// - prepare：现读，看还该不该做（订单取消了、货源下架了就不做），记下做之前站点上是什么样（before）
// - 记意图：把写入改成「已提交」再提交（进程这时挂了，下一轮当结果未知，先读回来）
// - submit：提交一次，回三态：做了、被拒、结果未知（没拿到答复）
// - check：读回来，和 before 比：做了、没做、看不出（看不出就是结果未知，不重发）
// 执行：
// 1. 先核清：已提交（记了意图、进程挂了）、结果未知的写入，读回来；还核不清的，同一个对象上的这次不做
// 2. 这一批一个一个执行：现读 → 记意图 → 提交一次 → 读回来。结果未知就停下这一批，不重发；没做的标成未执行，写明原因
// 3. 执行完：告诉注册了 written 的 skill（例 上品重算碰过的商品稿的当前步骤）
import type postgres from "postgres";
import type { z } from "zod";
import { host, type Sql } from "./db/index.ts";
import { NeedsHuman, Usage } from "./errors.ts";
import { type Planned, toolkits, writeOps } from "./tool.ts";

export type Submitted =
	| { kind: "done"; data?: unknown }
	| { kind: "refused"; why: string }
	| { kind: "blocked"; why: string }
	| { kind: "unknown"; why: string };
export type Prepared<P> = { skip: string } | { params: P; before: unknown };

export type WriteOp<P = any> = {
	describe: string;
	params: z.ZodType<P>;
	/** 对象：同一个对象上有没核清的写入，先读回来，再准备新的 */
	target: (p: P) => string;
	/** 防重复的 key：同一个 key 已有成功、结果未知的写入，不再提交 */
	key: (p: P) => string;
	/** 给人看的一行 */
	display: (p: P) => string;
	/** 结果未知时人去哪里看 */
	link?: string;
	/** 还没在真站点上跑过：第一次要和运营约好一个对象，一起跑（写工具加 --try） */
	untried?: string;
	/** 在哪个浏览器里做 */
	where: <T>(sql: Sql, p: P, fn: () => Promise<T>) => Promise<T>;
	prepare: (sql: Sql, p: P) => Promise<Prepared<P>>;
	submit: (sql: Sql, p: P) => Promise<Submitted>;
	/** fresh：刚提交完就读（这时没变化就是没做）；不是 fresh 时（过了一阵再核）没变化也可能是人动过，只认「做了」 */
	check: (p: P, before: any, fresh: boolean) => Promise<{ done: boolean | null; readback: unknown }>;
	/** 做成了以后在库里记的（例 随加购一起定下的货源写进规格） */
	after?: (sql: Sql, p: P) => Promise<void>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Ran = { id: string; batch: string; op: string; display: string; status: string; why?: string };

type Row = { id: string; batch: string; op: string; target: string; key: string; params: any; display: string; status: string; readback: any };

async function set(sql: Sql, id: string, fields: Record<string, unknown>) {
	await sql`update writes set ${sql(fields as any)} where id = ${id}`;
}

/** batch：要执行的那一批（不给只核清）；only：只核清这一批的（做商品稿时译图跑自己那一批，不顺带去读 1688 的购物车）；tryOps：还没在真站点上跑过、和运营约好一起跑的写操作 */
type Opts = { batch?: string; only?: boolean; tryOps?: string[] };
export type Outcome = { ran: Ran[]; unknown: boolean; blocked: string | null };

/** ops：写操作的声明（不给是注册了的；测试换成假的） */
export async function run(sql: Sql, opts: Opts = {}, ops: Record<string, WriteOp> = writeOps()): Promise<Outcome> {
	const r = await execute(sql, opts, ops);
	// 3. 出错只记在 stderr：写入的结果照样要报给人
	if (r.ran.length)
		for (const k of toolkits())
			await k.written?.(sql, r.ran).catch((e: Error) => console.error(`${k.title}：执行完写入后更新没成功（下一次 x2 status 会再算）：${e.message}`));
	return r;
}

const IN_FLIGHT = ["待执行", "已提交", "结果未知", "不一致"];

type NewRow = { op: string; params: unknown; target: string; key: string; display: string };

/** 一批写入记进库（新的批次，待执行）：同一个对象还有没核清的就不记 */
export async function addWrites(tx: Sql | postgres.TransactionSql, rows: NewRow[]): Promise<string> {
	const [{ batch }] = (await tx`select nextval('batch_seq')::text as batch`) as any;
	for (const r of rows) {
		const flying = await tx`select id from writes where (key = ${r.key} or key like ${`${r.key}#%`}) and status in ${tx(IN_FLIGHT)}`;
		if (flying.length) throw new Usage(`${r.display}：写入 #${flying[0]!.id} 还没核清（x2 verify），不再做新的`);
		// 同一个 key 做成过、被拒过（例 加购的货从购物车里不见了，要重新加）：key 后面加次数，免得当成重复
		const [{ n }] = (await tx`select count(*)::int as n from writes where key = ${r.key} or key like ${`${r.key}#%`}`) as any;
		const key = n > 0 ? `${r.key}#${n + 1}` : r.key;
		await tx`insert into writes (batch, op, target, params, display, key, status, host) values (${batch}, ${r.op}, ${r.target}, ${tx.json(r.params as any)}, ${r.display}, ${key}, '待执行', ${host})`;
	}
	return batch;
}

/** 写工具排好的几批：一批一批记进库、马上执行（参数照写操作的声明校验）；有一批要人处理就停下。try：跑还没在真站点上跑过的写操作 */
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
	const stuckBatches = new Set<string>(),
		stuckTargets = new Set<string>();
	let blocked: string | null = null;

	// 1. 核清
	const unsure =
		(await sql`select id::text, batch::text, op, target, key, params, display, status, readback from writes where status in ('已提交', '结果未知') ${opts.only && opts.batch ? sql`and batch = ${opts.batch}` : sql``} order by writes.id`) as unknown as Row[];
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
		stuckBatches.add(w.batch);
		stuckTargets.add(w.target);
		ran.push({
			id: w.id,
			batch: w.batch,
			op: w.op,
			display: w.display,
			status: "结果未知",
			why: "读回来还看不出做没做：请人到站点上看一眼，x2 resolve 记成已核对或被拒",
		});
	}

	// 2. 执行这一批（按数字排：选出来的 id 是文本，按它排 10 会排在 9 前面）
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
		if (!op) {
			await skip(`没有 ${w.op} 这个写操作`);
			continue;
		}
		if (blocked) {
			await skip(`没做：${blocked}`);
			continue;
		}
		if (stuckBatches.has(w.batch) || stuckTargets.has(w.target)) {
			await skip("这一批（或同一个对象）有结果未知的写入：先核清再做");
			continue;
		}
		if (op.untried && !opts.tryOps?.includes(w.op)) {
			await skip(op.untried);
			continue;
		}
		const dup = await sql`select id from writes where key = ${w.key} and id <> ${w.id} and status in ('成功', '已核对', '已提交', '结果未知', '不一致')`;
		if (dup.length) {
			await skip(`重复：写入 #${dup[0]!.id} 已经做过（或还没核清）`);
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
				// 记意图：从这一刻起，没有结果的都当结果未知
				await set(sql, w.id, {
					status: "已提交",
					params: sql.json(params as any),
					readback: sql.json({ before: prepared.before } as any),
					started_at: new Date(),
					host,
				});
				const sent = await op.submit(sql, params);
				if (sent.kind === "blocked") return { blocked: sent.why, params };
				if (sent.kind === "refused") return { status: "被拒", why: sent.why, response: sent, params };
				let r: { done: boolean | null; readback: unknown };
				try {
					r = await op.check(params, prepared.before, true);
				} catch (e) {
					r = { done: null, readback: { error: (e as Error).message } };
				}
				const status = r.done === true ? "已核对" : r.done === false ? (sent.kind === "done" ? "不一致" : "被拒") : "结果未知";
				const why =
					r.done === true
						? undefined
						: r.done === false
							? sent.kind === "done"
								? "站点说做了，读回来没有"
								: `没做成：${sent.why}`
							: `读回来看不出做没做${sent.kind === "unknown" ? `（${sent.why}）` : ""}`;
				return { status, why, response: sent, after: r.readback, before: prepared.before, params };
			});
			if ("skip" in outcome) {
				await skip(outcome.skip!);
				continue;
			}
			if ("blocked" in outcome) {
				// 请求没发出去：没做，处理好登录再交一次
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
			if (outcome.status === "结果未知" || outcome.status === "不一致") {
				stuckBatches.add(w.batch);
				stuckTargets.add(w.target);
			}
		} catch (e) {
			const [now] = await sql`select status from writes where id = ${w.id}`;
			if (e instanceof NeedsHuman) {
				// 现读时就要人处理（还没记意图）：没做；记了意图的留在已提交，下次当结果未知核
				blocked = e.message;
				if (now?.status !== "已提交") await skip(`没做：${blocked}`);
				continue;
			}
			if (now?.status === "已提交") {
				await set(sql, w.id, { status: "结果未知", error: (e as Error).message });
				stuckBatches.add(w.batch);
				stuckTargets.add(w.target);
				ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status: "结果未知", why: (e as Error).message });
			} else await skip((e as Error).message);
		}
	}
	return { ran, unknown: ran.some((r) => r.status === "结果未知" || r.status === "不一致"), blocked };
}
