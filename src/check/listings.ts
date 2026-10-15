// 检查商品稿（docs/listing.md「每一步怎样算做完」）：每份的当前步骤、要人做的进收件箱、agent 能做的进 todo。纯函数，读写库在 index.ts
import { auditIssues, auditKey, auditNotes } from "../listing/audit.ts";
import { estimateNeeds, type Settings } from "../listing/make.ts";
import { imageNames } from "../listing/product.ts";
import { productOf } from "../listing/ready.ts";
import { listingName, textProblems } from "../listing/text.ts";
import { specsOf } from "../listing/variants.ts";
import type { EstimateItem, InboxItem, Todo, Write } from "./orders.ts";

/** 当前步骤。网页上商品稿按它分组，组也是这个顺序（要人看的在前） */
export const LISTING_STEPS = ["待批准", "待补充", "待做商品稿", "待写文案", "待 Gemini 文字检查", "已批准", "建商品中", "待上架", "已暂停", "已上架", "已放弃"] as const;
export type ListingStep = (typeof LISTING_STEPS)[number];

// 建商品、上架的写入由 x2 run 照「批准上架」的勾生成（已批准）；以前经 x2 propose 准备、还待批准的不算（x2 run 把它们标成未执行）
const IN_FLIGHT = new Set(["已批准", "已提交", "结果未知", "不一致"]);

/** 去掉勾的原因（写进 unapproved_why，说明里给人看） */
export const UNAPPROVED = {
	changed: "勾了「批准上架」以后内容（标题、描述、规格、价格、图……）改了，去掉了勾：看过再勾",
	early: (step: string) => `勾「批准上架」时还没到待批准（${step}），去掉了勾：到了待批准再勾`,
};

/** 「批准上架」的勾：clear 去掉（原因）；capture 认下勾的那一刻的内容（勾的时候 hash 还没重算）。at 是批准时间：只改读到的那一次勾 */
export type Approval = { at: Date | null } & ({ clear: string } | { capture: string });

/** agent 估重量、国内运费要用的事实：1688 的标题，每个规格的 1688 原文、进价、1688 给的重量（没给是 null），1688 的运费和包邮 */
function estimateItem(l: any, needs: EstimateItem["needs"]): EstimateItem {
	const skus = new Map(((l.offer?.skus ?? []) as any[]).map((k) => [String(k.skuId), k]));
	return {
		id: String(l.id), name: listingName(l), shop: l.shop, needs, title: String(l.offer?.title ?? ""),
		specs: (specsOf(l.variants)?.variants ?? []).map((v) => {
			const k = skus.get(v.skuId);
			return { spec: ((k?.attrs ?? []) as string[]).filter(Boolean).join(" / ") || String(k?.name ?? v.sku), priceRmb: v.costRmb, weightKg: k?.weightKg > 0 ? Number(k.weightKg) : null };
		}),
		freight: l.offer?.freight ?? null, freeShipping: Boolean(l.offer?.tags?.freeShipping),
	};
}

export type ListingsChecked = {
	inbox: InboxItem[]; todo: Todo[]; steps: Map<string, { step: ListingStep; detail: string | null }>;
	/** 内容（要建的商品的 hash），只在待批准、已批准时有；勾的变化；勾了、内容没变的要做的写入（x2 run 照它生成） */
	hashes: Map<string, string | null>; approvals: Map<string, Approval>; approved: { id: string; writes: { op: string; params: Record<string, unknown> }[] }[];
};

export function checkListings(listings: any[], settings: Map<string, Settings>, writes: Write[]): ListingsChecked {
	const inbox: InboxItem[] = [], steps = new Map<string, { step: ListingStep; detail: string | null }>();
	const hashes = new Map<string, string | null>(), approvals = new Map<string, Approval>(), approved: ListingsChecked["approved"] = [];
	const waiting: { id: string; shop: string }[] = [], notes: { id: string; name: string; note: string }[] = [];
	// 商品稿都用「简称（店铺）」叫，agent 要跑命令的带上编号（listingName）
	const toMake: string[] = [], stale: string[] = [], recategorized: string[] = [], toWrite: { id: string; why: string }[] = [], toCheck: string[] = [], toEstimate: EstimateItem[] = [];
	const names = new Map<string, string>(), plainNames = new Map<string, string>();
	const lines = (...xs: (string | null | undefined)[]) => xs.filter(Boolean).join("\n") || null;
	for (const l of listings) {
		const id = String(l.id);
		const s = settings.get(l.shop);
		const name = listingName(l, false);
		names.set(id, listingName(l));
		plainNames.set(id, name);
		// 人写的备注：上次 agent 看过以后又改了（x2 listing noted 记下看过的）
		const note = String(l.note ?? "").trim();
		if (!l.cancelled && note && l.note !== l.noted) notes.push({ id, name: listingName(l), note: String(l.note) });
		hashes.set(id, null);
		const set = (step: ListingStep, detail: string | null = null) => {
			steps.set(id, { step, detail });
			// 勾着「批准上架」、还没建商品，却不在待批准、已批准：去掉勾（勾的时候还不到，或者勾了以后内容变了，又要重做、再查）
			if (l.approve && !l.product_id && !l.listed_at && !l.cancelled && step !== "已批准" && step !== "待批准" && step !== "建商品中") {
				const why = l.approved_hash ? UNAPPROVED.changed : UNAPPROVED.early(step);
				approvals.set(id, { at: l.approved_at ?? null, clear: why });
				steps.set(id, { step, detail: lines(why, detail) });
			}
		};
		// Gemini 文字检查挑出的问题（只提示）：带编号写进说明，图写图的名字
		const auditLines = () => (l.audit ? auditNotes(auditIssues(l.audit, l.kept_images ?? [], imageNames(l.images ?? {}, specsOf(l.variants)))) : null);
		if (l.cancelled) { set("已放弃"); continue; }
		if (!s) { set("已暂停", "店铺设置无法读取：检查网页「店铺设置」里这家店填的数"); continue; }
		if (l.listed_at) { set("已上架", l.product_id ? `商品 ${l.product_id}` : null); continue; }
		const ours = writes.filter((w) => (w.op === "建商品" || w.op === "上架") && String(w.params?.listingId) === id);
		const mine = ours.filter((w) => IN_FLIGHT.has(w.status));
		// 上一次被拒（Shopee 的原因）：没在做的时候写进说明，改好了再勾
		const last = ours.filter((w) => w.status !== "未执行").sort((a, b) => Number(b.id) - Number(a.id))[0];
		const refused = last?.status === "被拒" ? `上次${last.op}被拒：${last.error ?? ""}` : null;
		if (mine.length) { set("建商品中", mine.map((w) => `${w.op}：${w.status}`).join("；")); continue; }
		if (l.product_id) {
			// 建好了还没上架（上架被拒、没执行）：勾着就接着上架
			if (l.approve) {
				set("待上架", `商品 ${l.product_id}（下架）：已勾「批准上架」，等 x2 run 上架`);
				approved.push({ id, writes: [{ op: "上架", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: `LT${l.offer_id}`, title: l.title, name } }] });
			} else set("待上架", lines(`商品 ${l.product_id}（下架）`, l.unapproved_why ?? refused, "勾「批准上架」以后 x2 run 上架"));
			continue;
		}
		if (s.paused) { set("已暂停", s.paused); continue; }
		// 规格是旧格式（选项名每次现算的那种）：重做商品稿
		if (!l.offer || !specsOf(l.variants)) {
			set("待做商品稿", l.offer ? "规格为旧格式，待重做商品稿" : null);
			(l.offer ? stale : toMake).push(id);
			continue;
		}
		// 1688 没给的重量、读不到的国内运费：agent 估（人的问题没处理完也可以先估）
		const needs = estimateNeeds(l);
		if (needs.length) toEstimate.push(estimateItem(l, needs));
		if (l.problems) {
			set("待补充", String(l.problems).split("\n")[0]!);
			inbox.push({
				key: `listing-fix:${id}`, kind: "商品稿", shop: l.shop, due: null, link: null,
				title: `商品稿：${name}待补充：${String(l.problems).split("\n")[0]}`,
				detail: `${l.problems}\n\n处理好以后 agent 再做一次（x2 listing make ${id}）。类目不在本店范围：在「店铺设置」里加上这个类目，或者告诉 agent 换成哪个类目；不上这个货源：勾「放弃」`,
			});
			continue;
		}
		// 人换了类目（x2 listing category 清掉了属性、备货天数）：照新的类目重做商品稿
		if (l.category_path?.length && !l.days_to_ship) { set("待做商品稿", "换了类目，待照新的类目做属性、备货天数"); recategorized.push(id); continue; }
		if (needs.length) { set("待做商品稿", `缺${needs.join("、")}：agent 估`); continue; }
		if (!l.title || !l.description) { set("待写文案"); toWrite.push({ id, why: "还没写" }); continue; }
		const bad = textProblems(String(l.title), String(l.description));
		if (bad.length) { set("待写文案", bad.join("；")); toWrite.push({ id, why: bad.join("；") }); continue; }
		const r = productOf(l, s);
		if (!r.product) {
			set("待补充", r.problems[0] ?? null);
			inbox.push({ key: `listing-fix:${id}`, kind: "商品稿", shop: l.shop, due: null, link: null, title: `商品稿：${name}待补充：${r.problems[0]}`, detail: r.problems.join("\n") });
			continue;
		}
		if (!l.audit || l.audit.key !== auditKey(r.product)) { set("待 Gemini 文字检查"); toCheck.push(id); continue; }
		// Gemini 文字检查只提示、不挡：查过了，别的都齐了就待批准，挑出的问题写在说明里，人审稿时看。
		// 人勾了「批准上架」、内容和勾的时候一样：已批准，x2 run 建商品、上架；内容变了去掉勾
		hashes.set(id, r.hash!);
		let ok = false;
		if (l.approve && !l.approved_hash) { approvals.set(id, { at: l.approved_at ?? null, capture: r.hash! }); ok = true; }
		else if (l.approve && l.approved_hash === r.hash) ok = true;
		else if (l.approve) approvals.set(id, { at: l.approved_at ?? null, clear: UNAPPROVED.changed });
		if (ok) {
			set("已批准", lines("已勾「批准上架」：等 x2 run 建商品、上架", auditLines()));
			approved.push({ id, writes: [
				{ op: "建商品", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: r.product.parentSku, productInfo: r.info!, hash: r.hash!, name } },
				{ op: "上架", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: r.product.parentSku, title: r.product.title, name } },
			] });
		} else {
			set("待批准", lines(l.approve ? UNAPPROVED.changed : l.unapproved_why ?? refused, auditLines()));
			waiting.push({ id, shop: l.shop });
		}
	}
	// 收件箱：一家店一行，提醒去网页「商品稿」里看、勾；没有待批准的就关
	for (const shop of [...new Set(waiting.map((x) => x.shop))]) {
		const ids = waiting.filter((x) => x.shop === shop).map((x) => x.id);
		inbox.push({
			key: `listing-approve:${shop}`, kind: "商品稿", shop, due: null, link: null,
			title: `待批准：${shop} ${ids.length} 个商品稿`,
			detail: `${ids.map((id) => plainNames.get(id)).join("、")}\n\n在网页「商品稿」的「审稿」里看标题、图、规格和价格、说明，看过的勾「批准上架」；agent 接着 x2 run 建商品、上架。要改的写在「备注」里`,
		});
	}
	const todo: Todo[] = [];
	const named = (ids: string[]) => ids.map((id) => names.get(id)!).join("、");
	if (toMake.length || stale.length || recategorized.length) {
		const why = [toMake.length ? `还没做：${named(toMake)}` : "", stale.length ? `规格是旧格式，要重做：${named(stale)}` : "", recategorized.length ? `换了类目，要照新的类目重做：${named(recategorized)}` : ""].filter(Boolean).join("；");
		const ids = [...toMake, ...stale, ...recategorized];
		todo.push({ kind: "做商品稿", why, ids, command: `x2 listing make ${ids.join(" ")}` });
	}
	if (toEstimate.length) todo.push({
		kind: "估重量、国内运费",
		why: `${toEstimate.map((x) => `${x.name}缺${x.needs.join("、")}`).join("；")}：照 1688 的标题和规格估，重量往重了估（轻的写 1 kg），国内运费往高了估，留出利润`,
		items: toEstimate, command: "x2 listing estimate <商品稿> --weight <kg> --freight <元/件>（只写缺的）",
	});
	if (toWrite.length) todo.push({ kind: "写文案", why: toWrite.map((x) => `${names.get(x.id)}：${x.why}`).join("；"), ids: toWrite.map((x) => x.id), command: `x2 listing show <商品稿>，写好标题、描述、规格名、简称用 x2 listing text` });
	if (toCheck.length) todo.push({ kind: "Gemini 文字检查", why: `文案或图还没查过：${named(toCheck)}`, ids: toCheck, command: `x2 listing audit ${toCheck.join(" ")}` });
	if (notes.length) todo.push({ kind: "备注", why: notes.map((x) => `${x.name}：${x.note}`).join("；"), items: notes, command: "照备注做（人写的备注不改），做完 x2 listing noted <商品稿>" });
	if (approved.length) todo.push({ kind: "上架", why: `已勾「批准上架」：${named(approved.map((x) => x.id))}`, ids: approved.map((x) => x.id), command: "x2 run" });
	return { inbox, todo, steps, hashes, approvals, approved };
}
