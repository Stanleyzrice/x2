// Gemini 文字检查的结果（纯函数）：检查键、图在商品里是什么、x2 去不去掉挑出的图、问题怎么编号写进说明。问 Gemini 的在 textcheck.ts。
// 只提示、不挡：挑出的问题带编号写进商品稿的「说明」，人审稿时看。印在商品上的不算问题；后加的文案，详情图和不是封面的主图 x2 去掉、重组商品再查，
// 封面、规格图少了会影响商品，只提示；保留的图（人说要用的）不问、不去掉
import { createHash } from "node:crypto";
import type { Pic, Pics } from "./pics.ts";
import type { Product } from "./product.ts";

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

/** 要查的图：主图、详情图、规格图（去重） */
export const auditImages = (p: Product) => [...new Set([...p.images, ...p.detail.map((d) => d.id), ...Object.values(p.optionImages)])];

/** 规格名（层名、选项名）：检查看的、检查键里的 */
export const specNames = (p: Product) => p.tiers.map((t) => ({ name: t.name, options: t.options.map((o) => o.name) }));

/** 这份内容的检查键：标题、描述、规格名、图一样，就不用再查 */
export function auditKey(p: Product): string {
	const specs = specNames(p).map((t) => [t.name, t.options]);
	return createHash("sha256")
		.update(JSON.stringify({ v: AUDIT_VERSION, title: p.title, description: p.description, specs, images: auditImages(p) }))
		.digest("hex");
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

/** 一张图的问题去掉重复的：Gemini 偶尔把同一句重复上百遍（一条里用「；」连着的也拆开比） */
export const uniqIssues = (issues: string[]) => [
	...new Set(
		issues
			.flatMap((s) => s.split("；"))
			.map((s) => s.trim())
			.filter(Boolean),
	),
];

/** x2 去掉挑出的图：主图、详情图里这几张（图片 id）的 Pic 写上 drop */
export function dropAudited(pics: Pics, drops: AuditImage[]): Pics {
	const why = new Map(drops.map((x) => [x.id, `${AUDIT_DROP}${x.issues.join("；")}`]));
	const mark = (list: Pic[] = []) => list.map((p) => (p.imageId && why.has(p.imageId) && !p.drop ? { ...p, drop: why.get(p.imageId)! } : p));
	return { ...pics, main: mark(pics.main), detail: mark(pics.detail) };
}

/** 人要用 x2 去掉的图：放回来 */
export function restoreAudited(pics: Pics, ids: Iterable<string>): Pics {
	const back = new Set(ids);
	const clear = (list: Pic[] = []) =>
		list.map((p) => {
			if (!p.imageId || !back.has(p.imageId) || !p.drop?.startsWith(AUDIT_DROP)) return p;
			const { drop: _, ...rest } = p;
			return rest;
		});
	return { ...pics, main: clear(pics.main), detail: clear(pics.detail) };
}

/** 商品稿上 x2 去掉的图，一张一条（记进检查结果，人看得到，要用可以保留） */
export function auditDropped(pics: Pics): AuditImage[] {
	const out = new Map<string, AuditImage>();
	for (const [list, role] of [
		[pics.main ?? [], "主图"],
		[pics.detail ?? [], "详情图"],
	] as const)
		for (const p of list) {
			if (p.imageId && p.drop?.startsWith(AUDIT_DROP) && !out.has(p.imageId))
				out.set(p.imageId, { id: p.imageId, issues: uniqIssues([p.drop.slice(AUDIT_DROP.length)]), where: "后加的文案", role, dropped: true });
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
	return [
		...text,
		...ordered.map(({ x, status }, i): AuditIssue => {
			const name = names.get(x.id);
			return {
				n: text.length + i + 1,
				kind: "图",
				text: uniqIssues(x.issues).join("；"),
				image: x.id,
				...(name ? { name } : {}),
				...(x.role ? { role: x.role } : {}),
				...(x.where ? { where: x.where } : {}),
				status,
			};
		}),
	];
}

const SUFFIX: Record<IssueStatus, string> = { 提示: "", 已去掉: "（x2 已去掉）", 不算问题: "（印在商品上，不算问题）", 保留的图: "（保留的图）" };

/** 一条问题写成一行：编号、文案或图的名字（不写图片 id）、问题原文、怎么样了 */
export const issueLine = (x: AuditIssue) => `${x.n}. ${x.kind === "文案" ? "文案" : (x.name ?? x.role ?? "图")}：${x.text}${SUFFIX[x.status]}`;

/** 商品稿的「说明」：要人看的问题，带编号；没有回 null */
export function auditNotes(issues: AuditIssue[]): string | null {
	const list = issues.filter((x) => shown(x.status));
	if (!list.length) return null;
	const back = list.some((x) => x.status === "已去掉") ? ["x2 去掉的图要用，告诉 agent"] : [];
	return [`Gemini 文字检查挑出 ${list.length} 条：`, ...list.map(issueLine), ...back].join("\n");
}
