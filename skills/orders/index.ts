// 订单（x2 orders <工具>）：从订单进来到 chanboss「已打包」。x2 status 问它的检查；加购、预报是写（给人看过、人同意了再调），只收检查算出来该做的
import { z } from "zod";
import { db, type Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { get, parseJson, str, strs, type Toolkit } from "../../platform/tool.ts";
import { checkOrders } from "./check.ts";
import { readAll } from "./read.ts";
import { findSources, setException } from "./source.ts";
import { current, ordersCheck, snapshot } from "./status.ts";
import { cartParams, forecastParams, ORDER_WRITES } from "./writes.ts";

/** 加购只收检查算出来该加购的订单行（加过了、还没核清、货源不齐的不收），只往采购账号加 */
async function planCart(sql: Sql, items: z.infer<typeof cartParams>[]) {
	const ok = (await current(sql)).planned;
	const [{ buy }] = (await sql`select buy_account as buy from order_settings where id = 1`) as any;
	return [
		items.map((params, i) => {
			if (buy) {
				if (params.account && params.account !== buy) throw new Usage(`第 ${i + 1} 项：只往采购账号（${buy}）加购，不往 ${params.account} 加`);
				params.account = buy;
			}
			for (const l of params.lines)
				if (!ok.cart.has(`${l.sn}:${l.modelId}`))
					throw new Usage(`第 ${i + 1} 项：订单 ${l.sn} 的规格 ${l.modelId} 现在不该加购（加过了、还没核清，或者货源不齐）。看 x2 status`);
			return { op: "加购", params };
		}),
	];
}

/** 预报只收付完款、还没报的订单 */
async function planForecast(sql: Sql, orders: z.infer<typeof forecastParams>[]) {
	const ok = (await current(sql)).planned;
	return [
		orders.map((params, i) => {
			if (!ok.forecast.has(params.sn)) throw new Usage(`第 ${i + 1} 项：订单 ${params.sn} 现在不该预报（没付完款、报过了，或者还没核清）。看 x2 status`);
			return { op: "预报", params };
		}),
	];
}

const json = <T extends z.ZodType>(t: T, describe: string) => z.preprocess(parseJson, t).describe(`${describe}（JSON；写 - 从 stdin 读）`);

export const orders: Toolkit = {
	name: "orders",
	title: "订单：找货源、加购、预报",
	kind: "skill",
	tools: {
		source: {
			...get(
				"给店里的商品找货源（以图搜图）；不给商品就找检查算出来缺货源、货源不可用的",
				z.object({ items: strs("店里的商品 id").optional(), url: z.string().url().optional().describe("人贴的 1688 链接（只给一个商品时）") }),
				async (p) => {
					if (p.url && p.items?.length !== 1) throw new Usage("贴链接时只给一个商品：x2 orders source --items <商品 id> --url <1688 链接>");
					const sql = await db();
					let ids = p.items ?? [];
					if (!ids.length) {
						const t = checkOrders(await snapshot(sql, await readAll(sql))).todo.find((x) => x.kind === "找货源");
						ids = t?.kind === "找货源" ? t.items.map((m) => m.itemId) : [];
					}
					if (!ids.length) return { found: [] };
					const found = await findSources(sql, ids, p.url);
					// 找完再检查一遍（「选货源」的提醒）：2 分钟内读过的站点数据复用
					await ordersCheck(sql, await readAll(sql));
					return { found };
				},
			),
			text: (r) =>
				r.found.length
					? r.found
							.map(
								(f: any) =>
									`${f.name}（${f.itemId}）\n  ${(f.sure ?? f.chosen) ? `→ ${f.sure ?? f.chosen}：` : ""}${f.why}${f.options > 1 ? `（找到 ${f.options} 个）` : ""}`,
							)
							.join("\n")
					: "没有要找货源的商品",
		},
		spec: {
			...get(
				"记下人定的规格例外：店里的规格按名字在货源的规格里配不上时（人说了才写）",
				z.object({ item: str("店里的商品 id"), spec: str("店里的规格名 = 货源的规格名") }),
				async (p) => setException(await db(), p.item, p.spec),
			),
			text: (r) => `记下了：${r.spec} = ${r.sku}（货源「${r.title}」）。下一次 x2 status，「规格不匹配」这一行会关`,
		},
		cart: {
			kind: "write",
			description: "加购：把货源的规格加进采购账号的 1688 购物车（同一个规格的几张订单合成一行）；只收检查算出来该加购的（x2 status 的 todo 里有现成的）",
			params: z.object({ items: json(z.array(cartParams).min(1), "要加购的，一项一个货源规格") }),
			plan: (sql, p) => planCart(sql, p.items),
		},
		forecast: {
			kind: "write",
			description: "预报：在 chanboss 上报订单的货怎么来；只收付完款、还没报的（x2 status 的 todo 里有现成的）",
			params: z.object({ orders: json(z.array(forecastParams).min(1), "要预报的订单") }),
			plan: (sql, p) => planForecast(sql, p.orders),
		},
	},
	check: async (sql) => ordersCheck(sql, await readAll(sql)),
	writes: ORDER_WRITES,
};
