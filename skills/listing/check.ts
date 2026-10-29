// 检查商品稿：每份的当前步骤、要提醒人的、agent 能做的进 todo、人同意了就能建商品、上架的（ready）。纯函数，读写库在 index.ts

import type { Reminder } from "../../platform/tool.ts";
import { auditIssues, auditKey, auditNotes } from "./audit.ts";
import { estimateNeeds, type Settings } from "./pricing.ts";
import { imageNames } from "./product.ts";
import { productOf } from "./ready.ts";
import { listingName, textProblems } from "./text.ts";
import { specsOf } from "./variants.ts";

/** 当前步骤。网页上商品稿按它分组，组也是这个顺序（要人看的在前） */
export const LISTING_STEPS = ["待批准", "待补充", "待做商品稿", "待写文案", "待 Gemini 文字检查", "建商品中", "待上架", "已暂停", "已上架", "已放弃"] as const;
export type ListingStep = (typeof LISTING_STEPS)[number];

/** 建商品、上架的写入（库里的一行） */
export type Write = { id: string; batch: string; op: string; status: string; params: any; finishedAt: Date | null; error?: string | null };

/** agent 估重量、国内运费的一份商品稿：缺什么（needs），和估要用的事实（1688 的标题、每个规格、运费） */
export type EstimateItem = {
	id: string;
	name: string;
	shop: string;
	needs: ("重量" | "国内运费")[];
	title: string;
	specs: { spec: string; priceRmb: number; weightKg: number | null }[];
	freight: unknown;
	freeShipping: boolean;
};

/** agent 能做的：tool、params 是照着调的工具；估重量、写文案要 agent 先定值、写字（why 里写着怎么调），备注照做完再调 */
export type Todo =
	| { kind: "做商品稿"; why: string; tool: "listing.make"; params: { ids: string[] } }
	| { kind: "Gemini 文字检查"; why: string; tool: "listing.audit"; params: { ids: string[] } }
	| { kind: "估重量、国内运费"; why: string; items: EstimateItem[] }
	| { kind: "写文案"; why: string; ids: string[] }
	| { kind: "备注"; why: string; items: { id: string; name: string; note: string }[]; tool: "listing.noted"; params: { ids: string[] } };

// 建商品、上架的写入：x2 listing publish 照 ready 记进库、马上执行
const IN_FLIGHT = new Set(["待执行", "已提交", "结果未知", "不一致"]);

/** agent 估重量、国内运费要用的事实：1688 的标题，每个规格的 1688 原文、进价、1688 给的重量（没给是 null），1688 的运费和包邮 */
function estimateItem(l: any, needs: EstimateItem["needs"]): EstimateItem {
	const skus = new Map(((l.offer?.skus ?? []) as any[]).map((k) => [String(k.skuId), k]));
	return {
		id: String(l.id),
		name: listingName(l),
		shop: l.shop,
		needs,
		title: String(l.offer?.title ?? ""),
		specs: (specsOf(l.variants)?.variants ?? []).map((v) => {
			const k = skus.get(v.skuId);
			return {
				spec: ((k?.attrs ?? []) as string[]).filter(Boolean).join(" / ") || String(k?.name ?? v.sku),
				priceRmb: v.costRmb,
				weightKg: k?.weightKg > 0 ? Number(k.weightKg) : null,
			};
		}),
		freight: l.offer?.freight ?? null,
		freeShipping: Boolean(l.offer?.tags?.freeShipping),
	};
}

export type ListingsChecked = {
	reminders: Reminder[];
	todo: Todo[];
	steps: Map<string, { step: ListingStep; detail: string | null }>;
	/** 待批准、待上架的：人同意了 x2 listing publish 照它建商品、上架 */
	ready: { id: string; writes: { op: string; params: Record<string, unknown> }[] }[];
};

export function checkListings(listings: any[], settings: Map<string, Settings>, writes: Write[]): ListingsChecked {
	const reminders: Reminder[] = [],
		steps = new Map<string, { step: ListingStep; detail: string | null }>();
	const ready: ListingsChecked["ready"] = [];
	const waiting: { id: string; shop: string }[] = [],
		notes: { id: string; name: string; note: string }[] = [];
	// 商品稿都用「简称（店铺）」叫，agent 要跑命令的带上编号（listingName）
	const toMake: string[] = [],
		stale: string[] = [],
		recategorized: string[] = [],
		toWrite: { id: string; why: string }[] = [],
		toCheck: string[] = [],
		toEstimate: EstimateItem[] = [];
	const names = new Map<string, string>(),
		plainNames = new Map<string, string>();
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
		const set = (step: ListingStep, detail: string | null = null) => steps.set(id, { step, detail });
		// Gemini 文字检查挑出的问题（只提示）：带编号写进说明，图写图的名字
		const auditLines = () => (l.audit ? auditNotes(auditIssues(l.audit, l.kept_images ?? [], imageNames(l.images ?? {}, specsOf(l.variants)))) : null);
		if (l.cancelled) {
			set("已放弃");
			continue;
		}
		if (!s) {
			set("已暂停", "店铺设置无法读取：检查网页「店铺设置」里这家店填的数");
			continue;
		}
		if (l.listed_at) {
			set("已上架", l.product_id ? `商品 ${l.product_id}` : null);
			continue;
		}
		const ours = writes.filter((w) => (w.op === "建商品" || w.op === "上架") && String(w.params?.listingId) === id);
		const mine = ours.filter((w) => IN_FLIGHT.has(w.status));
		// 上一次被拒（Shopee 的原因）：没在做的时候写进说明，改好了再给人看
		const last = ours.filter((w) => w.status !== "未执行").sort((a, b) => Number(b.id) - Number(a.id))[0];
		const refused = last?.status === "被拒" ? `上次${last.op}被拒：${last.error ?? ""}` : null;
		if (mine.length) {
			set("建商品中", mine.map((w) => `${w.op}：${w.status}`).join("；"));
			continue;
		}
		if (l.product_id) {
			// 建好了还没上架（上架被拒、没执行）：人同意了 x2 listing publish 接着上架
			set("待上架", lines(`商品 ${l.product_id}（下架）`, refused, "人同意了 x2 listing publish 上架"));
			ready.push({
				id,
				writes: [{ op: "上架", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: `LT${l.offer_id}`, title: l.title, name } }],
			});
			continue;
		}
		if (s.paused) {
			set("已暂停", s.paused);
			continue;
		}
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
			reminders.push({
				key: `listing-fix:${id}`,
				kind: "商品稿",
				shop: l.shop,
				due: null,
				link: null,
				title: `商品稿：${name}待补充：${String(l.problems).split("\n")[0]}`,
				detail: `${l.problems}\n\n处理好以后 agent 再做一次（x2 listing make --ids ${id}）。类目不在本店范围：在「店铺设置」里加上这个类目，或者告诉 agent 换成哪个类目；不上这个货源：勾「放弃」`,
			});
			continue;
		}
		// 人换了类目（x2 listing category 清掉了属性、备货天数）：照新的类目重做商品稿
		if (l.category_path?.length && !l.days_to_ship) {
			set("待做商品稿", "换了类目，待照新的类目做属性、备货天数");
			recategorized.push(id);
			continue;
		}
		if (needs.length) {
			set("待做商品稿", `缺${needs.join("、")}：agent 估`);
			continue;
		}
		if (!l.title || !l.description) {
			set("待写文案");
			toWrite.push({ id, why: "还没写" });
			continue;
		}
		const bad = textProblems(String(l.title), String(l.description));
		if (bad.length) {
			set("待写文案", bad.join("；"));
			toWrite.push({ id, why: bad.join("；") });
			continue;
		}
		const r = productOf(l, s);
		if (!r.product) {
			set("待补充", r.problems[0] ?? null);
			reminders.push({
				key: `listing-fix:${id}`,
				kind: "商品稿",
				shop: l.shop,
				due: null,
				link: null,
				title: `商品稿：${name}待补充：${r.problems[0]}`,
				detail: r.problems.join("\n"),
			});
			continue;
		}
		if (!l.audit || l.audit.key !== auditKey(r.product)) {
			set("待 Gemini 文字检查");
			toCheck.push(id);
			continue;
		}
		// Gemini 文字检查只提示、不挡：查过了，别的都齐了就待批准，挑出的问题写在说明里，人审稿时看。人同意了 x2 listing publish 建商品、上架
		set("待批准", lines(refused, auditLines()));
		waiting.push({ id, shop: l.shop });
		ready.push({
			id,
			writes: [
				{ op: "建商品", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: r.product.parentSku, productInfo: r.info!, hash: r.hash!, name } },
				{ op: "上架", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: r.product.parentSku, title: r.product.title, name } },
			],
		});
	}
	// 提醒：一家店一行，去网页「商品稿」里看
	for (const shop of [...new Set(waiting.map((x) => x.shop))]) {
		const ids = waiting.filter((x) => x.shop === shop).map((x) => x.id);
		reminders.push({
			key: `listing-review:${shop}`,
			kind: "商品稿",
			shop,
			due: null,
			link: null,
			title: `待批准：${shop} ${ids.length} 个商品稿`,
			detail: `${ids.map((id) => plainNames.get(id)).join("、")}\n\n在网页「商品稿」的「审稿」里看标题、图、规格和价格、说明，要改的写在「备注」里；看过的跟 agent 说批准，agent 用 x2 listing publish 建商品、上架`,
		});
	}
	const todo: Todo[] = [];
	const named = (ids: string[]) => ids.map((id) => names.get(id)!).join("、");
	if (toMake.length || stale.length || recategorized.length) {
		const why = [
			toMake.length ? `还没做：${named(toMake)}` : "",
			stale.length ? `规格是旧格式，要重做：${named(stale)}` : "",
			recategorized.length ? `换了类目，要照新的类目重做：${named(recategorized)}` : "",
		]
			.filter(Boolean)
			.join("；");
		const ids = [...toMake, ...stale, ...recategorized];
		todo.push({ kind: "做商品稿", why, tool: "listing.make", params: { ids } });
	}
	if (toEstimate.length)
		todo.push({
			kind: "估重量、国内运费",
			why: `${toEstimate.map((x) => `${x.name}缺${x.needs.join("、")}`).join("；")}：照 1688 的标题和规格估，重量往重了估（轻的写 1 kg），国内运费往高了估，留出利润；x2 listing estimate --id <编号> --weight <kg> --freight <元/件>（只写缺的）`,
			items: toEstimate,
		});
	if (toWrite.length)
		todo.push({
			kind: "写文案",
			why: toWrite.map((x) => `${names.get(x.id)}：${x.why}`).join("；"),
			ids: toWrite.map((x) => x.id),
		});
	if (toCheck.length) todo.push({ kind: "Gemini 文字检查", why: `文案或图还没查过：${named(toCheck)}`, tool: "listing.audit", params: { ids: toCheck } });
	if (notes.length)
		todo.push({
			kind: "备注",
			why: `${notes.map((x) => `${x.name}：${x.note}`).join("；")}。照备注做（人写的备注不改），做完再调`,
			items: notes,
			tool: "listing.noted",
			params: { ids: notes.map((x) => x.id) },
		});
	return { reminders, todo, steps, ready };
}
