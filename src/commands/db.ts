// x2 db：库。x2 db migrate 建表、加列（每个命令第一次用库时也会跑）；x2 db import 把 ~/x2 的 JSON 迁进库（只用一次）
import { homedir } from "node:os";
import { join } from "node:path";
import { account } from "../site/alibaba.ts";
import { db } from "../db/index.ts";
import { importJson } from "../db/import.ts";
import { Usage } from "../errors.ts";

export async function dbCommand(args: string[], json: boolean): Promise<void> {
	const [sub, ...rest] = args;
	if (sub === "migrate") {
		await db();
		return console.log(json ? JSON.stringify({ ok: true }) : "表都建好了");
	}
	if (sub === "import") {
		const i = rest.indexOf("--account");
		const dir = rest.find((a, j) => !a.startsWith("--") && (i < 0 || j !== i + 1)) ?? join(homedir(), "x2");
		// carted.json 里的加购是在 x2 的浏览器登录着的 1688 账号上加的：不给就现读
		const acct = i >= 0 ? rest[i + 1]! : (await account()).userId;
		const sql = await db();
		// 订单先同步进来：加购记录的件数从订单里取
		const r = await importJson(sql, dir, acct);
		return console.log(json ? JSON.stringify(r) : `迁进库：货源 ${r.offers} 家，规格的货源 ${r.sources} 个，加购 ${r.cartWrites} 行（${r.cartLines} 个订单行；${r.skipped} 个找不到订单或货源，没迁）`);
	}
	throw new Usage("x2 db migrate：建表、加列；x2 db import [目录] [--account 1688 账号]：把 ~/x2 的 JSON 迁进库（先 x2 sync orders）");
}
