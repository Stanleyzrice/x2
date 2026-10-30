// 知虾镜像（市场数据的库）：POST <MARKET_URL>/api/sql { sql }，带 Authorization: Bearer <MARKET_SECRET>。只读，一次最多 5000 行、5 秒。
// 地址、密钥只在 .env 里，不进日志
import { z } from "zod";
import { NeedsHuman } from "../../../platform/errors.ts";
import { reply } from "../../../platform/reply.ts";

export type Rows = { rows: Record<string, unknown>[] };

const row = z.looseObject({});
/** 成功的回包：行的数组，或 { rows } */
const ok = z.union([z.array(row), z.looseObject({ rows: z.array(row).nullish() })]);
/** 出错的回包：error 或 message 里是原因 */
const failed = z.looseObject({ error: z.unknown().optional(), message: z.unknown().optional() }).nullable();

/** 成功的回包 → 行（纯函数） */
export function rowsOf(body: unknown): Rows {
	const b = reply(ok, body, "知虾镜像 /api/sql");
	return { rows: Array.isArray(b) ? b : (b.rows ?? []) };
}

export async function query(sql: string): Promise<Rows> {
	const url = process.env.MARKET_URL,
		secret = process.env.MARKET_SECRET;
	if (!url || !secret) throw new NeedsHuman("没有设 MARKET_URL、MARKET_SECRET（写在 .env 里）");
	const r = await fetch(`${url.replace(/\/$/, "")}/api/sql`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
		body: JSON.stringify({ sql }),
		signal: AbortSignal.timeout(15_000),
	});
	const body: unknown = await r.json().catch(() => null);
	if (r.status === 401 || r.status === 403) throw new NeedsHuman(`知虾镜像不认 MARKET_SECRET（${r.status}）`);
	if (!r.ok) {
		const f = failed.safeParse(body).data;
		throw new Error(`知虾镜像回 ${r.status}：${f?.error ?? f?.message ?? JSON.stringify(body)?.slice(0, 300)}`);
	}
	return rowsOf(body);
}
