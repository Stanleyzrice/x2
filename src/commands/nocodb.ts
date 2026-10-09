// x2 nocodb：按 docs/loop.md「视图」建 NocoDB（见 src/nocodb.ts）
import { db } from "../db/index.ts";
import { setup } from "../nocodb.ts";

export async function nocodbCommand(_args: string[], json: boolean): Promise<void> {
	const r = await setup(await db());
	console.log(json ? JSON.stringify(r) : `NocoDB 建好了：${r.tables} 张表、${r.views} 个视图`);
}
