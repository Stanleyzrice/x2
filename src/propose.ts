// x2 propose：agent 写一批待批准的写入，收件箱加一行「批准：……」。x2 approve：人在终端里说「批准」，agent 替人勾上。
// 建商品、上架不走这里：人在商品稿上勾「批准上架」，x2 run 照勾生成写入（run.ts）
// 只收检查算出来该做的：加购只收还没加购的订单行，预报只收付了款还没报的订单（x2 status --json 的 todo 里有现成的一批）
import type postgres from "postgres";
import { type Sql, host } from "./db/index.ts";
import { current } from "./check/index.ts";
import type { CartParams, ForecastParams } from "./check/orders.ts";
import { Usage } from "./errors.ts";
import { type WriteOp, WRITES } from "./site/writes.ts";

export type Proposal = { title: string; writes: { op: string; params: unknown }[] };

const IN_FLIGHT = ["待批准", "已批准", "已提交", "结果未知", "不一致"];

type Row = { op: string; params: unknown; target: string; key: string; display: string; status: string };

/** 一批写入记进库（新的批次）：同一个对象还有没做完的（待批准、结果未知……）就不准备新的。x2 propose 和 x2 run 照「批准上架」生成写入都用它 */
export async function addWrites(tx: Sql | postgres.TransactionSql, rows: Row[]): Promise<{ batch: string; writes: { id: string; display: string; status: string }[] }> {
	const [{ batch }] = await tx`select nextval('batch_seq')::text as batch` as any;
	const out: { id: string; display: string; status: string }[] = [];
	for (const r of rows) {
		const flying = await tx`select id from writes where (key = ${r.key} or key like ${`${r.key}#%`}) and status in ${tx(IN_FLIGHT)} and include`;
		if (flying.length) throw new Usage(`${r.display}：写入 #${flying[0]!.id} 还没做完（待批准、结果未知……），不再准备新的`);
		// 同一个 key 做成过、被拒过（例 加购的货从购物车里不见了，要重新加）：key 后面加次数，免得 x2 run 当成重复
		const [{ n }] = await tx`select count(*)::int as n from writes where key = ${r.key} or key like ${`${r.key}#%`}` as any;
		const key = n > 0 ? `${r.key}#${n + 1}` : r.key;
		const [w] = await tx`insert into writes (batch, op, target, params, display, key, status, host) values (${batch}, ${r.op}, ${r.target}, ${tx.json(r.params as any)}, ${r.display}, ${key}, ${r.status}, ${host}) returning id::text`;
		out.push({ id: w!.id, display: r.display, status: r.status });
	}
	return { batch, writes: out };
}

export async function propose(sql: Sql, input: unknown, ops: Record<string, WriteOp> = WRITES): Promise<{ batch: string; writes: { id: string; display: string; status: string }[] }> {
	const p = input as Proposal;
	if (!p || typeof p.title !== "string" || !Array.isArray(p.writes) || p.writes.length === 0) throw new Usage("x2 propose 从 stdin 读 JSON：{ title, writes: [{ op, params }] }（x2 status --json 的 todo 里有现成的）");
	// 加购、预报只收检查算出来该做的：现读一遍再对（别的写操作不用）
	const ok = p.writes.some((w) => w.op === "加购" || w.op === "预报") ? (await current(sql)).planned : { cart: new Set<string>(), forecast: new Set<string>() };
	const [{ needs, buy }] = await sql`select forecast_needs_approval as needs, buy_account as buy from order_settings where id = 1` as any;
	const rows = p.writes.map((w, i) => {
		const op = ops[w.op];
		if (!op) throw new Usage(`第 ${i + 1} 项：没有 ${w.op} 这个写操作（有：${Object.keys(ops).join("、")}）`);
		if (w.op === "建商品" || w.op === "上架") throw new Usage(`第 ${i + 1} 项：建商品、上架不经 x2 propose：人在 NocoDB「商品稿」里勾「批准上架」（人在终端里说批准，用 x2 listing approve <商品稿>），x2 run 执行`);
		const parsed = op.params.safeParse(w.params);
		if (!parsed.success) throw new Usage(`第 ${i + 1} 项（${w.op}）参数不对：${parsed.error.issues.map((x) => `${x.path.join(".")}：${x.message}`).join("；")}`);
		const params = parsed.data as any;
		// 只往采购账号加购：没写账号的填上它
		if (w.op === "加购" && buy) {
			if (params.account && params.account !== buy) throw new Usage(`第 ${i + 1} 项：只往采购账号（${buy}）加购，不往 ${params.account} 加`);
			params.account = buy;
		}
		if (w.op === "加购") for (const l of (params as CartParams).lines) if (!ok.cart.has(`${l.sn}:${l.modelId}`)) throw new Usage(`第 ${i + 1} 项：订单 ${l.sn} 的规格 ${l.modelId} 现在不该加购（加过了、待批准，或者货源不齐）。看 x2 status`);
		if (w.op === "预报" && !ok.forecast.has((params as ForecastParams).sn)) throw new Usage(`第 ${i + 1} 项：订单 ${(params as ForecastParams).sn} 现在不该预报（没付完款、报过了，或者待批准）。看 x2 status`);
		return { op: w.op, params, target: op.target(params), key: op.key(params), display: op.display(params) };
	});

	return sql.begin(async (tx) => {
		const { batch, writes: out } = await addWrites(tx, rows.map((r) => ({ ...r, status: r.op === "预报" && !needs ? "已批准" : "待批准" })));
		if (out.some((w) => w.status === "待批准")) {
			await tx`
				insert into inbox (key, kind, title, detail) values (${`approve:${batch}`}, '批准', ${`批准：${p.title}`},
					${`${out.map((w) => `· ${w.display}`).join("\n")}\n\n勾「批准」即批准整批；要去掉几项，在「写入」里取消那几行的「执行」`})`;
		}
		return { batch, writes: out };
	});
}

/** 人在终端里说「批准」：agent 替人在收件箱里勾上 */
export async function approve(sql: Sql, batch: string): Promise<number> {
	const r = await sql`update inbox set approve = true, updated_at = now() where key = ${`approve:${batch}`} and open returning key`;
	if (r.length === 0) throw new Usage(`收件箱里没有未关闭的「批准」第 ${batch} 批`);
	const [{ n }] = await sql`select count(*)::int as n from writes where batch = ${batch} and status = '待批准' and include` as any;
	return n;
}
