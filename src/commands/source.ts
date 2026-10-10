// x2 source [商品 id…] [--url 1688 链接]：给店里的商品找货源。不给商品：检查算出来缺货源、货源不可用的都找
// x2 source <商品 id> --spec "店里的规格名 = 货源的规格名"：记下人定的规格例外（按名字配不上时；人说了才写）
import { check, snapshot } from "../check/index.ts";
import { checkOrders } from "../check/orders.ts";
import { readAll } from "../read.ts";
import { db } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { findSources, setException } from "../source.ts";

export async function sourceCommand(args: string[], json: boolean): Promise<void> {
	const flag = (name: string, what: string) => {
		const i = args.indexOf(name);
		if (i >= 0 && !args[i + 1]) throw new Usage(`${name} 后面写${what}`);
		return i >= 0 ? args[i + 1] : undefined;
	};
	const url = flag("--url", " 1688 链接"), spec = flag("--spec", "「店里的规格名 = 货源的规格名」");
	let ids = args.filter((a, j) => !a.startsWith("--") && args[j - 1] !== "--url" && args[j - 1] !== "--spec");
	if (url && ids.length !== 1) throw new Usage("贴链接时只给一个商品：x2 source <商品 id> --url <1688 链接>");
	const sql = await db();
	if (spec) {
		if (ids.length !== 1) throw new Usage(`写规格例外时只给一个商品：x2 source <商品 id> --spec "店里的规格名 = 货源的规格名"`);
		const r = await setException(sql, ids[0]!, spec);
		return console.log(json ? JSON.stringify(r) : `记下了：${r.spec} = ${r.sku}（货源「${r.title}」）。下一次 x2 status，「规格不匹配」这一行会关`);
	}
	if (ids.length === 0) {
		const t = checkOrders(await snapshot(sql, await readAll(sql))).todo.find((x) => x.kind === "找货源");
		ids = t?.kind === "找货源" ? t.items.map((m) => m.itemId) : [];
	}
	if (ids.length === 0) return console.log(json ? JSON.stringify({ found: [] }) : "没有要找货源的商品");
	const found = await findSources(sql, ids, url);
	// 找完再检查一遍（收件箱的「选货源」）：2 分钟内读过的站点数据复用
	await check(sql, await readAll(sql));
	if (json) return console.log(JSON.stringify({ found }));
	for (const f of found) console.log(`${f.name}（${f.itemId}）\n  ${f.sure ?? f.chosen ? `→ ${f.sure ?? f.chosen}：` : ""}${f.why}${f.options > 1 ? `（找到 ${f.options} 个）` : ""}`);
}
