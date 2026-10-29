// x2 db：库。x2 db migrate 建表、加列（每个命令第一次用库时也会跑）
import { db } from "../core/db.ts";
import { Usage } from "../core/errors.ts";

export async function dbCommand(args: string[], json: boolean): Promise<void> {
	if (args[0] !== "migrate") throw new Usage("x2 db migrate：建表、加列");
	await db();
	console.log(json ? JSON.stringify({ ok: true }) : "表都建好了");
}
