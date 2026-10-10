// 检查商品稿（docs/listing.md「每一步怎样算做完」）：每份的当前步骤、要人做的进收件箱、agent 能做的进 todo。纯函数，读写库在 index.ts
import { auditIssues, auditKey, auditNotes } from "../listing/audit.ts";
import type { Settings } from "../listing/make.ts";
import { imageNames } from "../listing/product.ts";
import { productOf } from "../listing/ready.ts";
import { textProblems } from "../listing/text.ts";
import { specsOf } from "../listing/variants.ts";
import type { InboxItem, Todo, Write } from "./orders.ts";

/** 当前步骤：按流程排（NocoDB 看板的列也是这个顺序） */
export const LISTING_STEPS = ["待做商品稿", "待补充", "待写文案", "待 Gemini 文字检查", "待批准", "建商品中", "待上架", "已上架", "已暂停", "已放弃"] as const;
export type ListingStep = (typeof LISTING_STEPS)[number];

const IN_FLIGHT = new Set(["待批准", "已批准", "已提交", "结果未知", "不一致"]);
const short = (s: string, n = 20) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function checkListings(listings: any[], settings: Map<string, Settings>, writes: Write[]): { inbox: InboxItem[]; todo: Todo[]; steps: Map<string, { step: ListingStep; detail: string | null }> } {
	const inbox: InboxItem[] = [], steps = new Map<string, { step: ListingStep; detail: string | null }>();
	const toMake: string[] = [], stale: string[] = [], toWrite: { id: string; why: string }[] = [], toCheck: string[] = [];
	const ready: { op: string; params: Record<string, unknown> }[] = [], readyIds: string[] = [];
	for (const l of listings) {
		const id = String(l.id);
		const s = settings.get(l.shop);
		const name = short(String(l.title ?? l.offer?.title ?? `货源 ${l.offer_id}`));
		const set = (step: ListingStep, detail: string | null = null) => steps.set(id, { step, detail });
		// Gemini 文字检查挑出的问题（只提示）：带编号写进说明，图写附件上的名字
		const notes = () => (l.audit ? auditNotes(auditIssues(l.audit, l.kept_images ?? [], imageNames(l.images ?? {}, specsOf(l.variants)))) : null);
		if (l.cancelled) { set("已放弃"); continue; }
		if (!s) { set("已暂停", "店铺设置无法读取：检查 NocoDB「店铺设置」里这家店填的数"); continue; }
		if (l.listed_at) { set("已上架", l.product_id ? `商品 ${l.product_id}` : null); continue; }
		const mine = writes.filter((w) => (w.op === "建商品" || w.op === "上架") && String(w.params?.listingId) === id && IN_FLIGHT.has(w.status));
		if (mine.some((w) => w.status === "待批准")) { set("待批准", ["收件箱里有「批准」", notes()].filter(Boolean).join("\n")); continue; }
		if (mine.length) { set("建商品中", mine.map((w) => `${w.op}：${w.status}`).join("；")); continue; }
		if (l.product_id) {
			set("待上架", `商品 ${l.product_id}（下架）`);
			ready.push({ op: "上架", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: `LT${l.offer_id}`, title: l.title } });
			readyIds.push(id);
			continue;
		}
		if (s.paused) { set("已暂停", s.paused); continue; }
		// 规格是旧格式（选项名每次现算的那种）：重做商品稿
		if (!l.offer || !specsOf(l.variants)) {
			set("待做商品稿", l.offer ? "规格为旧格式，待重做商品稿" : null);
			(l.offer ? stale : toMake).push(id);
			continue;
		}
		if (l.problems) {
			set("待补充", String(l.problems).split("\n")[0]!);
			inbox.push({
				key: `listing-fix:${id}`, kind: "商品稿", shop: l.shop, due: null, link: null,
				title: `商品稿：${name}（${l.shop}）待补充：${String(l.problems).split("\n")[0]}`,
				detail: `${l.problems}\n\n在 NocoDB「商品稿」里填写（重量 kg、国内运费 元/件），填写后 agent 再做一次（x2 listing make ${id}）；类目不在本店范围：在「店铺设置」里加上这个类目，或者勾「放弃」`,
			});
			continue;
		}
		if (!l.title || !l.description) { set("待写文案"); toWrite.push({ id, why: "还没写" }); continue; }
		const bad = textProblems(String(l.title), String(l.description));
		if (bad.length) { set("待写文案", bad.join("；")); toWrite.push({ id, why: bad.join("；") }); continue; }
		const r = productOf(l, s);
		if (!r.product) {
			set("待补充", r.problems[0] ?? null);
			inbox.push({ key: `listing-fix:${id}`, kind: "商品稿", shop: l.shop, due: null, link: null, title: `商品稿：${name}（${l.shop}）待补充：${r.problems[0]}`, detail: r.problems.join("\n") });
			continue;
		}
		if (!l.audit || l.audit.key !== auditKey(r.product)) { set("待 Gemini 文字检查"); toCheck.push(id); continue; }
		// Gemini 文字检查只提示、不挡：查过了，别的都齐了就待批准，挑出的问题写在说明里，人审稿时看
		set("待批准", notes());
		ready.push({ op: "建商品", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: r.product.parentSku, productInfo: r.info!, hash: r.hash! } });
		ready.push({ op: "上架", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: r.product.parentSku, title: r.product.title } });
		readyIds.push(id);
	}
	const todo: Todo[] = [];
	if (toMake.length || stale.length) {
		const why = [toMake.length ? `${toMake.length} 份商品稿还没做` : "", stale.length ? `${stale.length} 份商品稿的规格是旧格式，要重做` : ""].filter(Boolean).join("；");
		todo.push({ kind: "做商品稿", why, ids: [...toMake, ...stale], command: `x2 listing make ${[...toMake, ...stale].join(" ")}` });
	}
	if (toWrite.length) todo.push({ kind: "写文案", why: `${toWrite.length} 份商品稿要写标题和描述：${toWrite.map((x) => `${x.id}（${x.why}）`).join("、")}`, ids: toWrite.map((x) => x.id), command: `x2 listing show <商品稿>，写好用 x2 listing text` });
	if (toCheck.length) todo.push({ kind: "Gemini 文字检查", why: `${toCheck.length} 份商品稿的文案或图还没查过`, ids: toCheck, command: `x2 listing audit ${toCheck.join(" ")}` });
	if (ready.length) todo.push({
		kind: "上架", why: `${readyIds.length} 份商品稿待批准上架`,
		propose: { title: `上架 ${readyIds.length} 个商品稿（${readyIds.join("、")}）：先在 NocoDB「商品稿」的「审稿」里看标题、图、价格和说明`, writes: ready },
	});
	return { inbox, todo, steps };
}
