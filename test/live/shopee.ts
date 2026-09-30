// 对真店跑一遍 Shopee 的读取：只打印字段名和条数，不打印内容（订单、聊聊里有买家的资料）
import * as seller from "../../src/site/shopee/seller.ts";
import * as orders from "../../src/site/shopee/orders.ts";
import * as products from "../../src/site/shopee/products.ts";
import * as mass from "../../src/site/shopee/mass.ts";
import * as finance from "../../src/site/shopee/finance.ts";
import * as returns from "../../src/site/shopee/returns.ts";
import * as marketing from "../../src/site/shopee/marketing.ts";
import * as chat from "../../src/site/shopee/chat.ts";
import * as help from "../../src/site/shopee/help.ts";

const shape = (v: any): string => Array.isArray(v) ? `[${v.length}] ${v[0] && typeof v[0] === "object" ? Object.keys(v[0]).slice(0, 12).join(",") : ""}` : v && typeof v === "object" ? `{${Object.keys(v).slice(0, 12).join(",")}}` : typeof v;
const run = async (name: string, f: () => Promise<any>) => {
	try { const v = await f(); console.log("OK ", name.padEnd(22), shape(v?.rows ?? v), v?.total !== undefined ? `total ${v.total}` : ""); return v; }
	catch (e) { console.log("ERR", name.padEnd(22), (e as Error).message.slice(0, 200)); }
};
const now = Math.floor(Date.now() / 1000), day = 86400;
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), monthAgo = new Date(Date.now() + 8 * 3600e3 - 30 * day * 1000).toISOString().slice(0, 10);

await run("shop", async () => { const s = await seller.shop(); return { shopId: Boolean(s.shopId), name: Boolean(s.name) }; });
const idx = await run("orderIndex(all)", () => orders.orderIndex(orders.TAB.all, 1, 5).then((r) => ({ total: r.total, rows: r.refs })));
const cards = await run("orderCards", () => orders.orderCards(orders.TAB.all, idx?.rows ?? []));
await run("toShipOrders", () => orders.toShipOrders());
if (cards?.[0]) await run("oneOrder", () => orders.oneOrder(cards[0].orderId));
const live = await run("liveProducts", () => products.liveProducts(1, 5));
await run("allProducts", () => products.allProducts(1, 5));
const pid = live?.rows?.[0]?.productId;
const info = pid ? await run("productInfo", () => products.productInfo(pid)) : null;
const leaf = info?.category_path?.at(-1);
if (pid && leaf) await run("channels", () => products.channels(pid, Number(leaf)));
if (leaf) await run("attributes", () => products.attributes(Number(leaf)));
await run("countLimit", () => products.countLimit());
await run("performance", () => products.performance(now - 7 * day, now, "past7days", 1, 5));
await run("categoryTree", () => products.categoryTree());
if (info?.name) await run("recommendedCategory", () => products.recommendedCategory(info.name));
await run("shippingDays", () => products.shippingDays());
await run("mass.records", () => mass.records());
await run("mass.drafts", () => mass.drafts());
const inc = await run("income", () => finance.income(monthAgo, today));
const oid = inc?.rows?.[0]?.local_income_detail?.order_income_info?.order_id;
if (oid) await run("incomeComponents", () => finance.incomeComponents(String(oid)));
await run("returns.cases", () => returns.cases());
await run("shopMetrics", () => marketing.shopMetrics(now - 7 * day, now, "past7days"));
await run("reviews", () => marketing.reviews());
await run("adsAccount", () => marketing.adsAccount());
await run("adsSetup", () => marketing.adsSetup());
await run("campaigns", () => marketing.campaigns(marketing.twMidnight(7), marketing.twMidnight(0) - 1));
await run("vouchers", () => marketing.vouchers());
await run("bundles", () => marketing.bundles());
await run("discounts", () => marketing.discounts());
// 帮助中心的分类 id 还不知道：先只确认接口通
await run("help.articles", () => help.articles(1));
const un = await run("chat.unreplied", () => chat.unreplied());
const conv = await run("chat.conversations", () => chat.conversations());
const cid = conv?.[0]?.id;
if (cid) await run("chat.messages", () => chat.messages(String(cid)));
