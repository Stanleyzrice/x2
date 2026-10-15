// Gemini 文字检查：建商品前 Gemini 看商品稿的文案（标题、描述、规格名）和加水印之前的图（一次 4 张；译过的看译图，没译的看原图：水印会挡住字），
// 挑简体字、错字、误译（台湾买家不喜欢简体字）。只提示、不挡：挑出的问题带编号写进商品稿的「说明」，人审稿时看。
// 提示照 lilto 的 listing_content.audit_taiwan（快照 1c8a7926，第 2 版）：逐字抄问题原文，不把繁体先转简体再指控它是简体；实物上印的字保留原貌。
// 每张图都要按 index 回结果，漏了就报错。几批同时问，挑出的图再问字在哪也同时问（同时问几个由 queue.ts 的上限管）。按内容的哈希缓存（记在商品稿的 audit 里）。
// 挑出的图再问一次挑出的字在哪（docs/listing.md「Gemini 文字检查」）：印在商品上的不算问题；后加的文案，详情图和不是封面的主图 x2 去掉、重组商品再查，
// 封面、规格图少了会影响商品，只提示；保留的图（人说要用的）不问、不去掉
import { createHash } from "node:crypto";
import type { Image } from "../service/gemini.ts";
import type { Pic, Pics } from "./images.ts";
import type { Product } from "./product.ts";
import { gemini, geminiJson } from "./queue.ts";

export const AUDIT_VERSION = 3;
/** 挑出的字在哪：印在商品本体上（不算问题，图保留原貌）、后加的文案 */
export type Where = "印在商品上" | "后加的文案";
/** 图在商品里是什么。同一张图在几处的，取这个顺序里的第一个 */
export type Role = "封面" | "规格图" | "主图" | "详情图";
/** 挑出问题的一张图：字在哪（保留的图不问，没问出来的是空）、在商品里是什么、x2 去掉了没有 */
export type AuditImage = { id: string; issues: string[]; where?: Where; role?: Role; dropped?: boolean };
/** 一次 Gemini 文字检查的结果。images 也记着 x2 去掉的图 */
export type Audit = { key: string; textIssues: string[]; images: AuditImage[]; at: string };
/** 一条问题怎么样了：提示（给人看；文案的，写文案的 agent 先照着改，最多两次）、已去掉（x2 去掉的图）、不算问题（印在商品上的字）、保留的图（人说要用的） */
export type IssueStatus = "提示" | "已去掉" | "不算问题" | "保留的图";
/** 一条问题：编号从 1 起，先文案、后图，不算问题的、保留的图排在最后。name 是图的名字 */
export type AuditIssue = { n: number; kind: "文案" | "图"; text: string; image?: string; name?: string; role?: Role; where?: Where; status: IssueStatus };
/** x2 去掉的图：Pic 的 drop 以它开头（人删的图记在已删除的图里，不在这） */
export const AUDIT_DROP = "Gemini 文字检查：";

const PROMPT = (content: unknown) => `審核台灣 Shopee 零售商品的文案和圖片。全程使用繁體中文，逐字抄錄問題原文，不得把繁體原文先轉成簡體再指控它是簡體。
核對標題、詳情、規格及圖片中的行銷文字是否繁體、通順，適合台灣消費者理解。只列明確錯字、簡體字、矛盾或難懂的誤譯；不因個人文風偏好、資訊可更詳細而拒絕。
商品本體或包裝實物印刷文字保留原貌，在 printedTextNotes 說明；後加行銷文案必須繁體，数字、單位、品牌英文可保留。
逐張返回從0開始的 index、issues、printedTextNotes；另返回文案 textIssues。每個問題必須包含圖片或文案實際可見的原文，不得自行改寫原文。缺圖或無法識別明確報錯。
商品文案與規格：${JSON.stringify(content)}`;

const schema = (n: number) => ({
	type: "object",
	properties: {
		textIssues: { type: "array", items: { type: "string" } },
		images: { type: "array", minItems: n, maxItems: n, items: { type: "object", properties: { index: { type: "integer" }, issues: { type: "array", items: { type: "string" } }, printedTextNotes: { type: "array", items: { type: "string" } } }, required: ["index", "issues", "printedTextNotes"] } },
	},
	required: ["textIssues", "images"],
});

/** 挑出的字在哪：印在商品本体上（不算问题，图保留原貌）还是后加的文案。照 R_PROMPT 的样子，只答一个字母 */
export const WHERE_PROMPT = (issues: string[]) => `这是电商商品图。文字检查在这张图上挑出了这些字：${issues.join("；")}
这些字是印在商品本体上的，还是后加的文案？
p = 都印在商品本体上：印在实物表面、跟着实物的形状和材质走的字（地垫印花图案里的字、瓶身标签、包装印刷、表盘铭牌）
m = 有后加的文案：画在图上的标题、卖点、说明、参数，后加的圆圈、方框、色块里的标签、角标
只输出 p 或 m。`;

/** 问 Gemini 挑出的字在哪；答不出回 null（只提示） */
export async function textWhere(img: Image, issues: string[]): Promise<Where | null> {
	const t = (await gemini(WHERE_PROMPT(issues), [img])).replace(/[\s`'"“”‘’.,，。:：;；!！?？()（）[\]【】-]/g, "").toLowerCase();
	return /^p+$/.test(t) ? "印在商品上" : /^m+$/.test(t) ? "后加的文案" : null;
}

/** 要查的图：主图、详情图、规格图（去重） */
export const auditImages = (p: Product) => [...new Set([...p.images, ...p.detail.map((d) => d.id), ...Object.values(p.optionImages)])];

/** 规格名（层名、选项名）：检查看的、检查键里的 */
const specNames = (p: Product) => p.tiers.map((t) => ({ name: t.name, options: t.options.map((o) => o.name) }));

/** 这份内容的检查键：标题、描述、规格名、图一样，就不用再查 */
export function auditKey(p: Product): string {
	const specs = specNames(p).map((t) => [t.name, t.options]);
	return createHash("sha256").update(JSON.stringify({ v: AUDIT_VERSION, title: p.title, description: p.description, specs, images: auditImages(p) })).digest("hex");
}

/** 图在商品里是什么 */
export function roleOf(p: Product, id: string): Role {
	if (p.images[0] === id) return "封面";
	if (Object.values(p.optionImages).includes(id)) return "规格图";
	return p.images.includes(id) ? "主图" : "详情图";
}

/** x2 去不去掉挑出的一张图：后加的文案，详情图和不是封面的主图去掉（canDrop：去掉以后还能再查一轮）；
 * 封面、规格图少了会影响商品，保留的图、印在商品上的、没问出字在哪的都不去掉，只提示 */
export function shouldDrop(where: Where | null, role: Role, kept: boolean, canDrop: boolean): boolean {
	return !kept && canDrop && where === "后加的文案" && (role === "主图" || role === "详情图");
}

/** 查一份商品：image 取一张图加水印之前的那张（图片 id → 字节）；kept 是保留的图（不问、不去掉）；canDrop 是这一轮去掉了图还能再查 */
export async function textCheck(p: Product, opts: { image: (id: string) => Promise<Image>; kept?: Iterable<string>; canDrop?: boolean }): Promise<Audit> {
	const kept = new Set(opts.kept ?? []);
	const ids = auditImages(p);
	const content = { title: p.title, description: p.description, specs: specNames(p) };
	// 一批 4 张（没图也问一次文案）
	const batches = Array.from({ length: Math.max(1, Math.ceil(ids.length / 4)) }, (_, i) => ids.slice(i * 4, i * 4 + 4));
	const results = await Promise.all(batches.map(async (batch) => {
		const bytes = await Promise.all(batch.map((id) => opts.image(id)));
		const prompt = `${batch.length ? `本批恰有 ${batch.length} 张图片，必须逐一返回 index=[0..${batch.length - 1}]，即使相似也不能合并。\n` : ""}${PROMPT(content)}`;
		const r = await geminiJson<{ textIssues: string[]; images: { index: number; issues: string[] }[] }>(prompt, bytes, schema(batch.length));
		const got = new Set(r.images.map((x) => x.index));
		if (batch.some((_, j) => !got.has(j))) throw new Error("Gemini 文字检查漏了图：这一批要重查");
		const images = await Promise.all(r.images.filter((x) => x.issues.length && batch[x.index]).map(async (x): Promise<AuditImage> => {
			const id = batch[x.index]!;
			const role = roleOf(p, id), keep = kept.has(id);
			const where = keep ? null : await textWhere(bytes[x.index]!, x.issues);
			return { id, issues: uniqIssues(x.issues), ...(where ? { where } : {}), role, ...(shouldDrop(where, role, keep, opts.canDrop ?? false) ? { dropped: true } : {}) };
		}));
		return { textIssues: uniqIssues(r.textIssues), images };
	}));
	return { key: auditKey(p), textIssues: [...new Set(results.flatMap((r) => r.textIssues))], images: results.flatMap((r) => r.images), at: new Date().toISOString() };
}

/** 一张图的问题去掉重复的：Gemini 偶尔把同一句重复上百遍（一条里用「；」连着的也拆开比） */
export const uniqIssues = (issues: string[]) => [...new Set(issues.flatMap((s) => s.split("；")).map((s) => s.trim()).filter(Boolean))];

/** x2 去掉挑出的图：主图、详情图里这几张（图片 id）的 Pic 写上 drop */
export function dropAudited(pics: Pics, drops: AuditImage[]): Pics {
	const why = new Map(drops.map((x) => [x.id, `${AUDIT_DROP}${x.issues.join("；")}`]));
	const mark = (list: Pic[] = []) => list.map((p) => (p.imageId && why.has(p.imageId) && !p.drop ? { ...p, drop: why.get(p.imageId)! } : p));
	return { ...pics, main: mark(pics.main), detail: mark(pics.detail) };
}

/** 人要用 x2 去掉的图：放回来 */
export function restoreAudited(pics: Pics, ids: Iterable<string>): Pics {
	const back = new Set(ids);
	const clear = (list: Pic[] = []) => list.map((p) => {
		if (!p.imageId || !back.has(p.imageId) || !p.drop?.startsWith(AUDIT_DROP)) return p;
		const { drop: _, ...rest } = p;
		return rest;
	});
	return { ...pics, main: clear(pics.main), detail: clear(pics.detail) };
}

/** 商品稿上 x2 去掉的图，一张一条（记进检查结果，人看得到，要用可以保留） */
export function auditDropped(pics: Pics): AuditImage[] {
	const out = new Map<string, AuditImage>();
	for (const [list, role] of [[pics.main ?? [], "主图"], [pics.detail ?? [], "详情图"]] as const) for (const p of list) {
		if (p.imageId && p.drop?.startsWith(AUDIT_DROP) && !out.has(p.imageId)) out.set(p.imageId, { id: p.imageId, issues: uniqIssues([p.drop.slice(AUDIT_DROP.length)]), where: "后加的文案", role, dropped: true });
	}
	return [...out.values()];
}

/** 要人看的：提示、x2 去掉的图（不算问题的、保留的图不用再看） */
const shown = (s: IssueStatus) => s === "提示" || s === "已去掉";

/** 检查结果 → 编号的问题。kept：保留的图（图片 id）；names：图的名字（imageNames） */
export function auditIssues(a: Partial<Audit>, kept: Iterable<string> = [], names: Map<string, string> = new Map()): AuditIssue[] {
	const keep = new Set(kept);
	const statusOf = (x: AuditImage): IssueStatus => (x.dropped ? "已去掉" : keep.has(x.id) ? "保留的图" : x.where === "印在商品上" ? "不算问题" : "提示");
	const images = (a.images ?? []).map((x) => ({ x, status: statusOf(x) }));
	const ordered = [...images.filter((i) => shown(i.status)), ...images.filter((i) => !shown(i.status))];
	const text = (a.textIssues ?? []).map((t, i): AuditIssue => ({ n: i + 1, kind: "文案", text: t, status: "提示" }));
	return [...text, ...ordered.map(({ x, status }, i): AuditIssue => {
		const name = names.get(x.id);
		return { n: text.length + i + 1, kind: "图", text: uniqIssues(x.issues).join("；"), image: x.id, ...(name ? { name } : {}), ...(x.role ? { role: x.role } : {}), ...(x.where ? { where: x.where } : {}), status };
	})];
}

const SUFFIX: Record<IssueStatus, string> = { 提示: "", 已去掉: "（x2 已去掉）", 不算问题: "（印在商品上，不算问题）", 保留的图: "（保留的图）" };

/** 一条问题写成一行：编号、文案或图的名字（不写图片 id）、问题原文、怎么样了 */
export const issueLine = (x: AuditIssue) => `${x.n}. ${x.kind === "文案" ? "文案" : x.name ?? x.role ?? "图"}：${x.text}${SUFFIX[x.status]}`;

/** 商品稿的「说明」：要人看的问题，带编号；没有回 null */
export function auditNotes(issues: AuditIssue[]): string | null {
	const list = issues.filter((x) => shown(x.status));
	if (!list.length) return null;
	const back = list.some((x) => x.status === "已去掉") ? ["x2 去掉的图要用，告诉 agent"] : [];
	return [`Gemini 文字检查挑出 ${list.length} 条：`, ...list.map(issueLine), ...back].join("\n");
}
