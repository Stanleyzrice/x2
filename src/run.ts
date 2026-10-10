// x2 run：执行批准了的写入。写只有一条路：agent 准备写入 → 人在收件箱批准 → 先记意图 → 提交一次 → 读回来核对。
// 1. 收件箱里勾了「批准」的批次：勾着「执行」的写入改成已批准，取消勾的改成未执行
// 2. 先核清：已提交（记了意图、进程挂了）、结果未知的写入，读回来；还核不清的，它所在的批次这次不做，同一个对象上的也不做
// 3. 一批一批、一个一个执行：现读（还该不该做）→ 记意图（已提交）→ 提交一次 → 读回来。结果未知就停下这一批，不重发
import { type Sql, host } from "./db/index.ts";
import { NeedsHuman } from "./errors.ts";
import { type WriteOp, WRITES } from "./site/writes.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Ran = { id: string; batch: string; op: string; display: string; status: string; why?: string };

type Row = { id: string; batch: string; op: string; target: string; key: string; params: any; display: string; status: string; readback: any };

async function set(sql: Sql, id: string, fields: Record<string, unknown>) {
	await sql`update writes set ${sql(fields as any)} where id = ${id}`;
}

/** ops：写操作的声明（测试换成假的） */
export async function run(sql: Sql, opts: { batch?: string; tryOps?: string[] } = {}, ops: Record<string, WriteOp> = WRITES): Promise<{ ran: Ran[]; unknown: boolean; blocked: string | null }> {
	// 1. 批准
	const approved = await sql`select split_part(key, ':', 2) as batch from inbox where kind = '批准' and open and approve`;
	for (const { batch } of approved) {
		await sql`update writes set status = '已批准' where batch = ${batch} and status = '待批准' and include`;
		await sql`update writes set status = '未执行', error = '批准前取消了勾', finished_at = now() where batch = ${batch} and status = '待批准' and not include`;
	}

	const ran: Ran[] = [];
	const stuckBatches = new Set<string>(), stuckTargets = new Set<string>();
	let blocked: string | null = null;

	// 2. 核清（给了批次只核这一批的：做商品稿时译图跑自己那一批，不顺带去读 1688 的购物车）
	const unsure = await sql`select id::text, batch::text, op, target, key, params, display, status, readback from writes where status in ('已提交', '结果未知') ${opts.batch ? sql`and batch = ${opts.batch}` : sql``} order by id` as unknown as Row[];
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
			if (e instanceof NeedsHuman) { blocked = e.message; break; }
			await set(sql, w.id, { status: "结果未知", error: (e as Error).message });
		}
		stuckBatches.add(w.batch);
		stuckTargets.add(w.target);
		ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status: "结果未知", why: "读回来还看不出做没做：到站点上看一眼，在「写入」里改成已核对或被拒" });
	}
	if (blocked) return { ran, unknown: ran.some((r) => r.status === "结果未知"), blocked };

	// 3. 执行
	const todo = await sql`
		select id::text, batch::text, op, target, key, params, display, status, readback from writes
		where status = '已批准' and include ${opts.batch ? sql`and batch = ${opts.batch}` : sql``} order by batch, id` as unknown as Row[];
	let last = 0;
	for (const w of todo) {
		const op = ops[w.op];
		const skip = async (why: string, status = "未执行") => {
			await set(sql, w.id, { status, error: why, finished_at: new Date() });
			ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status, why });
		};
		if (!op) { await skip(`没有 ${w.op} 这个写操作`); continue; }
		if (stuckBatches.has(w.batch) || stuckTargets.has(w.target)) {
			ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status: "已批准", why: "这一批（或同一个对象）有结果未知的写入：先核清再做" });
			continue;
		}
		if (op.untried && !opts.tryOps?.includes(w.op)) {
			ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status: "已批准", why: op.untried });
			continue;
		}
		const dup = await sql`select id from writes where key = ${w.key} and id <> ${w.id} and status in ('成功', '已核对', '已提交', '结果未知', '不一致')`;
		if (dup.length) { await skip(`重复：写入 #${dup[0]!.id} 已经做过（或还没核清）`); continue; }

		if (last && Date.now() - last < 3000) await sleep(3000 - (Date.now() - last));
		last = Date.now();
		console.error(`${w.op}：${w.display}`);
		try {
			const outcome = await op.where(sql, w.params, async () => {
				const prepared = await op.prepare(sql, w.params);
				if ("skip" in prepared) return { skip: prepared.skip };
				const params = prepared.params;
				// 记意图：从这一刻起，没有结果的都当结果未知
				await set(sql, w.id, { status: "已提交", params: sql.json(params as any), readback: sql.json({ before: prepared.before } as any), started_at: new Date(), host });
				const sent = await op.submit(sql, params);
				if (sent.kind === "blocked") return { blocked: sent.why, params };
				if (sent.kind === "refused") return { status: "被拒", why: sent.why, response: sent, params };
				let r: { done: boolean | null; readback: unknown };
				try { r = await op.check(params, prepared.before, true); } catch (e) { r = { done: null, readback: { error: (e as Error).message } }; }
				const status = r.done === true ? "已核对" : r.done === false ? (sent.kind === "done" ? "不一致" : "被拒") : "结果未知";
				const why = r.done === true ? undefined : r.done === false ? (sent.kind === "done" ? "站点说做了，读回来没有" : `没做成：${sent.why}`) : `读回来看不出做没做${sent.kind === "unknown" ? `（${sent.why}）` : ""}`;
				return { status, why, response: sent, after: r.readback, before: prepared.before, params };
			});
			if ("skip" in outcome) { await skip(outcome.skip!); continue; }
			if ("blocked" in outcome) {
				// 请求没发出去：退回已批准，处理好登录再跑
				await set(sql, w.id, { status: "已批准", started_at: null });
				blocked = outcome.blocked!;
				break;
			}
			await set(sql, w.id, {
				status: outcome.status, error: outcome.why ?? null, response: sql.json(outcome.response as any),
				readback: sql.json({ before: outcome.before, after: outcome.after } as any), finished_at: new Date(),
			});
			if (outcome.status === "已核对") await op.after?.(sql, outcome.params);
			ran.push({ id: w.id, batch: w.batch, op: w.op, display: w.display, status: outcome.status!, why: outcome.why });
			if (outcome.status === "结果未知" || outcome.status === "不一致") { stuckBatches.add(w.batch); stuckTargets.add(w.target); }
		} catch (e) {
			if (e instanceof NeedsHuman) {
				// 现读时就要人处理（还没记意图）：留在已批准；记了意图的留在已提交，下一轮当结果未知核
				blocked = e.message;
				break;
			}
			const [now] = await sql`select status from writes where id = ${w.id}`;
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
