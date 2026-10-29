// 对真站跑一遍 chanboss 的读取：只打印字段名和条数
import * as c from "./api.ts";

const shape = (v: any): string =>
	Array.isArray(v)
		? `[${v.length}] ${v[0] && typeof v[0] === "object" ? Object.keys(v[0]).slice(0, 12).join(",") : ""}`
		: v && typeof v === "object"
			? `{${Object.keys(v).slice(0, 12).join(",")}}`
			: typeof v;
const run = async (name: string, f: () => Promise<any>) => {
	try {
		const v = await f();
		console.log("OK ", name.padEnd(14), shape(v?.rows ?? v), v?.total !== undefined ? `total ${v.total}` : "");
		return v;
	} catch (e) {
		console.log("ERR", name.padEnd(14), (e as Error).message.slice(0, 200));
	}
};
const now = Math.floor(Date.now() / 1000),
	day = 86400;
const who = await run("identity", async () => {
	const i = await c.identity();
	return { userId: Boolean(i.userId), account: Boolean(i.account) };
});
if (who) {
	await run("orders", () => c.orders(now - 30 * day, now));
	await run("stock", () => c.stock());
	await run("returns", () => c.returns());
	await run("putaway", () => c.putaway("shelf", now - 90 * day, now));
	await run("returnChanges", () => c.returnChanges());
	await run("balance", () => c.balance(now - 30 * day, now));
}
