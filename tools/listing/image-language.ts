// 上传收据只解析文件身份，语言结论单独保存。
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import type { ProductInfo } from "../../connectors/sites/shopee/products.ts";
import { IMAGE } from "../../connectors/sites/shopee/seller.ts";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { original } from "./images.ts";
import { toTw } from "./variants.ts";

export const IMAGE_LANGUAGE_RULE_VERSION = 1;
export const imageSha256 = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z.string().trim().min(1);
const verdictFields = { sha256: imageSha256, evidence };
export const imageLanguageVerdict = z.discriminatedUnion("state", [
	z.object({ ...verdictFields, state: z.enum(["no-chinese", "traditional", "pending-check", "needs-correction"]) }),
	z.object({
		...verdictFields,
		state: z.literal("printed-with-note"),
		note: evidence.refine((s) => /\p{Script=Han}/u.test(s) && toTw(s) === s, "實物印字說明須使用台灣繁體"),
	}),
]);
export type ImageLanguageVerdict = z.output<typeof imageLanguageVerdict>;
type Database = Sql | postgres.TransactionSql;
const reviewer = z.enum(["human", "codex-visual", "deepseek-visual"]);
type Reviewer = z.output<typeof reviewer>;
const storedVerdict = z.object({ language: imageLanguageVerdict, provider: reviewer });

export type FinalImageProduct = Pick<ProductInfo, "images" | "description_info" | "size_chart_info" | "std_tier_variation_list"> & {
	model_list?: Pick<NonNullable<ProductInfo["model_list"]>[number], "sku" | "tier_index" | "sku_image">[] | null;
	long_images?: unknown;
	gallery_image_list?: unknown;
	tier_variation?: unknown;
};
type VariantImageUpdate = {
	std_tier_variation_list: FinalImageProduct["std_tier_variation_list"];
	model_list: (NonNullable<FinalImageProduct["model_list"]>[number] & { id: string | number })[];
	description_info?: FinalImageProduct["description_info"];
};
type Attachment = { slot: string; id: string; scope: string[] };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function imageId(value: unknown, slot: string): string {
	if (typeof value === "string") {
		const id = /^https:\/\//i.test(value) ? value.match(/^https:\/\/down-tw\.img\.susercontent\.com\/file\/([\w-]+)(?:\?.*)?$/i)?.[1] : value;
		if (id && /^[\w-]+$/.test(id)) return id;
	}
	throw new Usage(`${slot}的图片编号无法识别`);
}

const descriptionFields = z.object({ field_list: z.array(z.object({ type: z.number(), value: z.unknown() })) });
const legacyTiers = z.array(z.object({ name: z.string().nullish(), options: z.array(z.string()).nullish(), images: z.array(z.unknown()).nullish() }));

function finalImages(product: FinalImageProduct) {
	if (!product.images?.length) throw new Usage("未读取到最终主图");
	const legacy = legacyTiers.safeParse(product.tier_variation ?? []);
	if (!legacy.success) throw new Usage("旧版规格的图片列表无法识别");
	const tiers = product.std_tier_variation_list?.length
		? product.std_tier_variation_list
		: legacy.data.map((tier) => ({ custom_value: tier.name, value_list: tier.options?.map((name) => ({ custom_value: name, image_id: null })) }));
	if (!product.model_list?.length) throw new Usage("未读取到最终商品规格");
	const models = product.model_list.map((model) => {
		const indices = model.tier_index?.map(Number) ?? [];
		const specs = tiers.flatMap((tier, i) => {
			const name = tier.custom_value?.trim() ?? "";
			const option = tier.value_list?.[indices[i]!];
			if (!option && (name || tier.value_list?.some((option) => option.custom_value))) throw new Usage(`规格「${name || i + 1}」的选项对应无法识别`);
			const value = option?.custom_value?.trim() ?? "";
			return name || value ? [[name, value]] : [];
		});
		const sku = model.sku ?? "";
		return { indices, sku, key: JSON.stringify([sku, specs.sort((a, b) => a[0]!.localeCompare(b[0]!) || a[1]!.localeCompare(b[1]!))]), image: model.sku_image };
	});
	const wholeProduct = models.map((m) => m.key);
	const attachments: Attachment[] = [];
	const add = (slot: string, value: unknown, scope = wholeProduct) => attachments.push({ slot, id: imageId(value, slot), scope });
	for (const [i, value] of product.images.entries()) add(`主图 ${i + 1}`, value);
	for (const [name, values] of [
		["长图", product.long_images],
		["图册", product.gallery_image_list],
	] as const) {
		if (values == null) continue;
		if (!Array.isArray(values)) throw new Usage(`${name}的图片列表无法识别`);
		for (const [i, value] of values.entries()) add(`${name} ${i + 1}`, value);
	}
	const description = product.description_info?.description ?? "";
	const text: string[] = [];
	switch (product.description_info?.description_type) {
		case "json": {
			let parsed: z.output<typeof descriptionFields>;
			try {
				parsed = descriptionFields.parse(JSON.parse(description));
			} catch {
				throw new Usage("详情图所在的图文描述无法解析");
			}
			for (const [i, field] of parsed.field_list.entries()) {
				if (field.type === 1) add(`详情图（图文第 ${i + 1} 段）`, field.value);
				else if (field.type === 0 && typeof field.value === "string") text.push(field.value);
				else throw new Usage(`详情第 ${i + 1} 段的图文类型无法识别`);
			}
			break;
		}
		case "normal":
			text.push(description);
			break;
		default:
			if (description) throw new Usage("详情描述格式未知，无法确认最终详情图");
	}
	const optionScope = (i: number, j: number) => {
		const keys = models.filter((m) => m.indices[i] === j).map((m) => m.key);
		const tier = tiers[i];
		return keys.length ? keys : [JSON.stringify(["option", tier?.custom_value ?? "", tier?.value_list?.[j]?.custom_value ?? ""])];
	};
	for (const [i, tier] of tiers.entries()) {
		for (const [j, option] of (tier.value_list ?? []).entries()) {
			if (option.image_id) add(`规格图 ${i + 1}.${j + 1}「${option.custom_value ?? ""}」`, option.image_id, optionScope(i, j));
		}
	}
	for (const [i, tier] of legacy.data.entries()) {
		for (const [j, image] of (tier.images ?? []).entries()) {
			if (image) add(`规格图 ${i + 1}.${j + 1}`, image, optionScope(i, j));
		}
	}
	for (const model of models) if (model.image) add(`SKU（规格货号）图 ${model.sku}`, model.image, [model.key]);
	const chart = product.size_chart_info?.size_chart;
	if (chart != null && chart !== "") add("尺码图", chart);
	return { attachments, text };
}

/** 规格操作只发送部分 model 字段；从现读保留未修改的货号与 SKU 图。 */
export function variantImageTarget(now: ProductInfo, update: VariantImageUpdate): FinalImageProduct {
	const previous = new Map(now.model_list?.map((model) => [String(model.id), model]));
	return {
		...now,
		...update,
		tier_variation: undefined, // 旧字段是规格表的投影；提交使用新规格表。
		model_list: update.model_list.map((model) => ({ ...previous.get(String(model.id)), ...model })),
	};
}

const proofKey = (sha: string, scope: string) => `${sha}:${scope}`;
const stateLabel = { "pending-check": "待检查", "needs-correction": "待修正" };

export async function rememberExistingImageFiles(sql: Sql, shop: string, current: ProductInfo, snapshot: LanguageSnapshot): Promise<boolean> {
	const untracked = snapshot.images.filter((image) => !image.sha256);
	if (!untracked.length) return false;
	const currentIds = new Set(finalImages(current).attachments.map(({ id }) => id));
	const files = await Promise.all(
		untracked
			.filter((image) => currentIds.has(image.id))
			.map(async (image) => {
				const { sha256 } = await original(sql, image.url);
				return { shop, image_id: image.id, sha256 };
			}),
	);
	if (!files.length) return false;
	await sql`insert into listing_image_file_bindings ${sql(files)} on conflict (shop, image_id) do nothing`;
	return true;
}

export async function imageLanguageSnapshot(sql: Database, shop: string, product: FinalImageProduct) {
	const { attachments, text } = finalImages(product);
	const grouped = Map.groupBy(attachments, (a) => a.id);
	const ids = [...grouped.keys()];
	const uploads = await sql<{ image_id: string; sha256: string }[]>`
		select b.image_id, b.sha256 from listing_image_file_bindings b where b.shop = ${shop} and b.image_id in ${sql(ids)}
		union all
		select s.image_id, s.sha256 from shop_images s join images i on i.sha256 = s.sha256
		where s.shop = ${shop} and s.image_id in ${sql(ids)}
		and not exists (select 1 from listing_image_file_bindings b where b.shop = s.shop and b.image_id = s.image_id)`;
	const byId = Map.groupBy(uploads, (u) => u.image_id);
	const shas = [...new Set(uploads.map((u) => u.sha256))];
	const proofs = shas.length
		? await sql<{ sha256: string; scope: string; verdict: unknown }[]>`
			select sha256, scope, verdict from listing_image_language_reviews
			where shop = ${shop} and rule_version = ${IMAGE_LANGUAGE_RULE_VERSION} and sha256 in ${sql(shas)}`
		: [];
	const byProof = new Map(proofs.map((proof) => [proofKey(proof.sha256, proof.scope), proof.verdict]));
	const images = [...grouped].map(([id, uses]) => {
		const fingerprints = byId.get(id) ?? [];
		const sha256 = fingerprints.length === 1 && imageSha256.safeParse(fingerprints[0]?.sha256).success ? fingerprints[0]!.sha256 : null;
		const scope = digest([...new Set(uses.flatMap((use) => use.scope))].sort());
		const parsed = sha256 ? storedVerdict.safeParse(byProof.get(proofKey(sha256, scope))) : undefined;
		const language = parsed?.success && parsed.data.language.sha256 === sha256 ? parsed.data.language : null;
		const assessment = assessLanguage(language, text);
		const problem = sha256 ? assessment.problem : "图片缺少已核实的上传文件指纹";
		return { id, url: IMAGE + id, slots: [...new Set(uses.map((use) => use.slot))], sha256, scope, language, state: assessment.state, problem };
	});
	return { images, text, ruleVersion: IMAGE_LANGUAGE_RULE_VERSION };
}
export type LanguageSnapshot = Awaited<ReturnType<typeof imageLanguageSnapshot>>;

function assessLanguage(language: ImageLanguageVerdict | null, text: string[]): { state: ImageLanguageVerdict["state"]; problem: string | null } {
	if (!language) return { state: "pending-check", problem: "待检查（缺少当前文件、适用规格及规则版本的语言结论）" };
	const { state } = language;
	if (state === "pending-check" || state === "needs-correction") return { state, problem: `${stateLabel[state]}（${language.evidence}）` };
	if (language.state === "printed-with-note" && !text.some((paragraph) => paragraph.includes(language.note)))
		return { state: "needs-correction", problem: "待修正（最终商品描述缺少对应的繁体印字说明）" };
	return { state, problem: null };
}

export const imageLanguageReviewKey = ({ images, text, ruleVersion }: LanguageSnapshot) =>
	digest([ruleVersion, images.map(({ id, slots, sha256, scope }) => [id, slots, sha256, scope]), text]);

export async function saveImageLanguageReviews(
	sql: Database,
	shop: string,
	snapshot: LanguageSnapshot,
	provider: Reviewer,
	results: { id: string; language?: ImageLanguageVerdict }[],
) {
	const images = new Map(snapshot.images.map((image) => [image.id, image]));
	const pending = new Map<string, { sha256: string; scope: string; language: ImageLanguageVerdict }>();
	for (const result of results) {
		const image = images.get(result.id);
		if (!image) throw new Usage(`审阅结果包含非最终图片 ${result.id}`);
		if (!result.language) continue;
		const { language } = result;
		if (language.sha256 !== image.sha256) throw new Usage(`图片 ${image.id} 的文件指纹已变或未知，请重新 review-preview`);
		if (language.state === "printed-with-note" && !snapshot.text.some((paragraph) => paragraph.includes(language.note)))
			throw new Usage(`图片 ${image.id} 的繁体印字说明须出现在最终商品描述`);
		const key = proofKey(language.sha256, image.scope);
		const previous = pending.get(key);
		if (previous && JSON.stringify(previous.language) !== JSON.stringify(language)) throw new Usage(`同一文件与适用规格提交了不同的语言结论：${image.id}`);
		pending.set(key, { sha256: language.sha256, scope: image.scope, language });
	}
	for (const { sha256, scope, language } of pending.values()) {
		await sql`insert into listing_image_language_reviews (shop, sha256, scope, rule_version, verdict)
			values (${shop}, ${sha256}, ${scope}, ${IMAGE_LANGUAGE_RULE_VERSION}, ${sql.json({ language, provider })})
			on conflict (shop, sha256, scope, rule_version) do update set verdict = excluded.verdict, reviewed_at = now()`;
	}
	return snapshot.images.map((image) => {
		const added = image.sha256 && pending.get(proofKey(image.sha256, image.scope));
		return added ? { ...image, language: added.language, ...assessLanguage(added.language, snapshot.text) } : image;
	});
}

/** 建品、上架及换图以同一已采用图片清单检查，批准原图或空 issues 都不改变这里的结果。 */
export async function imageLanguageBlock(sql: Database, shop: string, item: string, product: FinalImageProduct): Promise<string | null> {
	try {
		const { images } = await imageLanguageSnapshot(sql, shop, product);
		const problems = images.flatMap((image) => (image.problem ? [`${image.slots.join("、")} ${image.id}：${image.problem}`] : []));
		return problems.length ? `${item} 图片语言审阅：${problems.join("；")}` : null;
	} catch (error) {
		if (!(error instanceof Usage)) throw error;
		return `${item} 图片语言审阅：${error.message}`;
	}
}
