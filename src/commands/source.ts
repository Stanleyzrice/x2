// x2 source [商品 id…] [--url 1688 链接]：给店里的商品找货源。不给商品：检查算出来没货源、货源用不了的都找
import { check, current } from "../check/index.ts";
import { readAll } from "../read.ts";
import { db } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { findSources } from "../source.ts";

export async function sourceCommand(args: string[], json: boolean): Promise<void> {
	const i = args.indexOf("--url");
	const url = i >= 0 ? args[i + 1] : undefined;
	if (i >= 0 && !url) throw new Usage("--url 后面写 1688 链接");
	let ids = args.filter((a, j) => !a.startsWith("--") && (i < 0 || j !== i + 1));
	if (url && ids.length !== 1) throw new Usage("贴链接时只给一个商品：x2 source <商品 id> --url <1688 链接>");
	const sql = await db();
	if (ids.length === 0) {
		const t = (await current(sql)).todo.find((x) => x.kind === "找货源");
		ids = t?.kind === "找货源" ? t.items.map((m) => m.itemId) : [];
	}
	if (ids.length === 0) return console.log(json ? JSON.stringify({ found: [] }) : "没有要找货源的商品");
	const found = await findSources(sql, ids, url);
	await check(sql, await readAll(sql));
	if (json) return console.log(JSON.stringify({ found }));
	for (const f of found) console.log(`${f.name}（${f.itemId}）\n  ${f.sure ?? f.chosen ? `→ ${f.sure ?? f.chosen}：` : ""}${f.why}${f.options > 1 ? `（找到 ${f.options} 个）` : ""}`);
}
