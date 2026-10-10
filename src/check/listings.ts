// 检查商品稿（docs/listing.md「每一步怎样算做完」）：每份的当前步骤、要人做的进收件箱、agent 能做的进 todo。纯函数，读写库在 index.ts
import { auditIssues, auditKey } from "../listing/audit.ts";
import type { Settings } from "../listing/make.ts";
import { productOf } from "../listing/ready.ts";
import { textProblems } from "../listing/text.ts";
import type { InboxItem, Todo, Write } from "./orders.ts";

/** 当前步骤：按流程排（NocoDB 看板的列也是这个顺序） */
export const LISTING_STEPS = ["待做商品稿", "待补充", "待写文案", "待台湾审核", "台湾审核未通过", "待批准", "建商品中", "待上架", "已上架", "已暂停", "已放弃"] as const;
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
		if (l.cancelled) { set("已放弃"); continue; }
		if (!s) { set("已暂停", "店铺设置无法读取：检查 NocoDB「店铺设置」里这家店填的数"); continue; }
		if (l.listed_at) { set("已上架", l.product_id ? `商品 ${l.product_id}` : null); continue; }
		const mine = writes.filter((w) => (w.op === "建商品" || w.op === "上架") && String(w.params?.listingId) === id && IN_FLIGHT.has(w.status));
		if (mine.some((w) => w.status === "待批准")) { set("待批准", "收件箱里有「批准」"); continue; }
		if (mine.length) { set("建商品中", mine.map((w) => `${w.op}：${w.status}`).join("；")); continue; }
		if (l.product_id) {
			set("待上架", `商品 ${l.product_id}（下架）`);
			ready.push({ op: "上架", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: `LT${l.offer_id}`, title: l.title } });
			readyIds.push(id);
			continue;
		}
		if (s.paused) { set("已暂停", s.paused); continue; }
		if (!l.offer) { set("待做商品稿"); toMake.push(id); continue; }
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
		if (!l.audit || l.audit.key !== auditKey(r.product, s.mark?.text ?? "")) { set("待台湾审核"); toAudit.push(id); continue; }
		// 审核挑出的问题：改掉，或人放行（文案的放行记在审核里，图的放行是保留的图）才算通过
		const open = auditIssues(l.audit, l.kept_images ?? []).filter((x) => x.status === "待处理");
		if (open.length) {
			const text = open.filter((x) => x.kind === "文案"), imgs = open.filter((x) => x.kind === "图");
			set("台湾审核未通过", open.slice(0, 3).map((x) => `${x.n}. ${x.text}`).join("；"));
			if (text.length) toWrite.push({ id, why: `台湾审核挑出文案的问题：${text.map((x) => `${x.n}. ${x.text}`).join("；")}` });
			if (imgs.length) inbox.push({
				key: `listing-image:${id}`, kind: "商品稿", shop: l.shop, due: null, link: null,
				title: `商品稿：${name}（${l.shop}）台湾审核挑出 ${imgs.length} 张图有问题`,
				detail: `${imgs.map((x) => `${x.n}. 图 ${x.image}：${x.text}`).join("\n")}\n\n不用的图：在 NocoDB「商品稿」的主图、详情图里删除，再审一次（x2 listing audit ${id}）\n要用的图（误报或无妨）：告诉 agent 放行哪几条（x2 listing audit ${id} --accept 编号）`,
			});
			continue;
		}
		set("待批准");
		ready.push({ op: "建商品", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: r.product.parentSku, productInfo: r.info!, hash: r.hash! } });
		ready.push({ op: "上架", params: { listingId: id, shop: l.shop, shopId: s.shopId, parentSku: r.product.parentSku, title: r.product.title } });
		readyIds.push(id);
	}
	const todo: Todo[] = [];
	if (toMake.length) todo.push({ kind: "做商品稿", why: `${toMake.length} 份商品稿还没做`, ids: toMake, command: `x2 listing make ${toMake.join(" ")}` });
	if (toWrite.length) todo.push({ kind: "写文案", why: `${toWrite.length} 份商品稿要写标题和描述：${toWrite.map((x) => `${x.id}（${x.why}）`).join("、")}`, ids: toWrite.map((x) => x.id), command: `x2 listing show <商品稿>，写好用 x2 listing text` });
	if (toAudit.length) todo.push({ kind: "台湾审核", why: `${toAudit.length} 份商品稿的文案或图变了，要再审`, ids: toAudit, command: `x2 listing audit ${toAudit.join(" ")}` });
	if (ready.length) todo.push({
		kind: "上架", why: `${readyIds.length} 份商品稿已过台湾审核，待批准上架`,
		propose: { title: `上架 ${readyIds.length} 个商品稿（${readyIds.join("、")}）：先在 NocoDB「商品稿」里查看标题、图、价格`, writes: ready },
	});
	return { inbox, todo, steps };
}
