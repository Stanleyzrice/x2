// 对真站点跑一遍知虾的读操作（手动跑：node connectors/sites/zhixia/live.ts），看回来的形状
import * as z from "./api.ts";

const shape = (v: unknown): string =>
	Array.isArray(v)
		? `[${v.length}] ${v[0] ? Object.keys(v[0]).slice(0, 14).join(",") : ""}`
		: v && typeof v === "object"
			? `{${Object.keys(v).slice(0, 14).join(",")}}`
			: String(v);
const run = async <T>(name: string, f: () => Promise<T>): Promise<T | undefined> => {
	try {
		const v = await f();
		const l = v as { rows?: unknown; total?: unknown };
		console.log("OK ", name, "→", shape(l?.rows ?? v), l?.total !== undefined ? `total ${l.total}` : "");
		return v;
	} catch (e) {
		console.log("ERR", name, (e as Error).message);
		return undefined;
	}
};
const cats = await run("categories", () => z.categories());
const top = cats?.[0];
const path = top ? [Number(top.id)] : [];
console.log("   path", path, top?.name);

await run("sellWell(path)", () => z.sellWell(path, 1, 10));
await run("categoryDaily", () => z.categoryDaily(path));
const hw = await run("hotWords", () => z.hotWords(path));
const w = hw?.rows?.[0];
console.log("   word", w?.word, w?.hotWordId, "searchVal", w?.searchVal, "sales30day", w?.sales30day);
if (w) {
	await run("hotWordItems", () => z.hotWordItems(Number(w.hotWordId), path));
	await run("demandChange", () => z.demandChange(Number(w.hotWordId)));
	await run("competition", () => z.competition(Number(w.hotWordId)));
	await run("priceLine", () => z.priceLine(Number(w.hotWordId)));
	await run("complaints", () => z.complaints(Number(w.hotWordId)));
	await run("preferences", () => z.preferences(Number(w.hotWordId)));
	await run("longTail", () => z.longTail(Number(w.hotWordId)));
}
