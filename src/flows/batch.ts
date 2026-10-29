// 一批写入：人在终端里同意了，agent 用 x2 do 交一批（x2 status --json 的 todo 里有现成的），这里校验、记进库（待执行），再交给 run.ts 执行。
// 建商品、上架不走这里：x2 listing publish 照检查算出来的写入记进库。
// 加购、预报只收检查算出来该做的：加购只收还没加购的订单行，预报只收付了款还没报的订单
import type postgres from "postgres";
import { host, type Sql } from "../core/db.ts";
import { Usage } from "../core/errors.ts";
import type { Batch, CartParams, ForecastParams } from "../domain/orders/check.ts";
import { current } from "./check.ts";
import { WRITES, type WriteOp } from "./writes.ts";

const IN_FLIGHT = ["待执行", "已提交", "结果未知", "不一致"];

type Row = { op: string; params: unknown; target: string; key: string; display: string };

/** 一批写入记进库（新的批次，待执行）：同一个对象还有没核清的就不记 */
export async function addWrites(tx: Sql | postgres.TransactionSql, rows: Row[]): Promise<string> {
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

/** 校验 x2 do 交来的一批，记进库，回批次 */
export async function addBatch(sql: Sql, input: unknown, ops: Record<string, WriteOp> = WRITES): Promise<string> {
	const p = input as Batch;
	if (!p || typeof p.title !== "string" || !Array.isArray(p.writes) || p.writes.length === 0)
		throw new Usage("x2 do 从 stdin 读 JSON：{ title, writes: [{ op, params }] }（x2 status --json 的 todo 里有现成的）");
	// 加购、预报只收检查算出来该做的：现读一遍再对（别的写操作不用）
	const ok = p.writes.some((w) => w.op === "加购" || w.op === "预报") ? (await current(sql)).planned : { cart: new Set<string>(), forecast: new Set<string>() };
	const [{ buy }] = (await sql`select buy_account as buy from order_settings where id = 1`) as any;
	const rows = p.writes.map((w, i) => {
		const op = ops[w.op];
		if (!op) throw new Usage(`第 ${i + 1} 项：没有 ${w.op} 这个写操作（有：${Object.keys(ops).join("、")}）`);
		if (w.op === "建商品" || w.op === "上架") throw new Usage(`第 ${i + 1} 项：建商品、上架用 x2 listing publish <商品稿>`);
		const parsed = op.params.safeParse(w.params);
		if (!parsed.success)
			throw new Usage(`第 ${i + 1} 项（${w.op}）参数不对：${parsed.error.issues.map((x) => `${x.path.join(".")}：${x.message}`).join("；")}`);
		const params = parsed.data as any;
		// 只往采购账号加购：没写账号的填上它
		if (w.op === "加购" && buy) {
			if (params.account && params.account !== buy) throw new Usage(`第 ${i + 1} 项：只往采购账号（${buy}）加购，不往 ${params.account} 加`);
			params.account = buy;
		}
		if (w.op === "加购")
			for (const l of (params as CartParams).lines)
				if (!ok.cart.has(`${l.sn}:${l.modelId}`))
					throw new Usage(`第 ${i + 1} 项：订单 ${l.sn} 的规格 ${l.modelId} 现在不该加购（加过了、还没核清，或者货源不齐）。看 x2 status`);
		if (w.op === "预报" && !ok.forecast.has((params as ForecastParams).sn))
			throw new Usage(`第 ${i + 1} 项：订单 ${(params as ForecastParams).sn} 现在不该预报（没付完款、报过了，或者还没核清）。看 x2 status`);
		return { op: w.op, params, target: op.target(params), key: op.key(params), display: op.display(params) };
	});
	return sql.begin((tx) => addWrites(tx, rows));
}
