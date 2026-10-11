// x2 run：执行批准了的写入。写只有一条路：agent 准备写入 → 人在收件箱批准 → 先记意图 → 提交一次 → 读回来核对。
// 1. 收件箱里勾了「批准」的批次：勾着「执行」的写入改成已批准，取消勾的改成未执行
// 2. 先核清：已提交（记了意图、进程挂了）、结果未知的写入，读回来；还核不清的，它所在的批次这次不做，同一个对象上的也不做
// 3. 一批一批、一个一个执行：现读（还该不该做）→ 记意图（已提交）→ 提交一次 → 读回来。结果未知就停下这一批，不重发
// 0. 上品：人勾了「批准上架」的商品稿，先按检查的规则重算（内容和勾的时候对不上就去掉勾），勾着、内容没变的生成建商品、上架的写入（已批准，一份商品稿一批）；
//    放弃了的商品稿还没提交的建商品、上架标成未执行
// 4. 执行完（成功、被拒、不一致、结果未知、未执行都算）：涉及的商品稿按检查的规则重算当前步骤、说明，写回库（不读站点；收件箱等 x2 status 重算）
import { listingsCheck } from "./check/index.ts";
import { type Sql, host } from "./db/index.ts";
import { NeedsHuman, Usage } from "./errors.ts";
import { addWrites } from "./propose.ts";
import { type WriteOp, WRITES } from "./site/writes.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Ran = { id: string; batch: string; op: string; display: string; status: string; why?: string };

type Row = { id: string; batch: string; op: string; target: string; key: string; params: any; display: string; status: string; readback: any };

async function set(sql: Sql, id: string, fields: Record<string, unknown>) {
	await sql`update writes set ${sql(fields as any)} where id = ${id}`;
}

type Opts = { batch?: string; tryOps?: string[] };
type Outcome = { ran: Ran[]; unknown: boolean; blocked: string | null };

/** ops：写操作的声明（测试换成假的） */
export async function run(sql: Sql, opts: Opts = {}, ops: Record<string, WriteOp> = WRITES): Promise<Outcome> {
	// 给了批次的（做商品稿时译图跑自己那一批）不碰商品稿的勾
	const dropped = opts.batch ? [] : await approvedListings(sql, ops);
	const r = await execute(sql, opts, ops);
	const ran = [...dropped, ...r.ran];
	await refreshListings(sql, ran);
	return { ...r, ran };
}

/** 0. 勾了「批准上架」、还没上架的商品稿：重算（去掉内容变了的勾），勾着、内容没变的生成写入。
 * 以前经 x2 propose 准备、还待批准的建商品、上架不再执行（批准改成了勾）：标成未执行。
 * 商品稿放弃了：还没提交的建商品、上架不执行，标成未执行（只看库，不用等浏览器），回这几项 */
async function approvedListings(sql: Sql, ops: Record<string, WriteOp>): Promise<Ran[]> {
	await sql`update writes set status = '未执行', error = '建商品、上架改成在商品稿上勾「批准上架」：这一项不再执行', finished_at = now() where op in ('建商品', '上架') and status = '待批准'`;
	const dropped = (await sql`
		with d as (
			update writes w set status = '未执行', error = '商品稿已放弃', finished_at = now() from listings l
			where w.op in ('建商品', '上架') and w.status = '已批准' and w.include and w.params->>'listingId' = l.id::text and l.cancelled
			returning w.id, w.batch, w.op, w.display)
		select id::text, batch::text, op, display from d order by id`).map((w): Ran => ({ id: w.id, batch: w.batch, op: w.op, display: w.display, status: "未执行", why: "商品稿已放弃" }));
	const ids = (await sql`select id::text from listings where approve and not cancelled and listed_at is null order by id`).map((x) => x.id as string);
	if (!ids.length) return dropped;
	const r = await listingsCheck(sql, ids);
	for (const l of r.approved) {
		const rows = l.writes.map((w) => {
			const op = ops[w.op];
			if (!op) throw new Error(`没有 ${w.op} 这个写操作`);
			const params = op.params.parse(w.params);
			return { op: w.op, params, target: op.target(params), key: op.key(params), display: op.display(params), status: "已批准" };
		});
		// 同一个对象还有没做完的（另一个 x2 run 刚生成）：这次不再生成
		await sql.begin((tx) => addWrites(tx, rows)).catch((e) => { if (!(e instanceof Usage)) throw e; });
	}
	return dropped;
}

/** 4. 这一次碰过的商品稿（建商品、上架的写入）：建商品、上架被拒或没执行的去掉勾（原因写进说明，改好了再勾，免得每次 x2 run 都再交一次），
 * 再马上重算当前步骤，NocoDB 里不用等下一次 x2 status。出错只记在 stderr：写入的结果照样要报给人 */
async function refreshListings(sql: Sql, ran: Ran[]): Promise<void> {
	const ids = [...new Set(ran.map((x) => x.id))];
	if (!ids.length) return;
	try {
		const rows = await sql`select id::text as write, params->>'listingId' as id from writes where id in ${sql(ids)} and op in ('建商品', '上架') and params ? 'listingId'`;
		const why = new Map<string, string>();
		for (const x of ran) {
			const l = rows.find((r) => r.write === x.id)?.id as string | undefined;
			if (l && (x.status === "被拒" || x.status === "未执行") && !why.has(l)) why.set(l, `${x.op}${x.status}：${x.why ?? ""}。去掉了勾：改好了再勾「批准上架」`);
		}
		for (const [id, w] of why) await sql`update listings set approve = false, unapproved_why = ${w} where id = ${id} and approve`;
		if (rows.length) await listingsCheck(sql, [...new Set(rows.map((x) => x.id as string))]);
	} catch (e) {
		console.error(`更新商品稿的当前步骤没成功（下一次 x2 status 会再算）：${(e as Error).message}`);
	}
}

async function execute(sql: Sql, opts: Opts, ops: Record<string, WriteOp>): Promise<Outcome> {
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
	const unsure = await sql`select id::text, batch::text, op, target, key, params, display, status, readback from writes where status in ('已提交', '结果未知') ${opts.batch ? sql`and batch = ${opts.batch}` : sql``} order by writes.id` as unknown as Row[];
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

	// 3. 执行（按数字排：选出来的 id、batch 是文本，按它排 10 会排在 9 前面）
	const todo = await sql`
		select id::text, batch::text, op, target, key, params, display, status, readback from writes
		where status = '已批准' and include ${opts.batch ? sql`and batch = ${opts.batch}` : sql``} order by writes.batch, writes.id` as unknown as Row[];
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
