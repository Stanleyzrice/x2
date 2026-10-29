// Gemini 文字检查（问 Gemini）：建商品前 Gemini 看商品稿的文案（标题、描述、规格名）和加水印之前的图（一次 4 张；译过的看译图，没译的看原图：水印会挡住字），
// 挑简体字、错字、误译（台湾买家不喜欢简体字）。只提示、不挡：挑出的问题带编号写进商品稿的「说明」，人审稿时看。
// 提示照 lilto 的 listing_content.audit_taiwan（快照 1c8a7926，第 2 版）：逐字抄问题原文，不把繁体先转简体再指控它是简体；实物上印的字保留原貌。
// 每张图都要按 index 回结果，漏了就报错。几批同时问，挑出的图再问字在哪也同时问（同时问几个由 queue.ts 的上限管）。按内容的哈希缓存（记在商品稿的 audit 里）。
// 挑出的图再问一次挑出的字在哪：印在商品上的不算问题；后加的文案，详情图和不是封面的主图 x2 去掉、重组商品再查，
// 封面、规格图少了会影响商品，只提示；保留的图（人说要用的）不问、不去掉

import type { Image } from "../../connectors/services/gemini/api.ts";
import { type Audit, type AuditImage, auditImages, auditKey, roleOf, shouldDrop, specNames, uniqIssues, type Where } from "./audit.ts";
import type { Product } from "./product.ts";
import { gemini, geminiJson } from "./queue.ts";

const PROMPT = (content: unknown) => `審核台灣 Shopee 零售商品的文案和圖片。全程使用繁體中文，逐字抄錄問題原文，不得把繁體原文先轉成簡體再指控它是簡體。
核對標題、詳情、規格及圖片中的行銷文字是否繁體、通順，適合台灣消費者理解。只列明確錯字、簡體字、矛盾或難懂的誤譯；不因個人文風偏好、資訊可更詳細而拒絕。
商品本體或包裝實物印刷文字保留原貌，在 printedTextNotes 說明；後加行銷文案必須繁體，数字、單位、品牌英文可保留。
逐張返回從0開始的 index、issues、printedTextNotes；另返回文案 textIssues。每個問題必須包含圖片或文案實際可見的原文，不得自行改寫原文。缺圖或無法識別明確報錯。
商品文案與規格：${JSON.stringify(content)}`;

const schema = (n: number) => ({
	type: "object",
	properties: {
		textIssues: { type: "array", items: { type: "string" } },
		images: {
			type: "array",
			minItems: n,
			maxItems: n,
			items: {
				type: "object",
				properties: {
					index: { type: "integer" },
					issues: { type: "array", items: { type: "string" } },
					printedTextNotes: { type: "array", items: { type: "string" } },
				},
				required: ["index", "issues", "printedTextNotes"],
			},
		},
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

/** 查一份商品：image 取一张图加水印之前的那张（图片 id → 字节）；kept 是保留的图（不问、不去掉）；canDrop 是这一轮去掉了图还能再查 */
export async function textCheck(p: Product, opts: { image: (id: string) => Promise<Image>; kept?: Iterable<string>; canDrop?: boolean }): Promise<Audit> {
	const kept = new Set(opts.kept ?? []);
	const ids = auditImages(p);
	const content = { title: p.title, description: p.description, specs: specNames(p) };
	// 一批 4 张（没图也问一次文案）
	const batches = Array.from({ length: Math.max(1, Math.ceil(ids.length / 4)) }, (_, i) => ids.slice(i * 4, i * 4 + 4));
	const results = await Promise.all(
		batches.map(async (batch) => {
			const bytes = await Promise.all(batch.map((id) => opts.image(id)));
			const prompt = `${batch.length ? `本批恰有 ${batch.length} 张图片，必须逐一返回 index=[0..${batch.length - 1}]，即使相似也不能合并。\n` : ""}${PROMPT(content)}`;
			const r = await geminiJson<{ textIssues: string[]; images: { index: number; issues: string[] }[] }>(prompt, bytes, schema(batch.length));
			const got = new Set(r.images.map((x) => x.index));
			if (batch.some((_, j) => !got.has(j))) throw new Error("Gemini 文字检查漏了图：这一批要重查");
			const images = await Promise.all(
				r.images
					.filter((x) => x.issues.length && batch[x.index])
					.map(async (x): Promise<AuditImage> => {
						const id = batch[x.index]!;
						const role = roleOf(p, id),
							keep = kept.has(id);
						const where = keep ? null : await textWhere(bytes[x.index]!, x.issues);
						return {
							id,
							issues: uniqIssues(x.issues),
							...(where ? { where } : {}),
							role,
							...(shouldDrop(where, role, keep, opts.canDrop ?? false) ? { dropped: true } : {}),
						};
					}),
			);
			return { textIssues: uniqIssues(r.textIssues), images };
		}),
	);
	return {
		key: auditKey(p),
		textIssues: [...new Set(results.flatMap((r) => r.textIssues))],
		images: results.flatMap((r) => r.images),
		at: new Date().toISOString(),
	};
}
