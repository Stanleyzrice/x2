import * as a from "../../src/site/alibaba.ts";
const run = async (name: string, f: () => Promise<any>) => { try { const v = await f(); console.log("OK ", name, "→", JSON.stringify(v, (k, x) => (typeof x === "string" && x.length > 40 ? x.slice(0, 40) + "…" : x)).slice(0, 400)); return v; } catch (e) { console.log("ERR", name, (e as Error).message); } };
await run("account", async () => { const u = await a.account(); return { userId: u.userId ? "有" : "无", loginId: u.loginId ? "有" : "无" }; });
await run("search", async () => { const h = await a.search("登山扣磁铁"); return { n: h.length, first: h[0] }; });
await run("cart", async () => { const c = await a.cart(); return { n: c.length }; });
const bo = await run("buyerOrders", async () => { const b = await a.buyerOrders(1, 5); return { total: b.total, pages: b.pages, n: b.rows.length, first: b.rows[0] && { status: b.rows[0].statusLabel, items: b.rows[0].items.length, hasNo: Boolean(b.rows[0].items[0]?.trackingNo), paid: b.rows[0].paid } , _rows: b.rows }; });
const withNo = (bo?._rows ?? []).filter((o: any) => o.items.some((i: any) => i.trackingNo)).slice(0, 2);
await run("traces", async () => (await a.traces(withNo.map((o: any) => ({ orderId: o.orderId, trackingNos: o.items.map((i: any) => i.trackingNo).filter(Boolean) })))).map((t) => ({ n: t.traces.length, status: t.traces[0]?.status })));
