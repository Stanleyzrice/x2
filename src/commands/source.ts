// x2 source [规格 id…] [--url 1688 链接]：给规格找货源。不给规格：检查算出来缺货源、货源失效的都找
import { check } from "../check/index.ts";
import { db } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { findSources } from "../source.ts";

export async function sourceCommand(args: string[], json: boolean): Promise<void> {
	const i = args.indexOf("--url");
	const url = i >= 0 ? args[i + 1] : undefined;
	if (i >= 0 && !url) throw new Usage("--url 后面写 1688 链接");
	let ids = args.filter((a, j) => !a.startsWith("--") && (i < 0 || j !== i + 1));
	if (url && ids.length !== 1) throw new Usage("贴链接时只给一个规格：x2 source <规格 id> --url <1688 链接>");
	const sql = await db();
	if (ids.length === 0) {
		const t = (await check(sql)).todo.find((x) => x.kind === "找货源");
		ids = t?.kind === "找货源" ? t.models.map((m) => m.modelId) : [];
	}
	if (ids.length === 0) return console.log(json ? JSON.stringify({ found: [] }) : "没有要找货源的规格");
	const found = await findSources(sql, ids, url);
	await check(sql);
	if (json) return console.log(JSON.stringify({ found }));
	for (const f of found) console.log(`${f.name}（${f.modelId}）\n  ${f.sure ? `→ ${f.sure.title} / ${f.sure.sku}：` : ""}${f.why}${f.options ? `（候选 ${f.options} 个）` : ""}`);
}
