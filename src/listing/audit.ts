// 台湾成品审核：建商品前 Gemini 看成品图（一次 4 张）和标题、描述、规格，挑简体字、错字、误译（台湾买家不喜欢简体字）。
// 提示照 lilto 的 listing_content.audit_taiwan（快照 1c8a7926，第 2 版）：逐字抄问题原文，不把繁体先转简体再指控它是简体；
// 实物上印的字保留原貌；本店水印已核准。每张图都要按 index 回结果，漏了就报错。按内容的哈希缓存（记在商品稿的 audit 里）。
// 挑出的图 x2 自己处理（docs/listing.md「图」）：再问一次挑出的字在哪。印在商品上的不算问题；后加的文案，详情图和不是封面的主图 x2 去掉、重组商品再审，
// 封面、规格图留给人（换掉或放行）；保留的图只记备注。
// 挑出的每条问题有编号（先文案、后图），改掉或人放行才算通过（docs/listing.md「台湾审核放行」）：文案的放行记在这次审核里，内容一变就重审、放行作废
// （Gemini 每次的措辞不一样，不按原文对旧的放行）；图的放行记成商品稿的「保留的图」，以后审核再挑它也不挡
import { createHash } from "node:crypto";
import { gemini, geminiJson, type Image } from "../service/gemini.ts";
import { fetchImage } from "../service/image.ts";
import { IMAGE } from "../site/shopee/seller.ts";
import type { Pic, Pics } from "./images.ts";
import type { Product } from "./product.ts";
import { tiersOf } from "./variants.ts";

export const AUDIT_VERSION = 2;
/** 挑出的字在哪：印在商品本体上（不算问题，图保留原貌）、后加的文案 */
export type Where = "印在商品上" | "后加的文案";
/** 图在商品里是什么。同一张图在几处的，取这个顺序里的第一个 */
export type Role = "封面" | "规格图" | "主图" | "详情图";
/** x2 怎么处理挑出的一张图：已去掉、备注（不挡）、待处理（留给人：换掉或放行） */
export type Action = "已去掉" | "备注" | "待处理";
/** 审核挑出问题的一张图：字在哪（保留的图不问，没问出来的是空）、在商品里是什么、x2 怎么处理的 */
export type AuditImage = { id: string; issues: string[]; where?: Where; role?: Role; action?: Action };
/** 一次审核的结果。images 也记着 x2 去掉的图；accepted：人放行的文案问题（编号、时间） */
export type Audit = { key: string; textIssues: string[]; images: AuditImage[]; accepted?: { n: number; at: string }[]; at: string };
/** 一条问题：编号从 1 起，先文案、后图。待处理的挡着审核；已放行（人放行的文案、保留的图）、已去掉（x2 去掉的图）、不算问题（印在商品上的字）不挡 */
export type AuditIssue = { n: number; kind: "文案" | "图"; text: string; image?: string; role?: Role; where?: Where; status: "待处理" | "已放行" | "已去掉" | "不算问题" };
/** x2 去掉的图：Pic 的 drop 以它开头（人删的图记在已删除的图里，不在这） */
export const AUDIT_DROP = "台湾审核：";

const PROMPT = (mark: string, content: unknown) => `審核台灣 Shopee 零售成品。全程使用繁體中文，逐字抄錄問題原文，不得把繁體原文先轉成簡體再指控它是簡體。
核對標題、詳情、規格及圖片中的行銷文字是否繁體、通順，適合台灣消費者理解。只列明確錯字、簡體字、矛盾或難懂的誤譯；不因個人文風偏好、資訊可更詳細而拒絕。
商品本體或包裝實物印刷文字保留原貌，在 printedTextNotes 說明；後加行銷文案必須繁體，数字、單位、品牌英文可保留。
指定本店水印已核准且必須保留，不得建議移除、縮小或指控為非供應商行銷；只有真的遮住文字無法辨識才報錯。
逐張返回從0開始的 index、issues、printedTextNotes；另返回文案 textIssues。每個問題必須包含圖片或文案實際可見的原文，不得自行改寫原文。缺圖或無法識別明確報錯。
指定水印：${mark}
商品文案與規格：${JSON.stringify(content)}`;

const schema = (n: number) => ({
	type: "object",
	properties: {
		textIssues: { type: "array", items: { type: "string" } },
		images: { type: "array", minItems: n, maxItems: n, items: { type: "object", properties: { index: { type: "integer" }, issues: { type: "array", items: { type: "string" } }, printedTextNotes: { type: "array", items: { type: "string" } } }, required: ["index", "issues", "printedTextNotes"] } },
	},
	required: ["textIssues", "images"],
});

/** 审核挑出的字在哪：印在商品本体上（不算问题，图保留原貌）还是后加的文案。照 R_PROMPT 的样子，只答一个字母 */
export const WHERE_PROMPT = (issues: string[]) => `这是电商商品图。台湾审核在这张图上挑出了这些字：${issues.join("；")}
这些字是印在商品本体上的，还是后加的文案？
p = 都印在商品本体上：印在实物表面、跟着实物的形状和材质走的字（地垫印花图案里的字、瓶身标签、包装印刷、表盘铭牌）
m = 有后加的文案：画在图上的标题、卖点、说明、参数，后加的圆圈、方框、色块里的标签、角标
只输出 p 或 m。`;

/** 问 Gemini 挑出的字在哪；答不出回 null（留给人） */
export async function textWhere(img: Image, issues: string[]): Promise<Where | null> {
	const t = (await gemini(WHERE_PROMPT(issues), [img])).replace(/[\s`'"“”‘’.,，。:：;；!！?？()（）[\]【】-]/g, "").toLowerCase();
	return /^p+$/.test(t) ? "印在商品上" : /^m+$/.test(t) ? "后加的文案" : null;
}

/** 要审的图：主图、详情图、规格图（去重） */
export const auditImages = (p: Product) => [...new Set([...p.images, ...p.detail.map((d) => d.id), ...Object.values(p.optionImages)])];

/** 这份内容的审核键：标题、描述、规格名、图、水印一样，就不用再审 */
export function auditKey(p: Product, mark: string): string {
	const specs = tiersOf(p.variants).tiers.map((t) => [t.name, t.options.map((o) => o.name)]);
	return createHash("sha256").update(JSON.stringify({ v: AUDIT_VERSION, title: p.title, description: p.description, specs, images: auditImages(p), mark })).digest("hex");
}

/** 图在商品里是什么 */
export function roleOf(p: Product, id: string): Role {
	if (p.images[0] === id) return "封面";
	if (Object.values(p.optionImages).includes(id)) return "规格图";
	return p.images.includes(id) ? "主图" : "详情图";
}

/** 挑出的一张图怎么处理：保留的图、印在商品上的字只记备注；后加的文案，详情图和不是封面的主图 x2 去掉（canDrop：还能再审），
 * 封面、规格图少了会影响商品，留给人；没问出字在哪的也留给人 */
export function dispose(where: Where | null, role: Role, kept: boolean, canDrop: boolean): Action {
	if (kept || where === "印在商品上") return "备注";
	return where === "后加的文案" && canDrop && (role === "主图" || role === "详情图") ? "已去掉" : "待处理";
}

/** 审核一份商品：kept 是保留的图（不问、不挡）；canDrop 是这一轮去掉了图还能再审 */
export async function auditTaiwan(p: Product, mark: string, opts: { kept?: Iterable<string>; canDrop?: boolean } = {}): Promise<Audit> {
	const kept = new Set(opts.kept ?? []);
	const ids = auditImages(p);
	const content = { title: p.title, description: p.description, specs: tiersOf(p.variants).tiers.map((t) => ({ name: t.name, options: t.options.map((o) => o.name) })) };
	const textIssues = new Set<string>();
	const images: AuditImage[] = [];
	for (let i = 0; i < Math.max(ids.length, 1); i += 4) {
		const batch = ids.slice(i, i + 4);
		const bytes = await Promise.all(batch.map((id) => fetchImage(`${IMAGE}${id}`)));
		const prompt = `${batch.length ? `本批恰有 ${batch.length} 张图片，必须逐一返回 index=[0..${batch.length - 1}]，即使相似也不能合并。\n` : ""}${PROMPT(mark, content)}`;
		const r = await geminiJson<{ textIssues: string[]; images: { index: number; issues: string[] }[] }>(prompt, bytes, schema(batch.length));
		const got = new Set(r.images.map((x) => x.index));
		if (batch.some((_, j) => !got.has(j))) throw new Error("台湾成品审核漏了图：这一批要重审");
		for (const t of r.textIssues) textIssues.add(t);
		for (const x of r.images) {
			const id = batch[x.index];
			if (!x.issues.length || !id) continue;
			const role = roleOf(p, id), keep = kept.has(id);
			const where = keep ? null : await textWhere(bytes[x.index]!, x.issues);
			images.push({ id, issues: x.issues, ...(where ? { where } : {}), role, action: dispose(where, role, keep, opts.canDrop ?? false) });
		}
	}
	return { key: auditKey(p, mark), textIssues: [...textIssues], images, at: new Date().toISOString() };
}

/** x2 去掉审核挑出的图：主图、详情图里这几张（图片 id）的 Pic 写上 drop */
export function dropAudited(pics: Pics, drops: AuditImage[]): Pics {
	const why = new Map(drops.map((x) => [x.id, `${AUDIT_DROP}${x.issues.join("；")}`]));
	const mark = (list: Pic[] = []) => list.map((p) => (p.imageId && why.has(p.imageId) && !p.drop ? { ...p, drop: why.get(p.imageId)! } : p));
	return { ...pics, main: mark(pics.main), detail: mark(pics.detail) };
}

/** 人要用 x2 去掉的图（放行了）：放回来 */
export function restoreAudited(pics: Pics, ids: Iterable<string>): Pics {
	const back = new Set(ids);
	const clear = (list: Pic[] = []) => list.map((p) => {
		if (!p.imageId || !back.has(p.imageId) || !p.drop?.startsWith(AUDIT_DROP)) return p;
		const { drop: _, ...rest } = p;
		return rest;
	});
	return { ...pics, main: clear(pics.main), detail: clear(pics.detail) };
}

/** 商品稿上 x2 去掉的图，一张一条（记进审核结果，人看得到、能放行） */
export function auditDropped(pics: Pics): AuditImage[] {
	const out = new Map<string, AuditImage>();
	for (const [list, role] of [[pics.main ?? [], "主图"], [pics.detail ?? [], "详情图"]] as const) for (const p of list) {
		if (p.imageId && p.drop?.startsWith(AUDIT_DROP) && !out.has(p.imageId)) out.set(p.imageId, { id: p.imageId, issues: [p.drop.slice(AUDIT_DROP.length)], where: "后加的文案", role, action: "已去掉" });
	}
	return [...out.values()];
}

/** 审核结果 → 编号的问题。kept：保留的图（图片 id），挑出它也不挡 */
export function auditIssues(a: Partial<Audit>, kept: Iterable<string> = []): AuditIssue[] {
	const keep = new Set(kept), accepted = new Set((a.accepted ?? []).map((x) => x.n));
	const text = (a.textIssues ?? []).map((t, i): AuditIssue => ({ n: i + 1, kind: "文案", text: t, status: accepted.has(i + 1) ? "已放行" : "待处理" }));
	const images = (a.images ?? []).map((x, i): AuditIssue => ({
		n: text.length + i + 1, kind: "图", text: x.issues.join("；"), image: x.id, ...(x.role ? { role: x.role } : {}), ...(x.where ? { where: x.where } : {}),
		status: x.action === "已去掉" ? "已去掉" : keep.has(x.id) ? "已放行" : x.action === "备注" ? "不算问题" : "待处理",
	}));
	return [...text, ...images];
}

/** 审核通过：审过，每条问题都放行了（没挑出问题也算） */
export const auditPassed = (a: Partial<Audit>, kept: Iterable<string> = []) => auditIssues(a, kept).every((x) => x.status !== "待处理");

/** 人放行第几条（人说了，agent 替人记）：文案的记进这次审核的 accepted，图的记进保留的图；x2 去掉的图放行了要放回来（restore）。
 * 不挡的（不算问题、已放行的）不用再记。没有的编号回在 unknown 里 */
export function acceptIssues(a: Audit, kept: string[], ns: number[], at: string): { audit: Audit; kept: string[]; restore: string[]; unknown: number[] } {
	const all = auditIssues(a, kept);
	const pick = all.filter((x) => ns.includes(x.n) && (x.status === "待处理" || x.status === "已去掉"));
	return {
		audit: { ...a, accepted: [...(a.accepted ?? []), ...pick.filter((x) => x.kind === "文案").map((x) => ({ n: x.n, at }))] },
		kept: [...new Set([...kept, ...pick.filter((x) => x.kind === "图").map((x) => x.image!)])],
		restore: pick.filter((x) => x.status === "已去掉").map((x) => x.image!),
		unknown: ns.filter((n) => !all.some((x) => x.n === n)),
	};
}
