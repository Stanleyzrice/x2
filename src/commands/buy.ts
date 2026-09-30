// x2 buy：采购。要买什么（todo）→ 以图搜图找货源（find）或贴 1688 链接（link）→ 对规格（match，一个 ask 页面）→ 购物清单（list）→ 人在 1688 买 → 标买过（done）。
// 人给的判断只往后加（store.append）：sources.json 记链接和规格的对照，bought.json 记买过的订单；现在的对照 = 每个商品、每个规格最新的一条。
// 1688 自动加购不在这里：人照购物清单在 1688 上加购、付款
import { type Offer, offer as readOffer, offerIdOf } from "../site/alibaba.ts";
import type { Order } from "../site/shopee.ts";
import { ask } from "../page/serve.ts";
import { ready as zhixiaReady, similar1688 } from "../site/zhixia.ts";
import type { Page } from "../page/spec.ts";
import * as store from "../store.ts";

/** offerId 是 null：人说货源不对，这个商品回到缺链接 */
type Link = { kind: "link"; itemId: string; offerId: string | null; at?: string };
type Spec = { kind: "spec"; modelId: string; skuId: string; offerId: string; at?: string };
type Row = {
	orderSn: string; daysLeft: number | null; name: string; spec: string; qty: number; image: string; itemId: string; modelId: string;
	state: "缺链接" | "缺规格" | "可买"; offerId: string | null; link: string | null; offerTitle: string | null; skuId: string | null; skuName: string | null; price: number | null;
};

async function load() {
	const { orders } = await store.read<{ orders: Order[] }>("orders", { orders: [] });
	const sources = await store.read<(Link | Spec)[]>("sources", []);
	const offers = await store.read<Record<string, Offer>>("offers", {});
	const bought = new Set((await store.read<{ orderSn: string }[]>("bought", [])).map((b) => b.orderSn));
	const links = new Map<string, Link>();
	const specs = new Map<string, Spec>();
	for (const s of sources) s.kind === "link" ? links.set(s.itemId, s) : specs.set(s.modelId, s);
	return { orders, offers, bought, links, specs };
}

/** 还没买的订单里的每一项，带上货源、规格对上没有 */
async function rows(): Promise<Row[]> {
	const { orders, offers, bought, links, specs } = await load();
	const now = Date.now();
	return orders.filter((o) => !bought.has(o.orderSn)).flatMap((o) => o.items.map((it): Row => {
		const link = links.get(it.itemId);
		const offer = link?.offerId ? offers[link.offerId] : undefined;
		const spec = specs.get(it.modelId);
		// 规格对的是别的货源（换过链接）算没对
		const sku = spec && offer && spec.offerId === offer.offerId ? offer.skus.find((s) => s.skuId === spec.skuId) : undefined;
		return {
			orderSn: o.orderSn, daysLeft: o.shipBy ? Math.floor((Date.parse(o.shipBy) - now) / 86_400_000) : null,
			name: it.name, spec: it.spec, qty: it.qty, image: it.image, itemId: it.itemId, modelId: it.modelId,
			state: !offer ? "缺链接" : !sku ? "缺规格" : "可买",
			offerId: offer?.offerId ?? null, link: offer?.url ?? null, offerTitle: offer?.title ?? null, skuId: sku?.skuId ?? null, skuName: sku?.name ?? null, price: sku?.price ?? null,
		};
	})).sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99) || a.orderSn.localeCompare(b.orderSn));
}

async function todo(json: boolean) {
	const all = await rows();
	if (json) return console.log(JSON.stringify(all));
	let last = "";
	for (const r of all) {
		if (r.orderSn !== last) console.log(`\n${r.orderSn}  剩 ${r.daysLeft ?? "?"} 天`);
		last = r.orderSn;
		console.log(`  [${r.state}] ${r.name} / ${r.spec || "—"} × ${r.qty}  商品 ${r.itemId}${r.skuName !== null ? `  → 1688：${r.skuName || "（单规格）"} ¥${r.price}` : ""}`);
	}
}

/** 读一遍 1688 货源（标题、规格、图、价格、库存），存进 offers */
async function refresh(offerId: string): Promise<Offer> {
	const o = await readOffer(offerId);
	const offers = await store.read<Record<string, Offer>>("offers", {});
	await store.write("offers", { ...offers, [o.offerId]: o });
	return o;
}

/** 记下一个商品的 1688 货源：读货源存进 offers，对照往后加进 sources */
async function record(itemId: string, offerId: string): Promise<Offer> {
	const o = await refresh(offerId);
	await store.append<Link>("sources", [{ kind: "link", itemId, offerId: o.offerId }]);
	return o;
}

async function link(itemId: string | undefined, url: string | undefined, json: boolean) {
	const offerId = url ? offerIdOf(url) : null;
	if (!itemId || !offerId) throw new Error("用法：x2 buy link <商品 id> <1688 链接或货源 id>");
	const o = await record(itemId, offerId);
	console.log(json ? JSON.stringify({ offerId: o.offerId, title: o.title, skus: o.skus.length }) : `已记下：${itemId} → 1688「${o.title}」，${o.skus.length} 个规格。下一步：x2 buy match ${itemId}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Found = { offerId: string; title: string; image: string; note: string; matched: number };

/** 缺链接的商品（给了商品 id 只找它）：拿 Shopee 的商品图经知虾在 1688 以图搜图，每个 8 个候选；
 * 每个候选读一遍 1688 的规格，按「店里的规格对上几个」排序（卖家的规格名常照抄货源），一个 ask 页面里让人选；都不对的可以贴链接 */
async function find(itemId: string | undefined, json: boolean) {
	const missing = new Map<string, { name: string; image: string; specs: Set<string> }>();
	for (const r of await rows()) if (r.state === "缺链接" && (!itemId || r.itemId === itemId)) {
		const m = missing.get(r.itemId) ?? { name: r.name, image: r.image.replace(/_tn$/, ""), specs: new Set<string>() };
		if (r.spec) m.specs.add(r.spec);
		missing.set(r.itemId, m);
	}
	if (missing.size === 0) return console.log(json ? JSON.stringify({ found: 0 }) : itemId ? `商品 ${itemId} 不缺链接` : "没有缺链接的商品");
	await zhixiaReady();
	const found: { itemId: string; name: string; image: string; specs: string[]; candidates: Found[] }[] = [];
	const read = new Map<string, Offer>();
	let blocked = "";
	for (const [id, m] of missing) {
		// 知虾对频率敏感：两次搜索隔 6 秒
		if (found.length > 0) await sleep(6000);
		console.error(`以图搜图：${m.name}`);
		const hits = m.image ? await similar1688(m.image, 8) : [];
		const specs = [...m.specs];
		const candidates: Found[] = [];
		for (const [i, c] of hits.entries()) {
			const base = `¥${c.price} · 月销 ${c.monthSold}`;
			// 1688 要登录或过滑块时，后面的也读不了：只列出来，不读规格
			if (blocked) { candidates.push({ offerId: c.offerId, title: c.title, image: c.image, note: `${base}\n规格没读到：${blocked}`, matched: -1 }); continue; }
			console.error(`  读 1688 规格 ${i + 1}/${hits.length}：${c.title}`);
			try {
				const o = read.get(c.offerId) ?? await readOffer(c.offerId);
				read.set(c.offerId, o);
				const matched = specs.filter((s) => guess(s, o.skus) !== undefined).length;
				const names = o.skus.map((s) => s.name).filter(Boolean);
				const list = names.length === 0 ? "单规格" : `${names.length} 个规格：${names.slice(0, 6).join("、")}${names.length > 6 ? "…" : ""}`;
				candidates.push({ offerId: c.offerId, title: c.title, image: c.image, note: `${specs.length ? `规格对上 ${matched}/${specs.length} · ` : ""}${base}\n${list}`, matched });
			} catch (e) {
				const msg = (e as Error).message;
				if (msg.includes("登录") || msg.includes("滑块")) blocked = msg;
				candidates.push({ offerId: c.offerId, title: c.title, image: c.image, note: `${base}\n规格没读到：${msg}`, matched: -1 });
			}
			await sleep(1500);
		}
		// 对上多的在前；一样多的保持以图搜图的顺序（sort 是稳定的）
		candidates.sort((a, b) => b.matched - a.matched);
		found.push({ itemId: id, name: m.name, image: m.image, specs, candidates });
	}
	const page: Page = {
		title: "找 1688 货源",
		blocks: [
			{ type: "text", text: "每个商品按图在 1688 上找了几个同款，读了它们的规格，店里的规格对上得多的排在前面：卖家的规格名常照抄货源，对上得多的多半就是这家。\n选一个要买的；都不对就在下面贴链接。不选也不贴的，下次再找。" },
			...found.flatMap((f): Page["blocks"] => [
				{ type: "heading", text: f.name },
				...(f.image ? [{ type: "image" as const, src: f.image, caption: `店里的规格：${f.specs.join("、") || "（单规格）"}` }] : []),
				{ type: "choice", id: `pick_${f.itemId}`, label: f.candidates.length ? "1688 上的同款" : "没有找到同款", options: f.candidates.map((c) => ({ value: c.offerId, label: c.title, image: c.image, note: c.note })) },
				{ type: "input", id: `url_${f.itemId}`, label: "都不对的话，贴 1688 链接", input: { type: "url", placeholder: "https://detail.1688.com/offer/….html" } },
			]),
		],
		submit: { label: "用选中的货源" },
	};
	const answer = await ask(page);
	if (!answer.submitted) return console.log(json ? JSON.stringify({ submitted: false }) : "取消了，没有记");
	const done: { itemId: string; offerId: string; title: string }[] = [];
	for (const f of found) {
		const url = answer.values[`url_${f.itemId}`] as string | null;
		const offerId = (url ? offerIdOf(url) : null) ?? (answer.values[`pick_${f.itemId}`] as string | null);
		if (!offerId) continue;
		const o = await record(f.itemId, offerId);
		done.push({ itemId: f.itemId, offerId: o.offerId, title: o.title });
	}
	console.log(json ? JSON.stringify({ submitted: true, linked: done }) : done.length ? `记下 ${done.length} 个商品的货源：\n${done.map((d) => `  ${d.itemId} → ${d.title}（x2 buy match ${d.itemId} 对规格）`).join("\n")}` : "没有选货源");
}

// 繁体 → 简体：Shopee 台湾的规格名是繁体，1688 是简体。只收规格名里常见的字，猜对照用，不求全
const T2S: Record<string, string> = { 貓: "猫", 藍: "蓝", 黃: "黄", 綠: "绿", 紅: "红", 銀: "银", 墊: "垫", 雙: "双", 層: "层", 網: "网", 輪: "轮", 鋼: "钢", 鐵: "铁", 門: "门", 衛: "卫", 間: "间", 傢: "家", 臟: "脏", 僊: "仙", 號: "号", 條: "条", 張: "张", 個: "个", 裝: "装", 組: "组", 淺: "浅", 深: "深", 褐: "褐", 灰: "灰", 棕: "棕", 寬: "宽", 長: "长", 圓: "圆" };
const tokens = (s: string) => [...s].map((c) => T2S[c] ?? c).join("").toLowerCase().split(/[\s,，/>*×（）()【】[\]:：+]+/).filter((t) => t.length > 0);

/** 店里的规格名最像 1688 的哪个规格：按词数重合；并列第一时不猜 */
function guess(spec: string, skus: readonly { skuId: string; name: string }[]): string | undefined {
	const mine = tokens(spec);
	const scored = skus.map((s) => ({ s, n: tokens(s.name).filter((t) => mine.includes(t)).length })).sort((a, b) => b.n - a.n);
	return scored[0] && scored[0].n > 0 && scored[0].n !== scored[1]?.n ? scored[0].s.skuId : undefined;
}

async function match(itemId: string | undefined, json: boolean) {
	if (!itemId) throw new Error("用法：x2 buy match <商品 id>");
	const { orders, bought, links, specs } = await load();
	const linked = links.get(itemId)?.offerId;
	if (!linked) throw new Error(`商品 ${itemId} 还没有 1688 货源：x2 buy find ${itemId}，或 x2 buy link ${itemId} <链接>`);
	// 现读一遍：价格、库存是今天的
	const o = await refresh(linked);
	// 这个商品在还没买的订单里出现的规格，件数加起来
	const models = new Map<string, { modelId: string; spec: string; image: string; qty: number }>();
	for (const ord of orders) if (!bought.has(ord.orderSn)) for (const it of ord.items) if (it.itemId === itemId) {
		const m = models.get(it.modelId) ?? { modelId: it.modelId, spec: it.spec, image: it.image, qty: 0 };
		models.set(it.modelId, { ...m, qty: m.qty + it.qty });
	}
	const current = (modelId: string) => { const s = specs.get(modelId); return s && s.offerId === o.offerId ? s.skuId : undefined; };
	const page: Page = {
		title: `对规格：${o.title}`,
		blocks: [
			{ type: "text", text: `店里的每个规格选一个 1688 的规格：左边是店里的图，右边是选中的 1688 规格的图。已经按名字猜了一个，核对一下；点图看大图。\n两边对不上（规格数、型号都不一样），多半是货源找错了：点「货源不对」，这个商品回到缺链接，再找一次。\n1688：${o.url}` },
			{
				type: "variants", id: "pairs",
				attrs: o.props,
				options: o.skus.map((s) => ({ value: s.skuId, attrs: s.attrs, label: s.name, image: s.image || undefined, note: `¥${s.price} · 库存 ${s.stock}` })),
				rows: [...models.values()].map((m) => ({
					key: m.modelId, label: m.spec || "（单规格）", image: m.image.replace(/_tn$/, "") || undefined, note: `要买 ${m.qty} 件`,
					value: current(m.modelId) ?? guess(m.spec, o.skus),
				})),
			},
		],
		submit: { label: "确认对照", cancel: "货源不对" },
	};
	const answer = await ask(page);
	if (!answer.submitted) {
		await store.append<Link>("sources", [{ kind: "link", itemId, offerId: null }]);
		return console.log(json ? JSON.stringify({ submitted: false, unlinked: itemId }) : `商品 ${itemId} 回到缺链接：x2 buy find ${itemId} 再找，或 x2 buy link ${itemId} <链接>`);
	}
	const pairs = Object.entries(answer.values.pairs as Record<string, string | null>).filter((p): p is [string, string] => p[1] !== null);
	await store.append<Spec>("sources", pairs.map(([modelId, skuId]) => ({ kind: "spec", modelId, skuId, offerId: o.offerId })));
	console.log(json ? JSON.stringify({ submitted: true, matched: pairs.length, of: models.size }) : `记下 ${pairs.length} 个规格的对照（共 ${models.size} 个）`);
}

/** 购物清单：能买的按 1688 规格合起来，件数相加 */
async function list(json: boolean) {
	const groups = new Map<string, { title: string; link: string; sku: string; price: number; qty: number; orders: string[] }>();
	for (const r of await rows()) if (r.state === "可买") {
		const g = groups.get(r.skuId!) ?? { title: r.offerTitle!, link: r.link!, sku: r.skuName || "（单规格）", price: r.price!, qty: 0, orders: [] };
		groups.set(r.skuId!, { ...g, qty: g.qty + r.qty, orders: [...new Set([...g.orders, r.orderSn])] });
	}
	const all = [...groups.values()];
	if (json) return console.log(JSON.stringify(all.map((g) => ({ ...g, orders: g.orders.join("、") }))));
	for (const g of all) console.log(`${g.title} / ${g.sku}  × ${g.qty}  ¥${g.price}\n  ${g.link}\n  订单：${g.orders.join("、")}`);
	if (all.length === 0) console.log("没有能买的：先把货源、规格对上（x2 buy todo 看缺什么）");
}

async function done(orderSns: string[], json: boolean) {
	if (orderSns.length === 0) throw new Error("用法：x2 buy done <订单号…>");
	await store.append("bought", orderSns.map((orderSn) => ({ orderSn })));
	console.log(json ? JSON.stringify({ bought: orderSns }) : `标为买过：${orderSns.join("、")}`);
}

export async function buy(args: string[], json: boolean): Promise<void> {
	const [sub, ...rest] = args;
	if (sub === "todo") return todo(json);
	if (sub === "link") return link(rest[0], rest[1], json);
	if (sub === "find") return find(rest[0], json);
	if (sub === "match") return match(rest[0], json);
	if (sub === "list") return list(json);
	if (sub === "done") return done(rest, json);
	throw new Error("x2 buy 的子命令：todo、find、link、match、list、done");
}
