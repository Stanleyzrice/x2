// 执行写入：人在终端里同意了（x2 do、x2 listing publish 把一批记进库，待执行），先记意图 → 提交一次 → 读回来核对。x2 verify 只做第 1 步。
// 1. 先核清：已提交（记了意图、进程挂了）、结果未知的写入，读回来；还核不清的，同一个对象上的这次不做
// 2. 这一批一个一个执行：现读（还该不该做）→ 记意图（已提交）→ 提交一次 → 读回来。结果未知就停下这一批，不重发；没做的标成未执行，写明原因
// 3. 执行完：涉及的商品稿按检查的规则重算当前步骤、说明，写回库（不读站点）

import { host, type Sql } from "../core/db.ts";
import { NeedsHuman } from "../core/errors.ts";
import { listingsCheck } from "./check.ts";
import { WRITES, type WriteOp } from "./writes.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Ran = { id: string; batch: string; op: string; display: string; status: string; why?: string };

type Row = { id: string; batch: string; op: string; target: string; key: string; params: any; display: string; status: string; readback: any };

async function set(sql: Sql, id: string, fields: Record<string, unknown>) {
	await sql`update writes set ${sql(fields as any)} where id = ${id}`;
}

/** batch：要执行的那一批（不给只核清）；only：只核清这一批的（做商品稿时译图跑自己那一批，不顺带去读 1688 的购物车）；tryOps：还没在真站点上跑过、和运营约好一起跑的写操作 */
type Opts = { batch?: string; only?: boolean; tryOps?: string[] };
export type Outcome = { ran: Ran[]; unknown: boolean; blocked: string | null };

/** ops：写操作的声明（测试换成假的） */
export async function run(sql: Sql, opts: Opts = {}, ops: Record<string, WriteOp> = WRITES): Promise<Outcome> {
	const r = await execute(sql, opts, ops);
	await refreshListings(sql, r.ran);
	return r;
}

/** 3. 这一次碰过的商品稿（建商品、上架的写入）马上重算当前步骤，网页上不用等下一次 x2 status。出错只记在 stderr：写入的结果照样要报给人 */
async function refreshListings(sql: Sql, ran: Ran[]): Promise<void> {
	const ids = [...new Set(ran.map((x) => x.id))];
	if (!ids.length) return;
	try {
		const rows = await sql`select params->>'listingId' as id from writes where id in ${sql(ids)} and op in ('建商品', '上架') and params ? 'listingId'`;
		if (rows.length) await listingsCheck(sql, [...new Set(rows.map((x) => x.id as string))]);
	} catch (e) {
		console.error(`更新商品稿的当前步骤没成功（下一次 x2 status 会再算）：${(e as Error).message}`);
	}
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
