// 上品（x2 listing <工具>）：把 1688 的货源做成店里在售的商品。x2 status 问它的检查（只看库里的）；建商品、上架是写（publish：人说了批准才调）。
// 输出里商品稿都叫「简称（店铺，#编号）」（listingName）：编号是工具要用的
import { z } from "zod";
import { offerIdOf } from "../../connectors/sites/1688/api.ts";
import { type Category, categoryTree } from "../../connectors/sites/shopee/products.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import { db, type Json, type Sql } from "../../platform/db/index.ts";
import { NeedsHuman, Usage } from "../../platform/errors.ts";
import { flag, get, parseJson, str, strs, type Toolkit, write } from "../../platform/tool.ts";
import type { Ran } from "../../platform/writes.ts";
import { ADD_SIZE_WRITES, addSizeParams, planAddSize, previewAddSize } from "./add-size.ts";
import { AUDIT_DROP, type Audit, type AuditIssue, auditDropped, auditIssues, auditKey, dropAudited, issueLine, restoreAudited } from "./audit.ts";
import { CATEGORY_PROBLEM, leafPath } from "./category.ts";
import { listingChannelsParams, setListingChannels } from "./channels.ts";
import { copyDraft, copyImages, copyImagesParams, copyParams } from "./copy.ts";
import { EDIT_WRITES, editParams, planEdit, previewEdit } from "./edit.ts";
import { cancelBlock, categoryBlock, estimateFill, keepImages } from "./edits.ts";
import { EXPAND_WRITES, expandParams, planExpand, previewExpand } from "./expand.ts";
import { unmarked } from "./images.ts";
import { make, readOffer1688, savePrices } from "./make.ts";
import { orderPrice, orderPricingInput } from "./order-pricing.ts";
import { addListings, type PickSnapshot, pickSnapshot, snapshotLine } from "./pick.ts";
import type { Pics } from "./pics.ts";
import { estimateNeeds, pricingPolicy, pricingProblems, quote, settingsOf } from "./pricing.ts";
import { pricingInputsParams, setPricingInputs } from "./pricing-input.ts";
import { imageNames } from "./product.ts";
import { purchaseLimitParams, setPurchaseLimit } from "./purchase-limit.ts";
import { each } from "./queue.ts";
import { productOf } from "./ready.ts";
import { ListingId, type ListingRow, type ShopSettingsRow } from "./row.ts";
import { listingsCheck } from "./status.ts";
import { LISTING_TABLES } from "./tables.ts";
import { templateConfigParams, templateItem, templateParams, templatePrice } from "./template-pricing.ts";
import { listingName, nicknameOpen, nicknameProblems, textProblems } from "./text.ts";
import { textCheck } from "./textcheck.ts";
import { planUnlist, previewUnlist, UNLIST_WRITES, unlistParams } from "./unlist.ts";
import { dropSpecs, isSingle, OLD_SPECS, priceRange, removedOf, renameSpecs, specsOf, specsText, tierNames } from "./variants.ts";
import { LISTING_WRITES } from "./writes.ts";

async function namesOf(sql: Sql, ids: string[]): Promise<(id: string) => string> {
	const valid = [...new Set(ids.filter((id) => /^\d+$/.test(id)))];
	const rows = valid.length ? await sql`select id::text, shop, nickname, offer_id, offer->>'title' as title from listings where id in ${sql(valid)}` : [];
	const names = new Map(
		rows.map((r) => [r.id as string, listingName({ id: r.id, shop: r.shop, nickname: r.nickname, offer_id: r.offer_id, offer: { title: r.title } })]),
	);
	return (id) => names.get(id) ?? `商品稿 ${id}`;
}

const id = ListingId.describe("商品稿编号");
const ids = z
	.preprocess(
		(v) =>
			typeof v === "string"
				? v
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: v,
		z.array(ListingId).min(1),
	)
	.meta({ description: "商品稿编号，逗号分隔", placeholder: "1,2,…" });
const text = z.string().trim().min(1);

export async function publishPlan(sql: Sql, want: string[]) {
	const name = await namesOf(sql, want);
	const r = await listingsCheck(sql, want);
	const bad = want.flatMap((id) => {
		if (r.ready.some((x) => x.id === id)) return [];
		const step = r.steps.get(id);
		return [step ? `${name(id)}是「${step.step}」，不是待批准、待上架` : `没有商品稿 ${id}`];
	});
	if (bad.length) throw new Usage(`${bad.join("\n")}\n一份都没做`);
	return r.ready.filter((x) => want.includes(x.id)).map((l) => l.writes);
}

async function written(sql: Sql, ran: Ran[]): Promise<void> {
	const ids = [...new Set(ran.map((x) => x.id))];
	const rows = await sql`select params->>'listingId' as id from writes where id in ${sql(ids)} and op in ('建商品', '上架') and params ? 'listingId'`;
	if (rows.length) await listingsCheck(sql, [...new Set(rows.map((x) => x.id as string))]);
}

export const listing: Toolkit = {
	name: "listing",
	title: "上品：贴货源、做商品稿、写文案、建商品、上架、零销量下架",
	kind: "tool",
	tools: {
		copy: get("从已保存商品稿原子复制到另一店；已存在目标稿不覆盖，不沿用站点身份或图片上传记录", copyParams, async (p) => copyDraft(await db(), p)),
		"copy-images": get("仅按目标稿保存的原图URL上传到目标店，核对SHA和规格图对应，不重读1688或重建规格", copyImagesParams, async (p) =>
			copyImages(await db(), p),
		),
		"purchase-limit": get("保存单份未建商品稿的最低购买数量，不改全店设置或已建商品", purchaseLimitParams, async (p) => setPurchaseLimit(await db(), p)),
		channels: get("保存未建商品稿的显式物流渠道集合，不改全店或已建商品；空值旧稿沿用店铺配置", listingChannelsParams, async (p) =>
			setListingChannels(await db(), p),
		),
		"pricing-inputs": get("保存逐规格的显式进价、计费重量和售价，保留1688原始事实；核对当前毛利目标，不改已建商品", pricingInputsParams, async (p) =>
			setPricingInputs(await db(), p),
		),
		pricing: get("读取店铺已保存的计算模型与输入参数", z.object({ shop: str("店（ni1206、cheeroutdoor）") }), async (p) => {
			const sql = await db();
			const [row] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${p.shop}`;
			if (!row) throw new Usage(`没有「${p.shop}」这家店`);
			return { shop: row.shop, ...pricingPolicy(settingsOf(row)) };
		}),
		"pricing-set": get(
			"保存店铺百分比费用模型的完整计算输入",
			z.object({
				shop: str("店（ni1206、cheeroutdoor）"),
				template: z.preprocess(parseJson, templateConfigParams).describe("完整参数 JSON，六项数值均须提供"),
			}),
			async (p) => {
				const sql = await db();
				const [row] = await sql<
					ShopSettingsRow[]
				>`update shop_settings set pricing_template = ${sql.json(p.template)}, updated_at = now() where shop = ${p.shop} returning *`;
				if (!row) throw new Usage(`没有「${p.shop}」这家店`);
				return { shop: row.shop, ...pricingPolicy(settingsOf(row)) };
			},
		),
		"price-preview": get(
			"按定价模板试算毛利率区间：只给建议，不存库、不改设置或商品；缺成本不补零",
			z.object({
				...templateParams.shape,
				items: z.preprocess(parseJson, z.array(templateItem).min(1).max(1000)).describe("逐规格成本输入的 JSON，写 - 从 stdin 读"),
			}),
			async (p) => {
				const { items, ...params } = p;
				const assumptions = templateParams.parse(params);
				return { assumptions, rows: items.map((item) => templatePrice(item, assumptions)) };
			},
		),
		"order-preview": get(
			"计算输入组合的商品金额、成本、利润及区间比较结果",
			z.object({
				shop: str("店（ni1206、cheeroutdoor）"),
				items: z.preprocess(parseJson, orderPricingInput.shape.items).describe("逐规格的价格、件数、成本、重量 JSON；写 - 从 stdin 读"),
				freightRmb: z.coerce.number().nonnegative().nullable().default(null).describe("整单国内运费；多个货源合计，未知不填"),
				sellerDiscountTwd: z.coerce.number().nonnegative().nullable().default(null).describe("整单卖家承担的优惠；明确无优惠填 0，未知不填"),
				minimumTwd: z.coerce.number().nonnegative().default(0).describe("用于比较的商品金额下限，TWD"),
			}),
			async (p) => {
				const sql = await db();
				const [row] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${p.shop}`;
				if (!row) throw new Usage(`没有「${p.shop}」这家店`);
				const s = settingsOf(row);
				if (!s.template) throw new Usage("这家店尚未启用定价模板（x2 listing pricing）");
				return { shop: p.shop, pricing: pricingPolicy(s), ...orderPrice(p, s.template) };
			},
		),
		add: get(
			"添加货源：一个货源 × 一家店一份商品稿；记下选品理由、依据和选品快照（当时的策略、在用的选品规矩）。按策略选的（带 --strategy）--why 必填；几个链接一起加的理由是同一份",
			z
				.object({
					shop: str("店（ni1206、cheeroutdoor）"),
					links: strs("1688 链接或货源 id"),
					strategy: text.optional().describe("按哪个策略选的"),
					why: text.optional().describe("选品理由（按策略选的必填）"),
					evidence: text.optional().describe("依据"),
				})
				.refine((x) => !x.strategy || x.why, { message: "带 --strategy 时 --why 必填" }),
			async (p) => {
				const sql = await db();
				const { added } = await addListings(sql, p);
				const name = await namesOf(
					sql,
					added.map((a) => a.id),
				);
				return added.map((a) => ({ ...a, name: name(a.id) }));
			},
			{
				text: (added) => {
					const fresh = added.find((x) => x.isNew);
					return [
						...added.map((a) => `${a.name}${a.isNew ? "" : "：已经有了"}`),
						...(fresh?.snapshot ? [`选品快照：${snapshotLine(fresh.snapshot)}`] : []),
						...(added.some((x) => !x.isNew) ? ["已经有了的不改理由、快照：补记用 x2 listing why --id <商品稿> --why …"] : []),
						"下一步：x2 listing make",
					].join("\n");
				},
			},
		),
		why: get(
			"补记选品理由、依据：没有选品快照的照现在补一份（标明补记）；已有理由的要 --force 才覆盖",
			z.object({ id, why: text.describe("选品理由"), evidence: text.optional().describe("依据"), force: flag("覆盖已有的理由").default(false) }),
			async (p) => {
				const sql = await db();
				const [l] =
					await sql`select id::text, shop, nickname, offer_id, offer->>'title' as title, strategy, pick_why, pick_evidence, pick_snapshot from listings where id = ${p.id}`;
				if (!l) throw new Usage(`没有商品稿 ${p.id}`);
				const name = listingName({ ...l, offer: { title: l.title } });
				if (l.pick_why && !p.force) throw new Usage(`${name}已经有选品理由：${l.pick_why}\n要覆盖加 --force`);
				const snapshot: PickSnapshot = l.pick_snapshot ?? (await pickSnapshot(sql, l.strategy, true));
				const evidence = p.evidence ?? l.pick_evidence ?? null;
				await sql`update listings set pick_why = ${p.why}, pick_evidence = ${evidence}, pick_snapshot = ${sql.json(snapshot as Json)}, updated_at = now() where id = ${p.id}`;
				const notes = [
					l.pick_why ? `覆盖了原来的理由：${l.pick_why}` : "",
					l.pick_evidence && p.evidence ? `覆盖了原来的依据：${l.pick_evidence}` : "",
					l.pick_snapshot ? "选品快照是加进来时记的，不改" : "补记了选品快照（照现在的）",
				].filter(Boolean);
				return { id: p.id, name, why: p.why, evidence, snapshot, replaced: Boolean(l.pick_why), backfilled: !l.pick_snapshot, notes };
			},
			{ text: (r) => [`${r.name}：记下选品理由`, ...r.notes.map((x: string) => `  ${x}`), `  选品快照：${snapshotLine(r.snapshot)}`].join("\n") },
		),
		quote: get(
			"报价（选品用）：读货源、排规格、按店铺设置核价，和做商品稿同一套代码，不做图、不存库。1688 没给的重量按 --weight、读不到的国内运费按 --freight 算，都往重了、往高了估；用了估的写出来",
			z.object({
				link: str("1688 链接或货源 id"),
				shop: z.string().min(1).describe("计算参数所属店铺"),
				weight: z.coerce.number().positive().finite().describe("调用方提供的备用重量（kg）"),
				freight: z.coerce.number().nonnegative().finite().describe("调用方提供的备用国内运费（元/件）"),
			}),
			async (p) => {
				const offerId = offerIdOf(p.link);
				if (!offerId) throw new Usage(`认不出 1688 链接：${p.link}`);
				const sql = await db();
				const [row] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${p.shop}`;
				if (!row) throw new Usage(`没有「${p.shop}」这家店（店铺设置里有的：${(await sql`select shop from shop_settings`).map((r) => r.shop).join("、")}）`);
				return quote(await readOffer1688(offerId), settingsOf(row), { weightKg: p.weight, freightRmb: p.freight });
			},
			{
				text: (q) => {
					const freight = q.freightAssumed
						? `${q.freightRmb} 元/件（1688 读不到，按 --freight 估的）`
						: q.tags.freeShipping
							? "0（包邮）"
							: `${q.freightRmb} 元/件（1688 页面上寄到我们这里买 1 件）`;
					const tags =
						[q.tags.onePsale ? "一件代发" : "", q.tags.ship48h ? "48 小时发货" : q.tags.deliveryDays ? `${q.tags.deliveryDays} 天内发货` : ""]
							.filter(Boolean)
							.join("、") || "无";
					return [
						`${q.title}（${q.offerId}）`,
						q.pricing.model === "template"
							? `定价模板：毛利率 ${q.pricing.params.minMargin * 100}–${q.pricing.params.maxMargin * 100}%（按扣平台费后的收入；条件试算）`
							: `结算模型：最低毛利率 ${q.pricing.params.minMarginRate * 100}%，最低毛利 ${q.pricing.params.minMarginRmb} 元`,
						`${q.shop} 售价 ${q.priceTwd}（${q.variants} 个规格）`,
						...q.specs.split("\n").map((x: string) => `  ${x}`),
						`国内运费：${freight}`,
						`重量：${q.weightAssumed ? `${q.weightAssumed}（估的）` : "1688 都给了"}`,
						`服务：${tags}；起订量 ${q.minQty}`,
						...(q.problems.length ? [`问题：${q.problems.join("；")}`] : []),
					].join("\n");
				},
			},
		),
		make: get(
			"做商品稿：读货源、规格和核价、图（筛字、译图、译图检查、水印、传图）、类目属性；不给编号就做所有还没做好的。几份同时做：问 Gemini、交象寄、取图几份重叠，碰浏览器的按浏览器排队（queue.ts）",
			z
				.object({
					ids: ids.optional(),
					jobs: z.coerce.number().int().min(1).max(10).default(3).describe("几份同时做"),
					sourceSkuIds: z
						.preprocess(parseJson, z.array(z.string().min(1)).min(1))
						.optional()
						.describe("本次只做指定1688 skuId，JSON数组；仅限单稿，其他规格保存为排除"),
					mainImages: z.preprocess(parseJson, z.array(z.url()).min(1).max(12)).optional().describe("本次明确选择的主图URL，JSON数组；仅限单稿"),
					detailImages: z.preprocess(parseJson, z.array(z.url()).max(16)).optional().describe("本次明确选择的详情图URL，JSON数组，[]表示不用详情图；仅限单稿"),
					imageMode: z
						.enum(["processed", "original"])
						.optional()
						.describe("本稿图片模式：original上传1688原图，不译图不加水印；不传沿用稿件模式，旧稿保持处理图"),
				})
				.refine((p) => !(p.sourceSkuIds || p.mainImages || p.detailImages) || p.ids?.length === 1, "明确货源或图片范围时必须只指定一份商品稿"),
			async (p) => {
				const sql = await db();
				const want =
					p.ids ??
					(
						await sql`select id::text from listings where not cancelled and product_id is null and (offer is null or problems is not null or jsonb_typeof(variants) is distinct from 'object' or (category_path is not null and days_to_ship is null)) order by id`
					).map((r) => r.id as string);
				if (!want.length) return [];
				const before = await namesOf(sql, want);
				const settled = await each(want, p.jobs, async (id) => {
					const r = await make(sql, id, (line) => console.error(`${before(id)}：${line}`), {
						imageMode: p.imageMode,
						sourceSkuIds: p.sourceSkuIds,
						mainImages: p.mainImages,
						detailImages: p.detailImages,
					});
					const [l] = await sql<ListingRow[]>`select * from listings where id = ${id}`;
					const specs = l ? specsOf(l.variants) : null;
					const needs = l ? estimateNeeds(l) : [];
					return { ...r, name: l ? listingName(l) : `商品稿 ${id}`, needs, problems: [...r.problems, ...(specs ? pricingProblems(specs, needs) : [])] };
				});
				const results = settled.flatMap((x) => (x.ok ? [x.value] : []));
				const rank = (f: { error: Error; started: boolean }) => (!f.started ? 2 : f.error instanceof NeedsHuman ? 0 : 1);
				const failed = settled
					.flatMap((x, i) => (x.ok ? [] : [{ id: want[i]!, error: x.error as Error, started: x.started }]))
					.sort((a, b) => rank(a) - rank(b));
				if (failed.length) {
					const lines = [
						...failed.map((f) => `${before(f.id)}：${f.started ? f.error.message : "没开始（先处理上面要人处理的，再跑 x2 listing make）"}`),
						...(results.length ? [`做完了：${results.map((r) => `${r.name}${r.problems.length ? `（${r.problems[0]}）` : ""}`).join("；")}`] : []),
					];
					throw failed.some((f) => f.error instanceof NeedsHuman) ? new NeedsHuman(lines.join("\n")) : new Error(lines.join("\n"));
				}
				return results;
			},
			{
				text: (results) => {
					if (!results.length) return "没有要做的商品稿";
					const hint = (r: { id: string; needs: string[] }) =>
						r.needs.length
							? `\n  估：x2 listing estimate --id ${r.id}${r.needs.includes("重量") ? " --weight <kg>" : ""}${r.needs.includes("国内运费") ? " --freight <元/件>" : ""}`
							: "";
					return results
						.map((r) => `${r.name}：${r.problems.length ? `\n  ${r.problems.join("\n  ")}${hint(r)}` : `已做好，待写文案（x2 listing show --id ${r.id}）`}`)
						.join("\n");
				},
			},
		),
		estimate: get(
			"估 1688 没给的重量、读不到的国内运费：只填空着的（人填过的不动），写完马上重新核价（不读 1688）。重量往重了估，轻的写 1；国内运费往高了估",
			z.object({
				id,
				weight: z.coerce.number().positive().finite().optional().describe("重量（kg）"),
				freight: z.coerce.number().nonnegative().finite().optional().describe("国内运费（元/件）"),
			}),
			async (p) => {
				if (p.weight === undefined && p.freight === undefined) throw new Usage("x2 listing estimate --id <商品稿> --weight <kg> --freight <元/件>：至少给一样");
				const sql = await db();
				const [l] = await sql<ListingRow[]>`select * from listings where id = ${p.id}`;
				if (!l) throw new Usage(`没有商品稿 ${p.id}`);
				if (!l.offer || !specsOf(l.variants)) throw new Usage(`${listingName(l)}还没做好：先 x2 listing make --ids ${p.id}`);
				const { set, notes } = estimateFill(l, estimateNeeds(l), p);
				if (set.weight_kg !== undefined)
					await sql`update listings set weight_kg = ${set.weight_kg}, updated_at = now() where id = ${p.id} and weight_kg is null`;
				if (set.freight_rmb !== undefined)
					await sql`update listings set freight_rmb = ${set.freight_rmb}, updated_at = now() where id = ${p.id} and freight_rmb is null`;
				const [now] = await sql<ListingRow[]>`select * from listings where id = ${p.id}`;
				const [row] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${now!.shop}`;
				await savePrices(sql, now!, settingsOf(row!));
				const left = estimateNeeds(now!);
				const problems = [
					...String(now!.problems ?? "")
						.split("\n")
						.filter(Boolean),
					...pricingProblems(specsOf(now!.variants)!, left),
				];
				const prices = specsText(specsOf(now!.variants)!, removedOf(now!.offer, now!.removed_variants));
				return { id: p.id, name: listingName(now!), notes, needs: left, problems, prices };
			},
			{
				text: (r) =>
					[
						`${r.name}：${r.notes.join("；")}`,
						`规格和价格：\n  ${r.prices.split("\n").join("\n  ")}`,
						r.problems.length ? `还有：${r.problems.join("；")}` : "核价好了（下一步看 x2 status）",
					].join("\n"),
			},
		),
		show: get(
			"写文案要用的事实：货源标题、规格的层和选项（1688 原文、现在的名字、售价）、类目、属性、服务，和现在的标题、描述、简称",
			z.object({ id }),
			async (p) => {
				const [l] = await (await db())<ListingRow[]>`select * from listings where id = ${p.id}`;
				if (!l) throw new Usage(`没有商品稿 ${p.id}`);
				const specs = specsOf(l.variants);
				const tiers =
					specs && !isSingle(specs)
						? specs.tiers.map((t, a) => ({
								n: a + 1,
								source: t.source,
								name: t.name,
								options: t.options.map((o, k) => ({
									n: k + 1,
									source: o.source,
									name: o.name,
									price: priceRange(specs.variants.filter((v) => v.options[a] === k)),
								})),
							}))
						: [];
				return {
					id: String(l.id),
					shop: l.shop,
					nickname: l.nickname ?? null,
					offerTitle: l.offer?.title ?? null,
					category: l.category_name,
					attributes: l.attributes_text,
					variants: specs?.variants.length ?? 0,
					minPurchase: l.min_purchase ?? null,
					channelIds: l.channel_ids ?? null,
					channelOptions: l.channel_options ?? null,
					tiers,
					weights: [...new Set((specs?.variants ?? []).map((v) => v.weightKg))],
					needs: estimateNeeds(l),
					tags: l.offer?.tags ?? null,
					title: l.title,
					description: l.description,
					problems: l.offer && !specs ? OLD_SPECS : l.problems,
				};
			},
		),
		text: get(
			'agent 写的标题、描述、规格名和简称，写完马上 Gemini 文字检查。一份：--id --title --description [--tiers \'[{ "name": "款式", "options": ["…"] }]\'] [--nickname]；几份：--items - 从 stdin 读 [{ id, title, description, tiers, nickname }]。有一样不对那一份就什么都不存',
			z
				.object({
					id: id.optional(),
					title: z.string().optional().describe("标题（台湾繁体）"),
					description: z.string().optional().describe("描述（台湾繁体）"),
					tiers: z.preprocess(parseJson, z.unknown()).optional().describe("规格名（JSON），个数、顺序照 x2 listing show"),
					nickname: z.string().optional().describe("简称（简体中文，最多 12 字）"),
					items: z
						.preprocess(
							parseJson,
							z.array(
								z.object({
									id: z.coerce.string().pipe(ListingId),
									title: z.coerce.string().default(""),
									description: z.coerce.string().default(""),
									tiers: z.unknown().optional(),
									nickname: z.string().nullish(),
								}),
							),
						)
						.optional()
						.describe("几份一起（JSON；写 - 从 stdin 读）"),
				})
				.refine((p) => Boolean(p.id) !== Boolean(p.items), { message: "给 --id（一份）或 --items（几份），不要都给" }),
			async (p) => {
				const sql = await db();
				const items = p.items
					? p.items.map((x) => ({ ...x, nickname: x.nickname ?? undefined }))
					: [{ id: p.id!, title: p.title ?? "", description: p.description ?? "", tiers: p.tiers, nickname: p.nickname }];
				const results: { id: ListingId; saved: boolean; problems: string[]; notes?: string[] }[] = [];
				for (const it of items) {
					const problems = [...textProblems(it.title.trim(), it.description.trim()), ...(it.nickname === undefined ? [] : nicknameProblems(it.nickname))];
					const [l] = await sql`select variants, offer, removed_variants, nickname from listings where id = ${it.id}`;
					if (!l) {
						results.push({ id: it.id, saved: false, problems: ["没有这份商品稿"] });
						continue;
					}
					let specs = specsOf(l.variants);
					if (it.tiers !== undefined) {
						const names = tierNames.safeParse(it.tiers);
						if (!names.success) problems.push("规格名：tiers 要是 [{ name: 层名, options: [选项名…] }]，个数、顺序照 x2 listing show");
						else if (!specs) problems.push(OLD_SPECS);
						else {
							const r = renameSpecs(specs, names.data);
							problems.push(...r.problems);
							specs = r.specs ?? specs;
						}
					}
					if (problems.length) {
						results.push({ id: it.id, saved: false, problems });
						continue;
					}
					const renamed = it.tiers !== undefined && specs ? { variants: sql.json(specs) } : {};
					const nick = it.nickname === undefined ? {} : nicknameOpen(l) ? { nickname: it.nickname.trim() } : null;
					await sql`update listings set ${sql({ title: it.title.trim(), description: it.description.trim(), ...renamed, ...nick, updated_at: new Date() })} where id = ${it.id}`;
					results.push({
						id: it.id,
						saved: true,
						problems: [],
						...(nick ? {} : { notes: [`简称：已有「${l.nickname}」，不改（只在空着、还是自动填的时候写）`] }),
					});
				}
				const name = await namesOf(
					sql,
					results.map((r) => r.id),
				);
				const checks = await textChecks(
					sql,
					results.filter((r) => r.saved).map((r) => r.id),
				);
				return { text: results.map((r) => ({ ...r, name: name(r.id) })), audit: checks };
			},
			{
				text: (r) =>
					[...r.text.map((x) => `${x.name}：${x.saved ? ["记下了", ...(x.notes ?? [])].join("；") : x.problems.join("；")}`), ...r.audit.map(checkLine)].join(
						"\n",
					),
			},
		),
		audit: get(
			"Gemini 文字检查（看文案和加水印之前的图，挑简体字、错字、误译）：只提示，挑出的问题带编号写进说明；详情图、不是封面的主图上后加的文案 x2 去掉（人要用：x2 listing keep）。不给编号就查所有写了文案、还没建商品的",
			z.object({ ids: ids.optional() }),
			async (p) => {
				const sql = await db();
				const want =
					p.ids ??
					(await sql<{ id: ListingId }[]>`select id::text from listings where not cancelled and product_id is null and title is not null order by id`).map(
						(r) => r.id,
					);
				return textChecks(sql, want);
			},
			{ text: (checks) => checks.map(checkLine).join("\n") || "没有要查的商品稿" },
		),
		keep: get(
			"保留的图（人说了才用）：按图的名字（主图 N、详情图 N，见商品稿的说明）找图；x2 去掉的放回来，以后检查再挑它也不去掉",
			z.object({ id, images: strs("图的名字，例 主图 2,详情图 3") }),
			async (p) => {
				const sql = await db();
				const asked = [...new Set([...p.images.join(" ").matchAll(/(主图|详情图)\s*(\d+)/g)].map((m) => `${m[1]} ${m[2]}`))];
				if (!asked.length) throw new Usage("x2 listing keep --id <商品稿> --images 主图 N,详情图 N（图的名字，见商品稿的说明；人说了才用）");
				const [l] = await sql<ListingRow[]>`select * from listings where id = ${p.id}`;
				if (!l) throw new Usage(`没有商品稿 ${p.id}`);
				const k = keepImages(listingName(l), asked, l.images ?? {}, l.removed_images ?? [], AUDIT_DROP);
				if ("error" in k) throw new Usage(k.error);
				const { imageIds, restored } = k;
				await sql`update listings set images = ${sql.json(restoreAudited(l.images, imageIds) as Json)}, kept_images = ${sql.json([...new Set([...(l.kept_images ?? []), ...imageIds])])}, updated_at = now() where id = ${p.id}`;
				const checks = await textChecks(sql, [p.id]);
				return { id: p.id, name: listingName(l), kept: asked, restored, audit: checks };
			},
			{
				text: (r) =>
					[`${r.name}：${r.kept.join("、")}记进保留的图${r.restored.length ? `，${r.restored.join("、")}放回来了` : ""}`, ...r.audit.map(checkLine)].join("\n"),
			},
		),
		drop: get(
			"去掉人不要的规格（例 店里接不了的「定製」；人说了才用）：整个选项（选项名，两层有同名的写「层名:选项名」）或一个规格（货号）。去掉的货号记进已移除的规格",
			z.object({ id, specs: strs("选项名、层名:选项名或货号"), merge: flag("两层合成一层「款式」（人说了才加）").default(false) }),
			async (p) => {
				const sql = await db();
				const [l] = await sql`select id::text, shop, nickname, offer_id, variants, offer, removed_variants, problems from listings where id = ${p.id}`;
				if (!l) throw new Usage(`没有商品稿 ${p.id}`);
				const specs = specsOf(l.variants);
				if (!specs) throw new Usage(`${listingName(l)}的规格是旧格式：先重做商品稿（x2 listing make --ids ${p.id}），再去掉`);
				const r = dropSpecs(specs, p.specs, p.merge);
				if ("error" in r) throw new Usage(`${listingName(l)}：${r.error}`);
				const removed = [...new Set([...(l.removed_variants ?? []), ...r.skus])];
				await sql`update listings set variants = ${sql.json(r.specs)}, removed_variants = ${sql.json(removed)}, updated_at = now() where id = ${p.id}`;
				return { id: p.id, name: listingName(l), dropped: r.skus, left: r.specs.variants.length, merged: r.merged, recheck: Boolean(l.problems) };
			},
			{
				text: (r) =>
					`${r.name}：去掉 ${r.dropped.length} 个规格，还剩 ${r.left} 个${r.merged ? "，两层合成一层「款式」" : ""}\n下一步：${r.recheck ? `x2 listing make --ids ${r.id}（规格的问题要重新算）` : `x2 listing audit --ids ${r.id}（规格变了，要再查）`}`,
			},
		),
		category: get(
			"人在终端里定了类目：写成人定的类目（要是叶子、在本店允许的类目里；建了商品的不改），属性、备货天数清掉，再 x2 listing make（有类目就不再问 Shopee 推荐）。类目 id 见 x2 shopee category-tree",
			z
				.object({
					id,
					category: z.string().regex(/^\d+$/).describe("叶子类目 id"),
					allowOutsideShop: flag("显式允许本稿使用店铺清单外的指定叶子，不改全店设置").default(false),
					reason: z.string().trim().min(1).optional().describe("本稿类目例外的用户授权与理由"),
				})
				.refine((p) => !p.allowOutsideShop || Boolean(p.reason), "允许清单外类目须写明本稿授权理由"),
			async (p) => setCategory(await db(), p.id, p.category, (shopId) => inAccount("shopee", shopId, () => categoryTree()), p),
			{
				text: (r) => {
					const notes = [r.cancelled ? "这份已放弃：要上就去掉「放弃」" : "", r.before && r.before !== r.category ? `原来是「${r.before}」` : ""].filter(
						Boolean,
					);
					return [
						`${r.name}：类目定为「${r.category}」，属性、备货天数清掉了${notes.length ? `（${notes.join("；")}）` : ""}`,
						`下一步：x2 listing make --ids ${r.id}（照新的类目做属性、备货天数）`,
					].join("\n");
				},
			},
		),
		publish: write(
			"人在终端里说「批准」：建商品（先建成下架，读回来逐项核对）、上架（读回来在售）。只收待批准、待上架的；有一份不行就都不做",
			z.object({ ids }),
			(sql, p) => publishPlan(sql, [...new Set(p.ids as string[])]),
		),
		"edit-preview": get("现读商品原值，预览标题、指定规格价格、显式类目属性、主图或描述修改；不提交", editParams, async (p) => previewEdit(await db(), p)),
		edit: write("人同意的现有商品修改：核对原标题、原价及指定的原类目、原主图或原描述，提交一次并读回；首次约一个商品 --try", editParams, planEdit),
		"add-size-preview": get("现读现有商品，预览新增一个二级尺寸及逐款售价、库存；不提交", addSizeParams, async (p) => previewAddSize(await db(), p)),
		"add-size": write("人同意的现有商品新增二级尺寸：核对预览指纹，保留旧规格和价格，提交一次并读回；首次单个商品 --try", addSizeParams, planAddSize),
		"expand-preview": get("现读商品，预览已核价1688 SKU子集的完整规格及图片展开；不提交", expandParams, async (p) => previewExpand(await db(), p)),
		expand: write("按显式1688 SKU映射展开规格和图片：原native指纹保护，保留原模型id、价格、货号及库存；首次单款--try", expandParams, planExpand),
		"unlist-preview": get("现读指定商品的在售状态和期间销量：只预览，不下架；未知不当零", unlistParams, async (p) => previewUnlist(await db(), p)),
		unlist: write("人同意下架的零销量商品：确认销量、已付款件数都为零才下架；记意图、提交一次、读回来核对，不删除", unlistParams, planUnlist),
		cancel: get(
			"人在终端里说「放弃」：替人勾「放弃」，马上是已放弃。建了商品的要下架，不是放弃；建商品还没核清的先核清；有一份不行就都不勾。原因只回显，不存",
			z.object({ ids, why: text.optional().describe("原因") }),
			async (p) => {
				const sql = await db();
				const want = [...new Set(p.ids as string[])];
				const name = await namesOf(sql, want);
				const rows = await sql<
					Pick<ListingRow, "id" | "cancelled" | "product_id" | "listed_at">[]
				>`select id::text, cancelled, product_id, listed_at from listings where id in ${sql(want)}`;
				const writes = await sql<
					{ id: string; listing: string; op: string; status: string }[]
				>`select id::text, params->>'listingId' as listing, op, status from writes
						where op in ('建商品', '上架') and status in ('待执行', '已提交', '结果未知', '不一致') and params->>'listingId' in ${sql(want)} order by id`;
				const bad = want.flatMap((id) => {
					const r = rows.find((x) => x.id === id);
					if (!r) return [`没有商品稿 ${id}`];
					const no = cancelBlock(
						name(id),
						r,
						writes.filter((w) => w.listing === id),
					);
					return no ? [no] : [];
				});
				if (bad.length) throw new Usage(`${bad.join("\n")}\n一份都没放弃`);
				const already = new Set(rows.filter((r) => r.cancelled).map((r) => r.id as string));
				await sql`update listings set cancelled = true, updated_at = now() where id in ${sql(want)} and not cancelled and product_id is null and listed_at is null`;
				const r = await listingsCheck(sql, want);
				return want.map((id) => ({ id, name: name(id), step: r.steps.get(id)?.step ?? null, already: already.has(id), why: p.why ?? null }));
			},
			{
				text: (done) => [...done.map((x) => `${x.name}：${x.already ? "已经放弃了" : x.step}`), ...(done[0]?.why ? [`原因：${done[0].why}`] : [])].join("\n"),
			},
		),
		noted: get(
			"照人写的「备注」做完：记下看过的备注原文（备注再改，x2 status 的 todo 又给出来）；人写的备注不改",
			z.object({ ids }),
			async (p) => {
				const sql = await db();
				const want = [...new Set(p.ids as string[])];
				const rows = await sql`update listings set noted = note where id in ${sql(want)} returning id::text, note`;
				const missing = want.filter((id) => !rows.some((r) => r.id === id));
				if (missing.length) throw new Usage(`没有商品稿 ${missing.join("、")}`);
				const name = await namesOf(sql, want);
				return rows.map((r) => ({ id: r.id, name: name(r.id), note: r.note }));
			},
			{ text: (rows) => rows.map((r) => `${r.name}：看过备注「${r.note ?? ""}」`).join("\n") },
		),
		list: get(
			"所有商品稿走到哪了（放弃了的不列）",
			undefined,
			async () =>
				(
					await (await db())<
						(Pick<ListingRow, "id" | "shop" | "nickname" | "offer_id" | "strategy" | "title" | "step" | "step_detail" | "problems" | "product_id"> & {
							offer_title: string | null;
						})[]
					>`select id::text, shop, nickname, offer_id, offer->>'title' as offer_title, strategy, title, step, step_detail, problems, product_id from listings where not cancelled order by id`
				).map((r) => ({ ...r, name: listingName({ ...r, offer: { title: r.offer_title ?? undefined } }) })),
			{
				text: (rows) =>
					rows.length
						? rows
								.map(
									(r) =>
										`${r.name} ${r.step ?? "（还没检查）"}${r.step_detail ? `：${String(r.step_detail).split("\n")[0]}` : ""}${r.problems ? `\n    ${String(r.problems).split("\n").join("\n    ")}` : ""}`,
								)
								.join("\n")
						: "还没有商品稿：x2 listing add --shop <店> --links <1688 链接>",
			},
		),
	},
	check: async (sql) => {
		const r = await listingsCheck(sql);
		return { read: [], human: r.reminders, todo: r.todo };
	},
	writes: { ...LISTING_WRITES, ...UNLIST_WRITES, ...EDIT_WRITES, ...ADD_SIZE_WRITES, ...EXPAND_WRITES },
	written,
	tables: LISTING_TABLES,
	schema: new URL("./schema.sql", import.meta.url),
};

export async function setCategory(
	sql: Sql,
	id: ListingId,
	category: string,
	tree: (shopId: string) => Promise<Category[]>,
	options: { allowOutsideShop?: boolean; reason?: string } = {},
) {
	const [l] = await sql<ListingRow[]>`select * from listings where id = ${id}`;
	if (!l) throw new Usage(`没有商品稿 ${id}`);
	const name = listingName(l);
	const built = categoryBlock(name, l, category, "", null);
	if (built) throw new Usage(built);
	const [row] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${l.shop}`;
	if (!row) throw new Usage(`店铺设置里没有「${l.shop}」`);
	const s = settingsOf(row);
	const found = leafPath(await tree(s.shopId), category);
	if ("error" in found) throw new Usage(`${name}：${found.error}`);
	const full = found.names.join(" > ");
	if (options.allowOutsideShop && !options.reason?.trim()) throw new Usage("允许清单外类目须写明本稿授权理由");
	const exception = options.allowOutsideShop ? { categoryId: category, reason: options.reason!.trim() } : null;
	const no = categoryBlock(name, l, category, full, s.categories, exception);
	if (no) throw new Usage(no);
	const problems =
		String(l.problems ?? "")
			.split("\n")
			.filter((x) => x && !CATEGORY_PROBLEM.test(x))
			.join("\n") || null;
	const [done] = await sql`update listings set category_path = ${sql.json(found.path)}, category_id = ${category}, category_name = ${full},
		category_exception = ${exception ? sql.json(exception) : null}, attributes = null, attributes_text = null, days_to_ship = null, problems = ${problems}, updated_at = now()
		where id = ${id} and product_id is null and listed_at is null returning id`;
	if (!done) throw new Usage(`${name}刚建了商品：不改类目`);
	const r = await listingsCheck(sql, [id]);
	return {
		id,
		name,
		category: full,
		categoryPath: found.path,
		categoryException: exception,
		before: (l.category_name as string | null) ?? null,
		cancelled: Boolean(l.cancelled),
		step: r.steps.get(id)?.step ?? null,
	};
}

type CheckResult = { id: string; name: string; checked: boolean; cached?: boolean; problems?: string[]; issues: AuditIssue[] };
const checkLine = (c: CheckResult) => {
	if (!c.checked) return `${c.name} Gemini 文字检查：查不了：${(c.problems ?? []).join("；")}`;
	const dropped = c.issues.filter((x) => x.status === "已去掉");
	return [
		`${c.name} Gemini 文字检查：${c.issues.length ? `挑出 ${c.issues.length} 条（只提示，写在说明里）` : "没挑出问题"}${c.cached ? "（查过）" : ""}`,
		...c.issues.map((x) => `  ${issueLine(x)}`),
		...(dropped.length ? [`  x2 去掉的图人说要用才放回来：x2 listing keep --id ${c.id} --images ${dropped.map((x) => x.name ?? x.image).join(",")}`] : []),
	].join("\n");
};

async function productNow(sql: Sql, id: ListingId) {
	const [l] = await sql<ListingRow[]>`select * from listings where id = ${id}`;
	if (!l) return null;
	const [row] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${l.shop}`;
	return { l, kept: l.kept_images ?? [], r: productOf(l, settingsOf(row!)) };
}

const MAX_RECHECK = 2;

async function textChecks(sql: Sql, ids: ListingId[]): Promise<CheckResult[]> {
	const out: CheckResult[] = [];
	for (const id of ids) {
		let c = await productNow(sql, id);
		if (!c) {
			out.push({ id, name: `商品稿 ${id}`, checked: false, problems: ["没有这份商品稿"], issues: [] });
			continue;
		}
		const name = listingName(c.l);
		if (!c.r.product) {
			out.push({ id, name, checked: false, problems: c.r.problems, issues: [] });
			continue;
		}
		let a = c.l.audit as Audit | null;
		const cached = a?.key === auditKey(c.r.product);
		if (!cached) {
			for (let round = 0; c.r.product; round++) {
				console.error(`Gemini 文字检查：${name}${round ? `（去掉挑出的图以后第 ${round} 次再查）` : ""}`);
				const pics = (c.l.images ?? {}) as Pics;
				a = await textCheck(c.r.product, { image: (x) => unmarked(sql, pics, x), kept: c.kept, canDrop: round < MAX_RECHECK });
				const drops = a.images.filter((x) => x.dropped);
				if (!drops.length) break;
				await sql`update listings set images = ${sql.json(dropAudited(c.l.images, drops) as Json)}, updated_at = now() where id = ${id}`;
				c = (await productNow(sql, id))!;
			}
			if (!c.r.product) {
				out.push({ id, name, checked: false, problems: c.r.problems, issues: [] });
				continue;
			}
			a = { ...a!, images: [...auditDropped(c.l.images), ...a!.images] };
			await sql`update listings set audit = ${sql.json(a as Json)}, updated_at = now() where id = ${id}`;
		}
		const issues = auditIssues(a!, c.kept, imageNames(c.l.images ?? {}, specsOf(c.l.variants)));
		out.push({ id, name, checked: true, ...(cached ? { cached } : {}), issues });
	}
	return out;
}
