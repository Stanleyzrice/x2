// x2 propose：agent 写一批待批准的写入，收件箱加一行「批准：……」。x2 approve：人在终端里说「批准」，agent 替人勾上。
// 只收检查算出来该做的：加购只收还没加购的订单行，预报只收付了款还没报的订单（x2 status --json 的 todo 里有现成的一批）
import { type Sql, host } from "./db/index.ts";
import { snapshot } from "./check/index.ts";
import { checkOrders, type ForecastParams, type CartParams } from "./check/orders.ts";
import { Usage } from "./errors.ts";
import { type WriteOp, WRITES } from "./site/writes.ts";

export type Proposal = { title: string; writes: { op: string; params: unknown }[] };

const IN_FLIGHT = ["待批准", "已批准", "已提交", "结果未知", "不一致"];

/** 检查现在认为该做的：加购的订单行（订单号:规格 id）、该预报的订单号 */
async function allowed(sql: Sql) {
	const r = checkOrders(await snapshot(sql));
	const cart = new Set<string>(), forecast = new Set<string>();
	for (const t of r.todo) {
		if (t.kind === "加购") for (const w of t.propose.writes) for (const l of (w.params as CartParams).lines) cart.add(`${l.sn}:${l.modelId}`);
		if (t.kind === "预报") for (const w of t.propose.writes) forecast.add((w.params as ForecastParams).sn);
	}
	return { cart, forecast };
}

export async function propose(sql: Sql, input: unknown, ops: Record<string, WriteOp> = WRITES): Promise<{ batch: string; writes: { id: string; display: string; status: string }[] }> {
	const p = input as Proposal;
	if (!p || typeof p.title !== "string" || !Array.isArray(p.writes) || p.writes.length === 0) throw new Usage("x2 propose 从 stdin 读 JSON：{ title, writes: [{ op, params }] }（x2 status --json 的 todo 里有现成的）");
	const ok = await allowed(sql);
	const rows = p.writes.map((w, i) => {
		const op = ops[w.op];
		if (!op) throw new Usage(`第 ${i + 1} 项：没有 ${w.op} 这个写操作（有：${Object.keys(ops).join("、")}）`);
		const parsed = op.params.safeParse(w.params);
		if (!parsed.success) throw new Usage(`第 ${i + 1} 项（${w.op}）参数不对：${parsed.error.issues.map((x) => `${x.path.join(".")}：${x.message}`).join("；")}`);
		const params = parsed.data as any;
		if (w.op === "加购") for (const l of (params as CartParams).lines) if (!ok.cart.has(`${l.sn}:${l.modelId}`)) throw new Usage(`第 ${i + 1} 项：订单 ${l.sn} 的规格 ${l.modelId} 现在不该加购（加过了、在等批准，或者货源不齐）。看 x2 status`);
		if (w.op === "预报" && !ok.forecast.has((params as ForecastParams).sn)) throw new Usage(`第 ${i + 1} 项：订单 ${(params as ForecastParams).sn} 现在不该预报（没付完款、报过了，或者在等批准）。看 x2 status`);
		return { op: w.op, params, target: op.target(params), key: op.key(params), display: op.display(params) };
	});

	const [{ needs }] = await sql`select forecast_needs_approval as needs from order_settings where id = 1` as any;
	return sql.begin(async (tx) => {
		const [{ batch }] = await tx`select nextval('batch_seq')::text as batch` as any;
		const out: { id: string; display: string; status: string }[] = [];
		for (const r of rows) {
			const flying = await tx`select id from writes where (key = ${r.key} or key like ${`${r.key}#%`}) and status in ${tx(IN_FLIGHT)} and include`;
			if (flying.length) throw new Usage(`${r.display}：写入 #${flying[0]!.id} 还没做完（待批准、结果未知……），不再准备新的`);
			// 同一个 key 做成过（例 加购的货从购物车里不见了，要重新加）：key 后面加次数，免得 x2 run 当成重复
			const [{ n }] = await tx`select count(*)::int as n from writes where key = ${r.key} or key like ${`${r.key}#%`}` as any;
			const key = n > 0 ? `${r.key}#${n + 1}` : r.key;
			const status = r.op === "预报" && !needs ? "已批准" : "待批准";
			const [w] = await tx`insert into writes (batch, op, target, params, display, key, status, host) values (${batch}, ${r.op}, ${r.target}, ${tx.json(r.params)}, ${r.display}, ${key}, ${status}, ${host}) returning id::text`;
			out.push({ id: w!.id, display: r.display, status });
		}
		if (out.some((w) => w.status === "待批准")) {
			await tx`
				insert into inbox (key, kind, title, detail) values (${`approve:${batch}`}, '批准', ${`批准：${p.title}`},
					${`${out.map((w) => `· ${w.display}`).join("\n")}\n\n勾「批准」就批准整批；要去掉几项，在「写入」里把那几行的「做」取消勾`})`;
		}
		return { batch, writes: out };
	});
}

/** 人在终端里说「批准」：agent 替人在收件箱里勾上 */
export async function approve(sql: Sql, batch: string): Promise<number> {
	const r = await sql`update inbox set approve = true, updated_at = now() where key = ${`approve:${batch}`} and open returning key`;
	if (r.length === 0) throw new Usage(`收件箱里没有开着的「批准」第 ${batch} 批`);
	const [{ n }] = await sql`select count(*)::int as n from writes where batch = ${batch} and status = '待批准' and include` as any;
	return n;
}
