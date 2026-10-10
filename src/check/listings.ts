// 检查商品稿（docs/listing.md「每一步怎样算做完」）：每份卡在哪一步、要人做的进收件箱、agent 能做的进 todo。纯函数，读写库在 index.ts
import { auditKey } from "../listing/audit.ts";
import type { Settings } from "../listing/make.ts";
import { productOf } from "../listing/ready.ts";
import { textProblems } from "../listing/text.ts";
import type { InboxItem, Todo, Write } from "./orders.ts";

/** 卡在哪一步：按流程排（NocoDB 看板的列也是这个顺序） */
export const LISTING_STEPS = ["要做商品稿", "要人补", "等文案", "等台湾审核", "台湾审核没过", "等批准", "建商品中", "建好了没上架", "已上架", "暂停上品", "不上了"] as const;
export type ListingStep = (typeof LISTING_STEPS)[number];

const IN_FLIGHT = new Set(["待批准", "已批准", "已提交", "结果未知", "不一致"]);
const short = (s: string, n = 20) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function checkListings(listings: any[], settings: Map<string, Settings>, writes: Write[]): { inbox: InboxItem[]; todo: Todo[]; steps: Map<string, { step: ListingStep; detail: string | null }> } {
	const inbox: InboxItem[] = [], steps = new Map<string, { step: ListingStep; detail: string | null }>();
	const toMake: string[] = [], toWrite: { id: string; why: string }[] = [], toAudit: string[] = [];
	const ready: { op: string; params: Record<string, unknown> }[] = [], readyIds: string[] = [];
	for (const l of listings) {
		const id = String(l.id);
		const s = settings.get(l.shop);
		const name = short(String(l.title ?? l.offer?.title ?? `货源 ${l.offer_id}`));
		const set = (step: ListingStep, detail: string | null = null) => steps.set(id, { step, detail });
		if (l.cancelled) { set("不上了"); continue; }
		if (!s) { set("暂停上品", "店铺设置读不了：看看 NocoDB「店铺设置」里这家店的数填得对不对"); continue; }
		if (l.listed_at) { set("已上架", l.product_id ? `商品 ${l.product_id}` : null); continue; }
		const mine = writes.filter((w) => (w.op === "建商品" || w.op === "上架") && String(w.params?.listingId) === id && IN_FLIGHT.has(w.status));
		if (mine.some((w) => w.status === "待批准")) { set("等批准", "收件箱里有「批准」"); continue; }
		if (mine.length) { set("建商品中", mine.map((w) => `${w.op}：${w.status}`).join("；")); continue; }
		if (l.product_id) {
			set("建好了没上架", `商品 ${l.product_id}（下架）`);
			ready.push({ op: "上架", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: `LT${l.offer_id}`, title: l.title } });
			readyIds.push(id);
			continue;
		}
		if (s.paused) { set("暂停上品", s.paused); continue; }
		if (!l.offer) { set("要做商品稿"); toMake.push(id); continue; }
		if (l.problems) {
			set("要人补", String(l.problems).split("\n")[0]!);
			inbox.push({
				key: `listing-fix:${id}`, kind: "商品稿", shop: l.shop, due: null, link: null,
				title: `商品稿：${name}（${l.shop}）要人补：${String(l.problems).split("\n")[0]}`,
				detail: `${l.problems}\n\n在 NocoDB「商品稿」里填（重量 kg、国内运费 元/件），填好了 agent 再做一次（x2 listing make ${id}）；类目不在本店范围：在「店铺设置」里加上这个类目，或者勾「不上了」`,
			});
			continue;
		}
		if (!l.title || !l.description) { set("等文案"); toWrite.push({ id, why: "还没写" }); continue; }
		const bad = textProblems(String(l.title), String(l.description));
		if (bad.length) { set("等文案", bad.join("；")); toWrite.push({ id, why: bad.join("；") }); continue; }
		const r = productOf(l, s);
		if (!r.product) {
			set("要人补", r.problems[0] ?? null);
			inbox.push({ key: `listing-fix:${id}`, kind: "商品稿", shop: l.shop, due: null, link: null, title: `商品稿：${name}（${l.shop}）要人补：${r.problems[0]}`, detail: r.problems.join("\n") });
			continue;
		}
		if (!l.audit || l.audit.key !== auditKey(r.product, s.mark?.text ?? "")) { set("等台湾审核"); toAudit.push(id); continue; }
		if (!l.audit.ok) {
			const text = (l.audit.textIssues ?? []) as string[], imgs = (l.audit.images ?? []) as { id: string; issues: string[] }[];
			set("台湾审核没过", [...text, ...imgs.flatMap((x) => x.issues)].slice(0, 3).join("；"));
			if (text.length) toWrite.push({ id, why: `台湾审核挑出文案的问题：${text.join("；")}` });
			if (imgs.length) inbox.push({
				key: `listing-image:${id}`, kind: "商品稿", shop: l.shop, due: null, link: null,
				title: `商品稿：${name}（${l.shop}）台湾审核挑出 ${imgs.length} 张图有问题`,
				detail: `${imgs.map((x) => `· 图 ${x.id}：${x.issues.join("；")}`).join("\n")}\n\n在 NocoDB「商品稿」的主图、详情图里删掉这几张，再审一次（x2 listing audit ${id}）`,
			});
			continue;
		}
		set("等批准");
		ready.push({ op: "建商品", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: r.product.parentSku, productInfo: r.info!, hash: r.hash! } });
		ready.push({ op: "上架", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: r.product.parentSku, title: r.product.title } });
		readyIds.push(id);
	}
	const todo: Todo[] = [];
	if (toMake.length) todo.push({ kind: "做商品稿", why: `${toMake.length} 份商品稿还没做`, ids: toMake, command: `x2 listing make ${toMake.join(" ")}` });
	if (toWrite.length) todo.push({ kind: "写文案", why: `${toWrite.length} 份商品稿要写标题和描述：${toWrite.map((x) => `${x.id}（${x.why}）`).join("、")}`, ids: toWrite.map((x) => x.id), command: `x2 listing show <商品稿>，写好用 x2 listing text` });
	if (toAudit.length) todo.push({ kind: "台湾审核", why: `${toAudit.length} 份商品稿的文案或图变了，要再审`, ids: toAudit, command: `x2 listing audit ${toAudit.join(" ")}` });
	if (ready.length) todo.push({
		kind: "上架", why: `${readyIds.length} 份商品稿审过了，等批准上架`,
		propose: { title: `上架 ${readyIds.length} 个商品稿（${readyIds.join("、")}）：先在 NocoDB「商品稿」里看过标题、图、价格`, writes: ready },
	});
	return { inbox, todo, steps };
}
