// x2 buy：采购。x2 buy order 读来订单 → x2 buy 出采购单（每个订单里的 SKU 买 1688 哪家的哪个规格、几件），同时现读 1688 检查货源 →
// 缺货源、货源失效的用 x2 buy source 找（一个 ask 页面）→ 人在 x2 show buy 上过一眼 → x2 buy cart 在确认页上勾好，加进 1688 购物车。
// 加上的订单行记进 carted.json（订单号 + SKU），采购单里不再出现；人在 1688 上付款。
// 对照按 SKU 记：Shopee 的一个规格（model）→ 1688 一家货源（offer）的一个规格（sku）。人给的对照只往后加（sources.json），每个规格以最新的一条为准。
// 正常情况下对照在上品时就写好，订单来了直接可买；找货源是例外：老商品没有对照、货源下架、规格没了、库存不够、想换一家
import { type CartLine, type Offer, Gone, addToCart, cart as readCart, offer as readOffer, offerIdOf } from "../site/alibaba.ts";
import { type Order, toShipOrders } from "../site/shopee/orders.ts";
import { ready as zhixiaReady, similar1688 } from "../site/zhixia.ts";
import { ask } from "../page/serve.ts";
import type { Page } from "../page/spec.ts";
import { rank } from "../similar.ts";
import * as store from "../store.ts";

type Spec = { kind: "spec"; modelId: string; offerId: string; skuId: string; at?: string };
/** 2026-09-30 以前的记录：商品 → 货源。现在只当「这个商品用过的货源」的线索 */
type Link = { kind: "link"; itemId: string; offerId: string | null; at?: string };

type Line = {
	orderSn: string; daysLeft: number | null; itemId: string; modelId: string; name: string; spec: string; qty: number; image: string;
	state: "可买" | "缺货源" | "货源失效"; why: string | null;
	offerId: string | null; link: string | null; offerTitle: string | null; skuId: string | null; skuName: string | null; price: number | null; stock: number | null;
};
/** 采购单上要加进购物车的一行：同一个 1688 规格合在一起；lines 是它来自的订单行 */
type CartItem = { offerId: string; skuId: string; title: string; sku: string; image: string; price: number; qty: number; link: string; orders: string; lines: Carted[] };
/** 加进购物车了的订单行 */
type Carted = { orderSn: string; modelId: string; at?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const full = (image: string) => image.replace(/_tn$/, "");

/** x2 buy order：读 Shopee 待出货的订单，整份写进 orders.json */
async function order(json: boolean) {
	const orders = await toShipOrders();
	await store.write("orders", { syncedAt: new Date().toISOString(), orders });
	const items = orders.reduce((n, o) => n + o.items.length, 0);
	console.log(json ? JSON.stringify({ orders: orders.length, items }) : `读到待出货的订单 ${orders.length} 张、${items} 项商品`);
}

async function load() {
	const { orders } = await store.read<{ orders: Order[] }>("orders", { orders: [] });
	const sources = await store.read<(Spec | Link)[]>("sources", []);
	const carted = new Set((await store.read<Carted[]>("carted", [])).map((c) => `${c.orderSn}:${c.modelId}`));
	const specs = new Map<string, Spec>();
	const links = new Map<string, string[]>();
	for (const s of sources) {
		if (s.kind === "spec") specs.set(s.modelId, s);
		else if (s.offerId) links.set(s.itemId, [...(links.get(s.itemId) ?? []), s.offerId]);
	}
	return { orders, carted, specs, links };
}

/** 现读一家 1688 货源并存进 offers.json；下架了是 Gone，要登录、要过滑块照常抛出 */
async function fetchOffer(offerId: string): Promise<Offer> {
	const o = await readOffer(offerId);
	const offers = await store.read<Record<string, Offer>>("offers", {});
	await store.write("offers", { ...offers, [o.offerId]: o });
	return o;
}

/** 读几家货源，隔 1.5 秒一家（1688 对频率敏感）；下架的记成 null */
async function fetchOffers(offerIds: Iterable<string>, what: string): Promise<Map<string, Offer | null>> {
	const got = new Map<string, Offer | null>();
	const ids = [...new Set(offerIds)];
	for (const [i, id] of ids.entries()) {
		if (i > 0) await sleep(1500);
		console.error(`${what} ${i + 1}/${ids.length}：${id}`);
		try { got.set(id, await fetchOffer(id)); } catch (e) { if (e instanceof Gone) got.set(id, null); else throw e; }
	}
	return got;
}

/** 采购单：还没加进购物车的订单行，对上的 1688 规格现在能不能买。only：只要这几张订单，加过购物车的也算（重新加） */
async function plan(only?: Set<string>): Promise<{ lines: Line[]; cart: CartItem[] }> {
	const { orders, carted, specs } = await load();
	const pending = orders
		.filter((o) => !only || only.has(o.orderSn))
		.map((o) => ({ ...o, items: o.items.filter((it) => only || !carted.has(`${o.orderSn}:${it.modelId}`)) }))
		.filter((o) => o.items.length > 0);
	const used = pending.flatMap((o) => o.items.map((it) => specs.get(it.modelId)?.offerId)).filter((x): x is string => Boolean(x));
	const offers = await fetchOffers(used, "检查货源");
	const now = Date.now();
	const lines = pending.flatMap((o) => o.items.map((it): Line => {
		const base = {
			orderSn: o.orderSn, daysLeft: o.shipBy ? Math.floor((Date.parse(o.shipBy) - now) / 86_400_000) : null,
			itemId: it.itemId, modelId: it.modelId, name: it.name, spec: it.spec, qty: it.qty, image: full(it.image),
		};
		const none = { offerId: null, link: null, offerTitle: null, skuId: null, skuName: null, price: null, stock: null };
		const spec = specs.get(it.modelId);
		if (!spec) return { ...base, ...none, state: "缺货源", why: null };
		const offer = offers.get(spec.offerId);
		if (!offer) return { ...base, ...none, offerId: spec.offerId, state: "货源失效", why: "1688 上下架了" };
		const at = { offerId: offer.offerId, link: offer.url, offerTitle: offer.title };
		const sku = offer.skus.find((s) => s.skuId === spec.skuId);
		if (!sku) return { ...base, ...none, ...at, state: "货源失效", why: "1688 上没有这个规格了" };
		const matched = { ...at, skuId: sku.skuId, skuName: sku.name || "（单规格）", price: sku.price, stock: sku.stock };
		if (sku.stock < it.qty) return { ...base, ...matched, state: "货源失效", why: `库存 ${sku.stock}，要 ${it.qty}` };
		return { ...base, ...matched, state: "可买", why: null };
	})).sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99) || a.orderSn.localeCompare(b.orderSn));

	const cart = new Map<string, CartItem & { sns: Set<string> }>();
	for (const l of lines) if (l.state === "可买") {
		const offer = offers.get(l.offerId!)!;
		const key = `${l.offerId}:${l.skuId}`;
		const c = cart.get(key) ?? { offerId: l.offerId!, skuId: l.skuId!, title: offer.title, sku: l.skuName!, image: offer.skus.find((s) => s.skuId === l.skuId)?.image || offer.image, price: l.price!, qty: 0, link: offer.url, orders: "", lines: [], sns: new Set<string>() };
		c.qty += l.qty;
		c.sns.add(l.orderSn);
		c.lines.push({ orderSn: l.orderSn, modelId: l.modelId });
		cart.set(key, c);
	}
	return { lines, cart: [...cart.values()].map(({ sns, ...c }) => ({ ...c, orders: [...sns].join("、") })) };
}

async function show(json: boolean) {
	const { lines, cart } = await plan();
	if (json) return console.log(JSON.stringify({ cart, lines }));
	console.log(cart.length ? "加进购物车（同一个 1688 规格合在一起）：" : "现在没有能买的。");
	for (const c of cart) console.log(`  ${c.title} / ${c.sku}  × ${c.qty}  ¥${c.price}\n    ${c.link}\n    订单：${c.orders}`);
	const todo = lines.filter((l) => l.state !== "可买");
	if (todo.length) console.log("\n要找货源的（x2 buy source 一起找，或 x2 buy source <SKU>）：");
	for (const l of todo) console.log(`  [${l.state}${l.why ? `：${l.why}` : ""}] 订单 ${l.orderSn} 剩 ${l.daysLeft ?? "?"} 天  ${l.name} / ${l.spec || "（单规格）"} × ${l.qty}  SKU ${l.modelId}`);
}

// ── 找货源 ──

type Target = { modelId: string; itemId: string; name: string; spec: string; qty: number; image: string; state: string; why: string | null; current: string | null };
/** 一轮里给一个 SKU 找候选的办法：这个商品用过的货源（offers）、以图搜图（search）、人贴的链接（url） */
type Mode = { kind: "offers"; offerIds: string[] } | { kind: "search" } | { kind: "url"; offerId: string };
type Option = { value: string; label: string; image?: string; note?: string };

/** 一家货源里和这个 SKU 最像的几个规格，每个是一个选项：值是「货源:规格」 */
function options(t: Target, o: Offer, top: number): Option[] {
	return rank(t.spec, o.skus).slice(0, top).map((s) => ({
		value: `${o.offerId}:${s.skuId}`,
		label: s.name || "（单规格）",
		image: s.image || o.image || undefined,
		note: [
			`${o.title}${`${o.offerId}:${s.skuId}` === t.current ? " · 现在用的" : ""}`,
			`¥${s.price} · 库存 ${s.stock}${s.stock < t.qty ? "（不够）" : ""} · ${s.missing.length ? `缺：${s.missing.join("、")}` : "规格名里的数字、颜色都对上"}`,
		].join("\n"),
	}));
}

async function candidates(t: Target, mode: Mode): Promise<Option[]> {
	if (mode.kind === "url") {
		const o = (await fetchOffers([mode.offerId], "读贴的货源")).get(mode.offerId);
		return o ? options(t, o, 8) : [];
	}
	if (mode.kind === "offers") {
		const got = await fetchOffers(mode.offerIds, "读这个商品用过的货源");
		const live = [...got.values()].filter((o): o is Offer => o !== null);
		return live.flatMap((o) => options(t, o, live.length === 1 ? 5 : 3));
	}
	await zhixiaReady();
	console.error(`以图搜图：${t.name} / ${t.spec}`);
	const hits = t.image ? await similar1688(t.image, 8) : [];
	const got = await fetchOffers(hits.map((h) => h.offerId), "读搜到的货源");
	// 每家只出最像的一个规格；家与家之间按这个规格像不像排
	return [...got.values()].filter((o): o is Offer => o !== null)
		.map((o) => ({ o, best: rank(t.spec, o.skus)[0]! }))
		.sort((a, b) => b.best.score - a.best.score)
		.flatMap(({ o }) => options(t, o, 1));
}

const SEARCH = "search";

/** 给缺货源、货源失效的 SKU（给了 SKU 只找它，可买的也行）选 1688 的「哪家 + 哪个规格」。
 * 先看这个商品用过的货源；都不对可以选「用图搜」或贴链接，再来一轮；不选的下次再找 */
async function source(modelId: string | undefined, json: boolean) {
	const { lines } = await plan();
	const { specs, links } = await load();
	const targets = new Map<string, Target>();
	// 不给 SKU：缺货源、货源失效的都找；给了 SKU：可买的也重新选（例 选错了规格）
	for (const l of lines) if (modelId ? l.modelId === modelId : l.state !== "可买") {
		const t = targets.get(l.modelId);
		const cur = specs.get(l.modelId);
		targets.set(l.modelId, t ? { ...t, qty: t.qty + l.qty } : { modelId: l.modelId, itemId: l.itemId, name: l.name, spec: l.spec, qty: l.qty, image: l.image, state: l.state, why: l.why, current: cur ? `${cur.offerId}:${cur.skuId}` : null });
	}
	if (targets.size === 0) return console.log(json ? JSON.stringify({ mapped: [] }) : modelId ? `还没买的订单里没有 SKU ${modelId}` : "没有要找货源的 SKU");

	// 这个商品用过的货源：各个规格对上的（包括可能已下架的，读一遍就知道）、旧的商品链接
	const usedBy = (itemId: string) => [
		...lines.filter((l) => l.itemId === itemId).map((l) => specs.get(l.modelId)?.offerId),
		...(links.get(itemId) ?? []),
	].filter((x): x is string => Boolean(x));
	let round = new Map<string, Mode>([...targets.values()].map((t) => {
		const used = [...new Set(usedBy(t.itemId))];
		return [t.modelId, used.length ? { kind: "offers", offerIds: used } : { kind: "search" }];
	}));

	const mapped: { modelId: string; offerId: string; skuId: string; name: string }[] = [];
	while (round.size > 0) {
		const found: { t: Target; mode: Mode; opts: Option[] }[] = [];
		for (const [id, mode] of round) found.push({ t: targets.get(id)!, mode, opts: await candidates(targets.get(id)!, mode) });
		const page: Page = {
			title: "找货源",
			blocks: [
				{ type: "text", text: "每个 SKU 选一个要买的 1688 规格：候选按规格名像不像排，「缺」是店里的规格名里有、它没有的数字或颜色。点图看大图。\n都不对：选「用这个 SKU 的图搜」，或者贴 1688 链接，下一页再选规格。不选的下次再找。" },
				...found.flatMap(({ t, mode, opts }): Page["blocks"] => [
					{ type: "heading", text: `${t.spec || "（单规格）"} · 要买 ${t.qty} 件` },
					{ type: "image", src: t.image, caption: `${t.name}\n${t.state}${t.why ? `：${t.why}` : ""}` },
					{
						type: "choice", id: `pick_${t.modelId}`,
						label: mode.kind === "offers" ? "这个商品用过的货源" : mode.kind === "url" ? "贴的货源" : "以图搜图找到的",
						options: [...opts, ...(mode.kind === "search" ? [] : [{ value: SEARCH, label: "都不对：用这个 SKU 的图在 1688 上搜" }])],
					},
					{ type: "input", id: `url_${t.modelId}`, label: "或者贴 1688 链接", input: { type: "url", placeholder: "https://detail.1688.com/offer/….html" } },
				]),
			],
			submit: { label: "用选中的规格" },
		};
		const answer = await ask(page);
		if (!answer.submitted) break;
		const next = new Map<string, Mode>();
		const now: Spec[] = [];
		for (const { t, opts } of found) {
			const url = answer.values[`url_${t.modelId}`] as string | null;
			const pick = answer.values[`pick_${t.modelId}`] as string | null;
			const pasted = url ? offerIdOf(url) : null;
			if (pasted) next.set(t.modelId, { kind: "url", offerId: pasted });
			else if (pick === SEARCH) next.set(t.modelId, { kind: "search" });
			else if (pick) {
				const [offerId, skuId] = pick.split(":") as [string, string];
				now.push({ kind: "spec", modelId: t.modelId, offerId, skuId });
				mapped.push({ modelId: t.modelId, offerId, skuId, name: opts.find((o) => o.value === pick)?.label ?? "" });
			}
		}
		// 每一轮选定的当场记下：后面几轮取消了，前面选的也不丢
		await store.append<Spec>("sources", now);
		round = next;
	}
	console.log(json ? JSON.stringify({ mapped }) : mapped.length
		? `记下 ${mapped.length} 个 SKU 的货源：\n${mapped.map((m) => `  ${targets.get(m.modelId)!.spec || "（单规格）"} → ${m.name}`).join("\n")}\n用 x2 show buy 看采购单`
		: "没有记");
}

/** 购物车里这个规格现有几件 */
const inCart = (lines: CartLine[], offerId: string, skuId: string) => lines.filter((c) => c.offerId === offerId && c.skuId === skuId).reduce((n, c) => n + c.quantity, 0);

/** x2 buy cart [订单号…]：采购单里能买的，确认页上勾好，一个规格一个规格加进 1688 购物车。给了订单号：只加这几张（加过的也重新加）。
 * 每加一个规格，前后各读一遍购物车，按件数的差判断：够这次加的是加上了；没变是没加上；别的是结果未知，停下不重发（同一个规格加两次，车里是两倍） */
async function cart(orderSns: string[], json: boolean) {
	const { cart: items } = await plan(orderSns.length ? new Set(orderSns) : undefined);
	if (items.length === 0) return console.log(json ? JSON.stringify({ added: [] }) : "采购单里没有能买的（x2 buy 看缺什么）");
	console.error("读 1688 购物车");
	const before = await readCart();
	const page: Page = {
		title: "加进 1688 购物车",
		blocks: [
			{ type: "text", text: "勾上的一行一行加进 1688 购物车（同一个 1688 规格已经合在一起）。购物车里已经够数的没有勾上：多半加过了，确定要再加就勾上。\n加完在 1688 上付款。第一次用可以只勾一行，在 1688 购物车里看过再加其余的。" },
			{
				type: "table", id: "rows", select: true,
				columns: [
					{ key: "image", label: "", show: "image" }, { key: "title", label: "货源" }, { key: "sku", label: "规格" }, { key: "qty", label: "加几件" },
					{ key: "inCart", label: "购物车里已有" }, { key: "price", label: "单价" }, { key: "orders", label: "订单" },
				],
				// 车里已经够这次要加的，多半加过了（例 在别的机器上加的，carted.json 不在这台）：默认不勾，人看了再定
				rows: items.map((c) => { const n = inCart(before, c.offerId, c.skuId); return { ...c, inCart: n, _selected: n < c.qty }; }),
			},
		],
		submit: { label: "加进购物车" },
	};
	const answer = await ask(page);
	if (!answer.submitted) return console.log(json ? JSON.stringify({ added: [] }) : "取消了，没有加");
	const picked = (answer.values.rows as (CartItem & { inCart: number; _selected: boolean })[]).filter((r) => r._selected);
	const offers = await store.read<Record<string, Offer>>("offers", {});
	const report: { sku: string; qty: number; result: "加上了" | "没加上" | "结果未知" | "没加"; why?: string }[] = [];
	let stop = "";
	for (const [i, r] of picked.entries()) {
		const name = `${r.title} / ${r.sku} × ${r.qty}`;
		if (stop) { report.push({ sku: name, qty: r.qty, result: "没加", why: "前面停下了" }); continue; }
		if (i > 0) await sleep(3000);
		const specId = offers[r.offerId]?.skus.find((s) => s.skuId === r.skuId)?.specId ?? "";
		const was = inCart(await readCart(), r.offerId, r.skuId);
		// 确认之后车里这个规格变了（别处加了、删了）：不加，免得重复
		if (was !== r.inCart) { report.push({ sku: name, qty: r.qty, result: "没加", why: `确认时购物车里有 ${r.inCart} 件，现在是 ${was} 件` }); continue; }
		console.error(`加购 ${i + 1}/${picked.length}：${name}`);
		const res = await addToCart(r.offerId, specId, r.qty);
		if (res.kind === "blocked") { stop = res.why; report.push({ sku: name, qty: r.qty, result: "没加上", why: res.why }); continue; }
		if (res.kind === "refused") { report.push({ sku: name, qty: r.qty, result: "没加上", why: `1688 拒绝：${res.why}` }); continue; }
		let now: number;
		try { now = inCart(await readCart(), r.offerId, r.skuId); } catch (e) {
			stop = `加完读不了购物车：${(e as Error).message}`;
			report.push({ sku: name, qty: r.qty, result: "结果未知", why: stop });
			continue;
		}
		const d = now - was;
		if (d >= r.qty) {
			report.push({ sku: name, qty: r.qty, result: "加上了" });
			await store.append<Carted>("carted", r.lines);
		} else if (d === 0) {
			report.push({ sku: name, qty: r.qty, result: "没加上", why: res.kind === "unknown" ? res.why : "购物车里的件数没变" });
		} else {
			stop = `购物车里的件数从 ${was} 变成 ${now}，要加 ${r.qty}`;
			report.push({ sku: name, qty: r.qty, result: "结果未知", why: stop });
		}
	}
	if (json) return console.log(JSON.stringify({ added: report }));
	for (const r of report) console.log(`[${r.result}] ${r.sku}${r.why ? `：${r.why}` : ""}`);
	if (report.some((r) => r.result === "结果未知")) console.log("\n结果未知的不会自动重发：到 1688 购物车里看一眼，没加上的用 x2 buy cart <订单号> 再加");
	if (report.some((r) => r.result === "加上了")) console.log("\n加上的到 1688 购物车里付款：https://cart.1688.com/cart.htm");
}

export async function buy(args: string[], json: boolean): Promise<void> {
	const [sub, ...rest] = args;
	if (sub === undefined) return show(json);
	if (sub === "order") return order(json);
	if (sub === "source") return source(rest[0], json);
	if (sub === "cart") return cart(rest, json);
	throw new Error("x2 buy order：同步订单；x2 buy：采购单；x2 buy source [SKU]：找货源；x2 buy cart [订单号…]：加进 1688 购物车");
}
