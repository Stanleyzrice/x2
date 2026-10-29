// 知虾镜像（市场数据的库）：POST <MARKET_URL>/api/sql { sql }，带 Authorization: Bearer <MARKET_SECRET>。只读，一次最多 5000 行、5 秒。
// 地址、密钥只在 .env 里，不进日志
import { NeedsHuman } from "../../../platform/errors.ts";

export type Rows = { rows: Record<string, unknown>[] };

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
	const body = (await r.json().catch(() => null)) as any;
	if (r.status === 401 || r.status === 403) throw new NeedsHuman(`知虾镜像不认 MARKET_SECRET（${r.status}）`);
	if (!r.ok) throw new Error(`知虾镜像回 ${r.status}：${body?.error ?? body?.message ?? JSON.stringify(body)?.slice(0, 300)}`);
	return { rows: Array.isArray(body) ? body : (body?.rows ?? []) };
}
