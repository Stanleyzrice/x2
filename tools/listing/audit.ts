// Gemini 文字检查的结果（纯函数）：检查键、图在商品里是什么、x2 去不去掉挑出的图、问题怎么编号写进说明。问 Gemini 的在 textcheck.ts。
// 只提示、不挡：挑出的问题带编号写进商品稿的「说明」，人审稿时看。印在商品上的不算问题；后加的文案，详情图和不是封面的主图 x2 去掉、重组商品再查，
// 封面、规格图少了会影响商品，只提示；保留的图（人说要用的）不问、不去掉
import { createHash } from "node:crypto";
import type { Pic, Pics } from "./pics.ts";
import type { Product } from "./product.ts";

export const AUDIT_VERSION = 4;
export type Where = "印在商品上" | "后加的文案";
export type Role = "封面" | "规格图" | "主图" | "详情图" | "尺码图";
export type AuditImage = { id: string; issues: string[]; where?: Where; role?: Role; dropped?: boolean };
export type AuditProvider = "gemini" | "codex-visual" | "human";
export type Audit = {
	key: string;
	textIssues: string[];
	images: AuditImage[];
	at: string;
	provider?: AuditProvider;
	evidence?: string;
	reviewedImageIds?: string[];
};
export type IssueStatus = "提示" | "已去掉" | "不算问题" | "保留的图";
export type AuditIssue = { n: number; kind: "文案" | "图"; text: string; image?: string; name?: string; role?: Role; where?: Where; status: IssueStatus };
export const AUDIT_DROP = "Gemini 文字检查：";

export const auditImages = (p: Product) => [...new Set([...p.images, ...p.detail.map((d) => d.id), ...Object.values(p.optionImages)])];
/** 显式视觉审阅还须看最终尺码图；旧 Gemini 取图流程保持原有图片范围。 */
export const reviewImages = (p: Product) => [...new Set([...auditImages(p), ...(p.sizeChart ? [p.sizeChart] : [])])];

export const specNames = (p: Product) => p.tiers.map((t) => ({ name: t.name, options: t.options.map((o) => o.name) }));

export function auditKey(p: Product): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				v: AUDIT_VERSION,
				title: p.title,
				description: p.description,
				specs: p.tiers,
				sourceSkus: p.variants.map((v) => ({ skuId: v.skuId, specId: v.specId, options: v.options })),
				images: { main: p.images, detail: p.detail, options: Object.entries(p.optionImages).sort(([a], [b]) => a.localeCompare(b)) },
				sizeChart: p.sizeChart,
			}),
		)
		.digest("hex");
}

/** 人工结果须有证据及完整逐图覆盖，不能仅填一个匹配 key 冒充审阅。 */
export function reviewedAuditCurrent(a: Partial<Audit> | null | undefined, p: Product): a is Audit {
	if (!a || (a.provider !== "codex-visual" && a.provider !== "human") || a.key !== auditKey(p)) return false;
	if (!a.evidence?.trim() || !a.at || !Array.isArray(a.textIssues) || !Array.isArray(a.images) || !Array.isArray(a.reviewedImageIds)) return false;
	const expected = reviewImages(p),
		seen = new Set(a.reviewedImageIds),
		results = new Set(a.images.map((x) => x.id));
	return (
		seen.size === a.reviewedImageIds.length &&
		seen.size === expected.length &&
		results.size === a.images.length &&
		results.size === expected.length &&
		expected.every((id) => seen.has(id) && results.has(id))
	);
}

/** 既有 Gemini 结果按当前指纹复用；显式人工结果另验来源与覆盖。 */
export function auditCurrent(a: Partial<Audit> | null | undefined, p: Product): boolean {
	if (!a || a.key !== auditKey(p)) return false;
	if (a.provider === "codex-visual" || a.provider === "human") return reviewedAuditCurrent(a, p);
	return a.provider === undefined || a.provider === "gemini";
}

export const auditProviderName = (provider?: AuditProvider) =>
	provider === "codex-visual" ? "Codex 视觉审阅" : provider === "human" ? "人工审阅" : "Gemini 文字检查";

export function roleOf(p: Product, id: string): Role {
	if (p.images[0] === id) return "封面";
	if (Object.values(p.optionImages).includes(id)) return "规格图";
	if (p.sizeChart === id) return "尺码图";
	return p.images.includes(id) ? "主图" : "详情图";
}

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

export function dropAudited(pics: Partial<Pics>, drops: AuditImage[]): Partial<Pics> {
	const why = new Map(drops.map((x) => [x.id, `${AUDIT_DROP}${x.issues.join("；")}`]));
	const mark = (list: Pic[] = []) => list.map((p) => (p.imageId && why.has(p.imageId) && !p.drop ? { ...p, drop: why.get(p.imageId)! } : p));
	return { ...pics, main: mark(pics.main), detail: mark(pics.detail) };
}

export function restoreAudited(pics: Partial<Pics>, ids: Iterable<string>): Partial<Pics> {
	const back = new Set(ids);
	const clear = (list: Pic[] = []) =>
		list.map((p) => {
			if (!p.imageId || !back.has(p.imageId) || !p.drop?.startsWith(AUDIT_DROP)) return p;
			const { drop: _, ...rest } = p;
			return rest;
		});
	return { ...pics, main: clear(pics.main), detail: clear(pics.detail) };
}

export function auditDropped(pics: Partial<Pics>): AuditImage[] {
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

const shown = (s: IssueStatus) => s === "提示" || s === "已去掉";

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

export const issueLine = (x: AuditIssue) => `${x.n}. ${x.kind === "文案" ? "文案" : (x.name ?? x.role ?? "图")}：${x.text}${SUFFIX[x.status]}`;

export function auditNotes(issues: AuditIssue[], provider?: AuditProvider): string | null {
	const list = issues.filter((x) => shown(x.status));
	if (!list.length) return null;
	const back = list.some((x) => x.status === "已去掉") ? ["x2 去掉的图要用，告诉 agent"] : [];
	return [`${auditProviderName(provider)}挑出 ${list.length} 条：`, ...list.map(issueLine), ...back].join("\n");
}
