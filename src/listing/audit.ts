// 台湾成品审核：建商品前 Gemini 看成品图（一次 4 张）和标题、描述、规格，挑简体字、错字、误译（台湾买家不喜欢简体字）。
// 提示照 lilto 的 listing_content.audit_taiwan（快照 1c8a7926，第 2 版）：逐字抄问题原文，不把繁体先转简体再指控它是简体；
// 实物上印的字保留原貌；本店水印已核准。每张图都要按 index 回结果，漏了就报错；挑出任何问题就挡下。按内容的哈希缓存（记在商品稿的 audit 里）
import { createHash } from "node:crypto";
import { geminiJson } from "../service/gemini.ts";
import { fetchImage } from "../service/image.ts";
import { IMAGE } from "../site/shopee/seller.ts";
import type { Product } from "./product.ts";
import { tiersOf } from "./variants.ts";

export const AUDIT_VERSION = 2;
export type Audit = { key: string; ok: boolean; textIssues: string[]; images: { id: string; issues: string[] }[]; at: string };

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

/** 要审的图：主图、详情图、规格图（去重） */
export const auditImages = (p: Product) => [...new Set([...p.images, ...p.detail.map((d) => d.id), ...Object.values(p.optionImages)])];

/** 这份内容的审核键：标题、描述、规格名、图、水印一样，就不用再审 */
export function auditKey(p: Product, mark: string): string {
	const specs = tiersOf(p.variants).tiers.map((t) => [t.name, t.options.map((o) => o.name)]);
	return createHash("sha256").update(JSON.stringify({ v: AUDIT_VERSION, title: p.title, description: p.description, specs, images: auditImages(p), mark })).digest("hex");
}

export async function auditTaiwan(p: Product, mark: string): Promise<Audit> {
	const ids = auditImages(p);
	const content = { title: p.title, description: p.description, specs: tiersOf(p.variants).tiers.map((t) => ({ name: t.name, options: t.options.map((o) => o.name) })) };
	const textIssues = new Set<string>();
	const images: { id: string; issues: string[] }[] = [];
	for (let i = 0; i < Math.max(ids.length, 1); i += 4) {
		const batch = ids.slice(i, i + 4);
		const bytes = await Promise.all(batch.map((id) => fetchImage(`${IMAGE}${id}`)));
		const prompt = `${batch.length ? `本批恰有 ${batch.length} 张图片，必须逐一返回 index=[0..${batch.length - 1}]，即使相似也不能合并。\n` : ""}${PROMPT(mark, content)}`;
		const r = await geminiJson<{ textIssues: string[]; images: { index: number; issues: string[] }[] }>(prompt, bytes, schema(batch.length));
		const got = new Set(r.images.map((x) => x.index));
		if (batch.some((_, j) => !got.has(j))) throw new Error("台湾成品审核漏了图：这一批要重审");
		for (const t of r.textIssues) textIssues.add(t);
		for (const x of r.images) if (x.issues.length && batch[x.index]) images.push({ id: batch[x.index]!, issues: x.issues });
	}
	return { key: auditKey(p, mark), ok: textIssues.size === 0 && images.length === 0, textIssues: [...textIssues], images, at: new Date().toISOString() };
}
