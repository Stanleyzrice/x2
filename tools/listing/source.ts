// 人工备选区复用商品稿、核价和发布；快照与补充值分开保存，发布按钮只批准本次冻结的原文原图指纹。
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import { attributes as attributeTree } from "../../connectors/sites/shopee/products.ts";
import { db, type Json, type Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { get, type Planned, write } from "../../platform/tool.ts";
import { listingAuditCurrent } from "./audit.ts";
import { updatedAttributes } from "./category.ts";
import { coverageBlock } from "./coverage.ts";
import { imageLanguageBlock } from "./image-language.ts";
import { make } from "./make.ts";
import { addListings } from "./pick.ts";
import { type Settings, settingsOf } from "./pricing.ts";
import { inShopQueued } from "./queue.ts";
import { productOf } from "./ready.ts";
import type { ListingRow, ShopSettingsRow } from "./row.ts";
import {
	type CollectedSourceResult,
	type CollectSourceInput,
	mergeSourceFields,
	mergeSourceResearch,
	SourceId,
	type SourceItem,
	type SourceProduct,
	type SourcePublishInput,
	type SourceResearch,
	type SourceShopInput,
	sourceDeleteParams,
	sourceDetailParams,
	sourceFieldsSchema,
	sourceListParams,
	sourceProductSchema,
	sourcePromptParams,
	sourcePublicationHash,
	sourcePublishParams,
	sourcePublishResultParams,
	sourceResearchPick,
	sourceResearchSchema,
	sourceSelectionParams,
	sourceUpdateParams,
} from "./source-data.ts";
import { type SourcePromptSnapshot, sourcePrompt, sourcePromptSnapshotSchema } from "./source-prompt.ts";
import { textProblems } from "./text.ts";

export { type SourceItem, sourceDeleteParams } from "./source-data.ts";
export { saveSource };

type SourceRow = {
	id: SourceId;
	platform: SourceProduct["platform"];
	source_id: string;
	url: string;
	snapshot: SourceProduct;
	captured_at: Date;
	deleted_at: Date | null;
	research?: SourceResearch[];
};
type SourceSummary = Omit<SourceRow, "snapshot"> & { source_title: string; source_image: string | null; sku_count: number; source_errors: string[] };
type Context<TSource = SourceRow> = {
	shop: string;
	settings: Settings;
	sources: TSource[];
	listings: Map<string, ListingRow>;
	pending: Map<string, string[]>;
	deleteBlocks: Map<string, string>;
};
type QuerySql = Sql | postgres.TransactionSql;

async function deleteBlocks(sql: QuerySql, ids: string[]): Promise<Map<string, string>> {
	if (!ids.length) return new Map();
	const rows = await sql<{ source_id: string; shop: string; status: string }[]>`select distinct refs.source_id::text, l.shop, w.status
		from (select source_product_id as source_id, id as listing_id from listings where source_product_id in ${sql(ids)}
			union select source_id, listing_id from listing_source_links where source_id in ${sql(ids)}) refs
		join listings l on l.id = refs.listing_id join writes w on w.params->>'listingId' = l.id::text
		where w.status in ('待执行','已提交','结果未知','不一致')`;
	const blocked = new Map<string, string>();
	for (const row of rows) blocked.set(row.source_id, `关联店铺 ${row.shop} 有${row.status}的操作，请核对完成后再删除备选`);
	return blocked;
}

async function deleteSources(sql: Sql, input: z.output<typeof sourceDeleteParams>) {
	const ids = input.sourceIds;
	return sql.begin(async (tx) => {
		const [shop] = await tx`select 1 from shop_settings where shop = ${effectiveShop(input)}`;
		if (!shop) throw new Usage(`没有「${effectiveShop(input)}」这家店`);
		const rows = await tx<
			{ id: string; deleted_at: Date | null }[]
		>`select id::text, deleted_at from listing_sources where id in ${tx(ids)} order by id for update`;
		if (rows.length !== ids.length) throw new Usage("部分备选商品不存在，本次未删除任何商品");
		// 与确认领取的同一行锁协调：领取后尚未登记writes也不能删除；未领取的旧token随删除作废，重采不恢复它。
		const confirmations = await tx<{ token: string; state: string }[]>`select c.token, c.state from web_confirmations c
			where c.tool = 'listing.source-publish' and exists
				(select 1 from jsonb_array_elements_text(coalesce(c.params->'sourceIds', '[]'::jsonb)) selected(source_id) where selected.source_id in ${tx(ids)})
			order by c.token for update of c`;
		if (confirmations.some((confirmation) => confirmation.state === "executing"))
			throw new Usage("关联上架请求正在执行，本次未删除任何商品；请等待完成后再删除备选");
		const blocked = await deleteBlocks(tx, ids);
		if (blocked.size) throw new Usage(`${[...new Set(blocked.values())].join("；")}；本次未删除任何商品`);
		const prepared = confirmations.filter((confirmation) => confirmation.state === "prepared").map((confirmation) => confirmation.token);
		if (prepared.length) {
			const outcome = { ran: [], unknown: false, blocked: "本次上架范围中的商品已从备选区移除，旧确认已作废；重新采集后须重新选择并确认上架" };
			await tx`update web_confirmations set state = 'completed', outcome = ${tx.json(outcome)} where token in ${tx(prepared)} and state = 'prepared'`;
		}
		// 同时撤销未上架人工稿的原文批准；已登记写入会在上面阻断，尚未登记的旧计划由prepare再查来源状态。
		await tx`update listings set source_approval = null where source_product_id in ${tx(ids)} and listed_at is null`;
		const removed = await tx<{ id: string }[]>`update listing_sources set deleted_at = now() where id in ${tx(ids)} and deleted_at is null returning id::text`;
		return { deleted: removed.map((row) => row.id), alreadyDeleted: rows.filter((row) => row.deleted_at !== null).map((row) => row.id) };
	});
}
const effectiveShop = (p: SourceShopInput) => p.targetShop ?? p.shop;

async function saveSourceTransaction(
	tx: QuerySql,
	source: SourceProduct,
	refreshMissingDetail = false,
): Promise<{ id: string; isNew: boolean; repaired: boolean }> {
	const [added] = await tx<
		{ id: string }[]
	>`insert into listing_sources (platform, source_id, url, snapshot) values (${source.platform}, ${source.sourceId}, ${source.url}, ${tx.json(source as Json)}) on conflict (platform, source_id) do nothing returning id::text`;
	if (added) return { id: added.id, isNew: true, repaired: false };
	const [old] = await tx<SourceRow[]>`select * from listing_sources where platform = ${source.platform} and source_id = ${source.sourceId} for update`;
	if (!old) throw new Usage("备选商品刚变化，请重试采集");
	if (old.deleted_at) throw new Usage("采集期间已删除，请重新点击加入备选");
	// 已明确失败的采集可修复。显式补采只填完全为空的详情，保留其他原始字段和人工补充值。
	const fillDetail = refreshMissingDetail && !old.snapshot.description.blocks.length && source.description.blocks.length > 0;
	let repaired = false;
	if (!source.errors.length && (old.snapshot.errors.length || fillDetail)) {
		const [blocked] =
			await tx`select 1 from listing_source_links x join listings l on l.id = x.listing_id where x.source_id = ${old.id} and (l.product_id is not null or l.listed_at is not null or exists (select 1 from writes w where w.params->>'listingId' = l.id::text and w.status in ('待执行','已提交','结果未知','不一致'))) limit 1`;
		if (!blocked) {
			const snapshot = old.snapshot.errors.length ? source : { ...old.snapshot, description: source.description };
			await tx`update listing_sources set snapshot = ${tx.json(snapshot as Json)}, url = ${snapshot.url}, captured_at = now() where id = ${old.id}`;
			repaired = true;
		}
	}
	return { id: String(old.id), isNew: false, repaired };
}

async function saveSource(sql: Sql, input: SourceProduct): Promise<{ id: string; isNew: boolean }> {
	const source = sourceProductSchema.parse(input);
	return sql.begin(async (tx) => {
		const saved = await saveSourceTransaction(tx, source);
		return { id: saved.id, isNew: saved.isNew };
	});
}

/** 运行锁与备选保存共用事务，取消发生后的迟到读取不得再写入来源或研究记录。 */
export async function saveCollectedSource(sql: Sql, input: CollectSourceInput, product: SourceProduct): Promise<CollectedSourceResult> {
	const source = sourceProductSchema.parse(product);
	return sql.begin(async (tx) => {
		const [shop] = await tx`select 1 from shop_settings where shop = ${input.shop}`;
		if (!shop) throw new Usage(`没有「${input.shop}」这家店`);
		if (input.provenance) {
			const [run] = await tx<
				{ status: string; cancel_requested: boolean; shop: string; strategy_id: string; strategy_name: string }[]
			>`select status, cancel_requested, shop, strategy_id, strategy_name from selection_runs where id = ${input.provenance.runId} for update`;
			if (run?.status !== "running" || run.cancel_requested) throw new Usage("选品运行已停止或不存在，未加入备选");
			if (run.shop !== input.shop || run.strategy_id !== input.provenance.strategyId || run.strategy_name !== input.provenance.strategyName)
				throw new Usage("选品运行的店铺或策略与来源依据不一致，未加入备选");
			const [strategy] = await tx`select name from strategies where name = ${input.provenance.strategyName}`;
			if (!strategy) throw new Usage(`没有策略「${input.provenance.strategyName}」，未加入备选`);
		}
		const saved = await saveSourceTransaction(tx, source, input.refreshMissingDetail);
		const [row] = await tx<SourceRow[]>`select * from listing_sources where id = ${saved.id} for update`;
		if (!row || row.deleted_at) throw new Usage("商品已从备选区移除，未重新加入");
		if (input.provenance) {
			const research = mergeSourceResearch(row.research ?? [], {
				...input.provenance,
				kind: "strategy-run",
				shop: input.shop,
				recordedAt: new Date().toISOString(),
			});
			await tx`update listing_sources set research = ${tx.json(research as Json)} where id = ${row.id}`;
		}
		return {
			sourceId: String(row.id),
			offerId: row.source_id,
			title: row.snapshot.title,
			status: saved.isNew ? "added" : "existing",
			problems: row.snapshot.errors,
			sourceCapturedAt: row.captured_at.toISOString(),
			reusedSnapshot: !saved.isNew && !saved.repaired,
		};
	});
}

async function context(sql: Sql, input: SourceShopInput, ids?: string[], includeDeleted = false): Promise<Context> {
	const shop = effectiveShop(input);
	const [row] = await sql<ShopSettingsRow[]>`select * from shop_settings where shop = ${shop}`;
	if (!row) throw new Usage(`没有「${shop}」这家店`);
	const sources = ids
		? ids.length
			? await sql<
					SourceRow[]
				>`select * from listing_sources where id in ${sql(ids)} and ${includeDeleted ? sql`true` : sql`deleted_at is null`} order by id desc`
			: []
		: await sql<SourceRow[]>`select * from listing_sources where ${includeDeleted ? sql`true` : sql`deleted_at is null`} order by id desc`;
	if (ids && sources.length !== new Set(ids).size) throw new Usage("部分商品已从备选区移除或不存在，请刷新列表");
	return {
		shop,
		settings: settingsOf(row),
		sources,
		...(await sourceRelations(
			sql,
			shop,
			sources.map((source) => String(source.id)),
		)),
	};
}

async function sourceRelations(sql: Sql, shop: string, ids: string[]) {
	const [links, blocked] = await Promise.all([
		ids.length
			? sql<
					(ListingRow & { linked_source_id: string })[]
				>`select l.*, x.source_id::text as linked_source_id from listing_source_links x join listings l on l.id = x.listing_id where x.shop = ${shop} and x.source_id in ${sql(ids)}`
			: Promise.resolve([]),
		deleteBlocks(sql, ids),
	]);
	const pending = new Map<string, string[]>();
	if (links.length) {
		const writes = await sql<
			{ listing_id: string; op: string; status: string }[]
		>`select params->>'listingId' as listing_id, op, status from writes where op in ('建商品','上架') and params->>'listingId' in ${sql(links.map((listing) => String(listing.id)))} and status in ('待执行','已提交','结果未知','不一致')`;
		for (const write of writes) pending.set(write.listing_id, [...(pending.get(write.listing_id) ?? []), `${write.op}：${write.status}`]);
	}
	return { listings: new Map(links.map((listing) => [listing.linked_source_id, listing])), pending, deleteBlocks: blocked };
}

/** 列表只取展示事实；完整原文、图片和源SKU留给详情/商品稿读取。关联稿仍按同一技术校验实时判定。 */
async function summaryContext(sql: Sql, input: SourceShopInput): Promise<Context<SourceSummary> & { shops: { shop: string; shopId: string }[] }> {
	const shop = effectiveShop(input);
	const [settings, sources] = await Promise.all([
		sql<ShopSettingsRow[]>`select * from shop_settings order by shop`,
		sql<SourceSummary[]>`select id, platform, source_id, url, captured_at, deleted_at,
			snapshot->>'title' as source_title, snapshot->'images'->>0 as source_image,
			jsonb_array_length(snapshot->'skus') as sku_count, snapshot->'errors' as source_errors
			from listing_sources where deleted_at is null order by id desc`,
	]);
	const row = settings.find((row) => row.shop === shop);
	if (!row) throw new Usage(`没有「${shop}」这家店`);
	return {
		shop,
		settings: settingsOf(row),
		sources,
		shops: settings.map((row) => ({ shop: row.shop, shopId: String(row.shop_id) })),
		...(await sourceRelations(
			sql,
			shop,
			sources.map((source) => String(source.id)),
		)),
	};
}

function summaryOf(source: SourceRow | SourceSummary): SourceSummary {
	if (!("snapshot" in source)) return source;
	const { snapshot, ...saved } = source;
	return { ...saved, source_title: snapshot.title, source_image: snapshot.images[0] ?? null, sku_count: snapshot.skus.length, source_errors: snapshot.errors };
}

function issues(row: ListingRow, settings: Settings, sourceId?: string): string[] {
	if (!row.listed_at && sourceId !== undefined && String(row.source_product_id ?? "") !== sourceId) return ["已有商品稿属于原有上架流程，请在原商品稿处理"];
	if (row.cancelled) return ["商品稿已放弃，未改变原选择"];
	if (settings.paused) return [`店铺暂停上架：${settings.paused}`];
	if (row.product_id) return [];
	const ready = productOf(row, settings);
	const problems = [...ready.problems, ...textProblems(row.title ?? "", row.description ?? "")];
	const coverage = ready.product && coverageBlock(row, ready.product);
	if (coverage) problems.push(coverage);
	if (ready.product && !row.source_product_id && !listingAuditCurrent(row.audit, ready.product, row.images.imageMode))
		problems.push("现有商品稿尚未完成发布前审阅");
	return [...new Set(problems)];
}

function itemOf(raw: SourceRow | SourceSummary, ctx: Omit<Context, "sources">): SourceItem {
	const source = summaryOf(raw);
	const row = ctx.listings.get(String(source.id));
	const pending = row ? ctx.pending.get(String(row.id)) : undefined;
	const problems = [...source.source_errors, ...(pending ?? (row ? issues(row, ctx.settings, String(source.id)) : []))];
	const status: SourceItem["status"] = row?.listed_at
		? "listed"
		: pending?.length
			? "unknown"
			: !row && !problems.length
				? "collected"
				: problems.length
					? "needs-input"
					: "ready";
	return {
		id: String(source.id),
		platform: source.platform,
		sourceId: source.source_id,
		url: source.url,
		title: row?.title ?? source.source_title,
		image: source.source_image,
		skuCount: source.sku_count,
		capturedAt: source.captured_at.toISOString(),
		errors: source.source_errors,
		status,
		problems,
		listingId: row ? String(row.id) : null,
		productId: row?.product_id ?? null,
		deletable: !source.deleted_at && !ctx.deleteBlocks.has(String(source.id)),
		deleteProblem: source.deleted_at ? "已从备选区移除" : (ctx.deleteBlocks.get(String(source.id)) ?? null),
	};
}

async function ensureDraft(sql: Sql, source: SourceRow, shop: string): Promise<ListingRow> {
	const [active] = await sql`select 1 from listing_sources where id = ${source.id} and deleted_at is null`;
	if (!active) throw new Usage("商品已从备选区移除，请刷新列表");
	const pick = sourceResearchPick(source.research ?? [], shop);
	const { added } = await addListings(sql, { shop, links: [source.url], ...pick, evidence: pick.evidence || source.url });
	const addedRow = added[0]!;
	await sql`insert into listing_source_links (source_id, shop, listing_id) values (${source.id}, ${shop}, ${addedRow.id}) on conflict (source_id, shop) do nothing`;
	if (addedRow.isNew)
		await sql`update listings set source_product_id = ${source.id}, source_fields = '{}'::jsonb, images = '{"imageMode":"original"}'::jsonb where id = ${addedRow.id}`;
	const [row] = await sql<ListingRow[]>`select * from listings where id = ${addedRow.id}`;
	return row!;
}

async function prepareSources(sql: Sql, input: z.output<typeof sourceSelectionParams>) {
	const before = await context(sql, input, input.sourceIds);
	const problems: { id: string; problems: string[] }[] = [];
	for (const source of before.sources) {
		try {
			const row = await ensureDraft(sql, source, before.shop);
			const [pending] =
				await sql`select 1 from writes where params->>'listingId' = ${String(row.id)} and op in ('建商品','上架') and status in ('待执行','已提交','结果未知','不一致') limit 1`;
			if (row.listed_at || row.product_id || pending || source.snapshot.errors.length) continue;
			// 已有稿件不改成另一种流程，不重做已完成的人工资料或图片。
			if (String(row.source_product_id ?? "") !== String(source.id)) continue;
			await make(sql, String(row.id), () => {});
		} catch (error) {
			problems.push({ id: String(source.id), problems: [(error as Error).message] });
		}
	}
	const after = await context(
		sql,
		input,
		before.sources.map((s) => String(s.id)),
	);
	const items = after.sources.map((s) => {
		const item = itemOf(s, after),
			failed = problems.find((p) => p.id === item.id);
		return failed ? { ...item, status: "needs-input" as const, problems: [...new Set([...item.problems, ...failed.problems])] } : item;
	});
	return { items, problems: items.filter((i) => i.problems.length).map((i) => ({ id: i.id, problems: i.problems })) };
}

async function sources(sql: Sql, input: z.output<typeof sourceListParams>) {
	const ctx = await summaryContext(sql, input);
	const all = ctx.sources.map((s) => itemOf(s, ctx));
	const query = input.query?.trim().toLocaleLowerCase() ?? "";
	const items = all.filter(
		(i) =>
			(!query || [i.title, i.url, i.sourceId].some((v) => v.toLocaleLowerCase().includes(query))) &&
			(!input.platform || input.platform === "all" || input.platform === i.platform) &&
			(!input.status || input.status === "all" || input.status === i.status),
	);
	return {
		shop: ctx.shop,
		shops: ctx.shops,
		items,
		total: items.length,
		counts: {
			collected: all.filter((i) => i.status === "collected").length,
			ready: all.filter((i) => i.status === "ready").length,
			needsInput: all.filter((i) => i.status === "needs-input").length,
			listed: all.filter((i) => i.status === "listed").length,
			unknown: all.filter((i) => i.status === "unknown").length,
		},
	};
}

async function detail(sql: Sql, input: z.output<typeof sourceDetailParams>) {
	const ctx = await context(sql, input, [input.sourceId]);
	const source = ctx.sources[0]!,
		row = ctx.listings.get(String(source.id));
	const fields = row?.source_fields ?? {};
	return {
		...itemOf(source, ctx),
		images: source.snapshot.images,
		description: source.snapshot.description,
		props: source.snapshot.props,
		skus: source.snapshot.skus.map((sku) => ({ ...sku, stock: fields.stocks?.[sku.id] ?? sku.stock, price: fields.prices?.[sku.id] ?? sku.price })),
		fields,
		research: z.array(sourceResearchSchema).parse(source.research ?? []),
		minQty: fields.minQty ?? source.snapshot.minQty,
		freightRmb: row?.freight_rmb === null || !row ? source.snapshot.freightRmb : Number(row.freight_rmb),
		tags: source.snapshot.tags ?? null,
	};
}

async function update(sql: Sql, input: z.output<typeof sourceUpdateParams>) {
	const ctx = await context(sql, input, [input.sourceId]);
	const source = ctx.sources[0]!,
		row = await ensureDraft(sql, source, ctx.shop);
	if (row.product_id || row.listed_at || ctx.pending.has(String(row.id))) throw new Usage("商品已提交或已建好，不能用备选区覆盖；结果未知时先核对");
	if (String(row.source_product_id ?? "") !== String(source.id)) throw new Usage("已有商品稿保留原流程，请在原商品稿工具中补充资料");
	const fields = sourceFieldsSchema.parse(input);
	const saved = mergeSourceFields(row.source_fields, fields);
	const ids = new Set(source.snapshot.skus.map((s) => s.id));
	if (Object.keys({ ...saved.stocks, ...saved.prices }).some((id) => !ids.has(id))) throw new Usage("补充的规格不在这件来源商品中");
	for (const [selected, original] of [
		[saved.mainImages, source.snapshot.images],
		[saved.detailImages, source.snapshot.description.images],
	] as const)
		if (selected?.some((url) => !original.includes(url))) throw new Usage("只能从已保存原图中选择，不接受另一商品的图片");
	const leaf = fields.categoryPath?.at(-1) ?? (row.category_id ? Number(row.category_id) : row.category_path?.at(-1));
	const attributeChanges = updatedAttributes(
		fields.attributes !== undefined && leaf ? await inShopQueued(ctx.settings.shopId, () => attributeTree(leaf)) : undefined,
		fields.attributes,
		fields.categoryPath !== undefined,
	);
	if (attributeChanges?.missing.length) throw new Usage(`属性：${attributeChanges.missing.join("；")}`);
	const columns: Record<string, unknown> = { source_fields: sql.json(saved as Json), source_approval: null, problems: null, updated_at: new Date() };
	if (fields.title !== undefined) columns.title = fields.title;
	if (fields.description !== undefined) columns.description = fields.description;
	if (fields.weightKg !== undefined) columns.weight_kg = fields.weightKg;
	if (fields.freightRmb !== undefined) columns.freight_rmb = fields.freightRmb;
	if (fields.categoryPath !== undefined)
		Object.assign(columns, {
			category_path: sql.json(fields.categoryPath),
			category_id: fields.categoryPath.at(-1),
			days_to_ship: fields.daysToShip ?? null,
		});
	if (attributeChanges) {
		columns.attributes = attributeChanges.attributes === null ? null : sql.json(attributeChanges.attributes as Json);
		columns.attributes_text = attributeChanges.text;
	}
	if (fields.daysToShip !== undefined) columns.days_to_ship = fields.daysToShip;
	const changed = await sql.begin(async (tx) => {
		const [active] = await tx`select 1 from listing_sources where id = ${source.id} and deleted_at is null for share`;
		if (!active) throw new Usage("商品已从备选区移除，未保存旧页面的修改");
		return tx`update listings set ${tx(columns)} where id = ${row.id} and product_id is null and listed_at is null
			and source_fields is not distinct from ${row.source_fields == null ? null : tx.json(row.source_fields as Json)}
			and category_id is not distinct from ${row.category_id}
			and attributes is not distinct from ${row.attributes == null ? null : tx.json(row.attributes as Json)}
			and not exists (select 1 from writes where params->>'listingId' = ${String(row.id)} and status in ('待执行','已提交','结果未知','不一致')) returning id`;
	});
	if (!changed.length) throw new Usage("商品资料或提交状态刚变化，未覆盖修改；请刷新后再保存");
	return detail(sql, input);
}

function publicationHash(row: ListingRow, settings: Settings): string | undefined {
	return sourcePublicationHash(row, productOf(row, settings).hash);
}

async function publishPreview(sql: Sql, input: z.output<typeof sourceSelectionParams>) {
	const ctx = await context(sql, input, input.sourceIds);
	const items = await Promise.all(
		ctx.sources.map(async (source) => {
			const item = itemOf(source, ctx);
			if (item.status !== "ready") return item;
			const row = ctx.listings.get(item.id)!;
			if (row.product_id) return item; // 上架关卡现读站点实际图片。
			const { info } = productOf(row, ctx.settings);
			const problem = info && (await imageLanguageBlock(sql, row.shop, `商品稿 #${row.id}`, info));
			return problem ? { ...item, status: "needs-input" as const, problems: [...item.problems, problem] } : item;
		}),
	);
	const prepared = { items };
	const products = prepared.items
		.filter((i) => i.status === "ready")
		.map((i) => {
			const row = ctx.listings.get(i.id)!;
			return { sourceId: SourceId.parse(i.id), listingId: String(row.id), hash: publicationHash(row, ctx.settings)! };
		});
	// 已建但未上架的稿仍有productOf hash；必须保留与现有publishPlan相同的当前稿。
	if (!products.length)
		throw new Usage(
			`没有可上架的商品，请先准备并补齐资料：${
				prepared.items
					.flatMap((i) => i.problems)
					.slice(0, 5)
					.join("；") || "已上架或暂无备选商品"
			}`,
		);
	const requestId = input.requestId ?? randomUUID();
	const sourceIds = ctx.sources.map((s) => SourceId.parse(String(s.id)));
	const [existing] = await sql<
		{ shop: string; source_ids: string[]; products: SourcePublishInput["products"] }[]
	>`select shop, source_ids, products from listing_source_requests where request_id = ${requestId}`;
	if (
		existing &&
		(existing.shop !== ctx.shop ||
			JSON.stringify(existing.source_ids) !== JSON.stringify(sourceIds) ||
			JSON.stringify(existing.products) !== JSON.stringify(products))
	)
		throw new Usage("这次上架请求已冻结为另一份内容，请刷新后重新发起");
	await sql`insert into listing_source_requests (request_id, shop, source_ids, products) values (${requestId}, ${ctx.shop}, ${sql.json(sourceIds)}, ${sql.json(products)}) on conflict (request_id) do nothing`;
	return {
		params: { shop: input.shop, ...(input.targetShop ? { targetShop: input.targetShop } : {}), requestId, sourceIds, products },
		display: `${ctx.shop}：上架 ${products.length} 件原文原图商品；${prepared.items.length - products.length} 件留在备选区`,
		trialRequired: false,
		items: prepared.items,
	};
}

type PublishPlan = (sql: Sql, ids: string[], trackingBatch: string) => Promise<Planned[][]>;

async function publishSourcePlan(sql: Sql, input: SourcePublishInput, plan: PublishPlan) {
	const ctx = await context(sql, input, input.sourceIds);
	const [saved] = await sql<
		{ shop: string; products: SourcePublishInput["products"] }[]
	>`select shop, products from listing_source_requests where request_id = ${input.requestId}`;
	if (!saved || saved.shop !== ctx.shop || JSON.stringify(saved.products) !== JSON.stringify(input.products)) throw new Usage("上架请求与冻结预览不一致");
	const ids: string[] = [];
	for (const product of input.products) {
		const row = ctx.listings.get(String(product.sourceId));
		if (!row || String(row.id) !== product.listingId || ctx.pending.has(String(row.id))) throw new Usage("商品正在提交或结果未知，请先核对原请求，不重复上架");
		if (
			publicationHash(row, ctx.settings) !== product.hash ||
			issues(row, ctx.settings, String(product.sourceId)).length ||
			ctx.sources.find((s) => String(s.id) === String(product.sourceId))?.snapshot.errors.length
		)
			throw new Usage("商品资料已变化，请重新查看上架范围");
		if (row.source_product_id) {
			const approval = { kind: "original-source", sourceProductId: String(row.source_product_id), hash: product.hash, at: new Date().toISOString() };
			const [approved] = await sql`update listings set source_approval = ${sql.json(approval)} where id = ${row.id}
				and exists (select 1 from listing_sources where id = ${row.source_product_id} and deleted_at is null) returning id`;
			if (!approved) throw new Usage("商品已从备选区移除，请重新查看上架范围");
		}
		ids.push(String(row.id));
	}
	await sql`update listing_source_requests set executing_at = now() where request_id = ${input.requestId}`;
	return plan(sql, ids, input.requestId);
}

async function publishResult(sql: Sql, input: z.output<typeof sourcePublishResultParams>) {
	const [request] = await sql<
		{ shop: string; source_ids: string[]; products: SourcePublishInput["products"]; executing_at: Date | null }[]
	>`select shop, source_ids, products, executing_at from listing_source_requests where request_id = ${input.requestId}`;
	if (!request || request.shop !== effectiveShop(input)) throw new Usage("找不到这家店的上架请求");
	const ctx = await context(sql, input, request.source_ids, true);
	const items = ctx.sources.map((s) => itemOf(s, ctx));
	const receipts = await sql<
		{ state: string }[]
	>`select state from web_confirmations where tool = 'listing.source-publish' and params->>'requestId' = ${input.requestId} order by expires_at desc limit 1`;
	const state = items.some((i) => i.status === "unknown")
		? "unknown"
		: request.products.every((p) => items.some((i) => i.id === p.sourceId && i.status === "listed"))
			? "completed"
			: receipts[0]?.state === "unknown"
				? request.executing_at
					? "unknown"
					: "completed"
				: receipts[0]?.state === "completed"
					? "completed"
					: request.executing_at || receipts[0]?.state === "executing"
						? "running"
						: "prepared";
	return { requestId: input.requestId, state, items };
}

export function sourceTools(plan: PublishPlan) {
	return {
		sources: get("人工采集备选区：按平台、关键词和上架状态查看已保存原文原图", sourceListParams, async (p) => sources(await db(), p)),
		"source-prompt": get("导出明确选中商品的上架提示词；只读取已有资料，不准备稿件或执行上架", sourcePromptParams, async (p) => {
			const sql = await db();
			const shop = effectiveShop(p);
			const [target] = await sql<{ shop: string }[]>`select shop from shop_settings where shop = ${shop}`;
			if (!target) throw new Usage(`没有「${shop}」这家店`);
			const rows = await sql<
				{
					id: SourceId;
					platform: string;
					sourceId: string;
					capturedAt: Date;
					research: SourceResearch[];
					listingId: string | null;
					productId: string | null;
					listed: boolean;
					cancelled: boolean;
					imageMode: string | null;
					hasSavedOffer: boolean;
					listingUpdatedAt: Date | null;
					pendingWrites: SourcePromptSnapshot["pendingWrites"];
				}[]
			>`select s.id::text, s.platform, s.source_id as "sourceId", s.captured_at as "capturedAt", s.research,
				l.id::text as "listingId", l.product_id as "productId", l.listed_at is not null as listed,
				coalesce(l.cancelled, false) as cancelled, l.images->>'imageMode' as "imageMode",
				l.offer is not null as "hasSavedOffer", l.updated_at as "listingUpdatedAt",
				coalesce((select jsonb_agg(jsonb_build_object('id', w.id::text, 'op', w.op, 'status', w.status) order by w.id)
					from writes w where w.params->>'listingId' = l.id::text and w.op in ('建商品', '上架')
					and w.status in ('待执行', '已提交', '结果未知', '不一致')), '[]'::jsonb) as "pendingWrites"
				from listing_sources s
				left join listing_source_links x on x.source_id = s.id and x.shop = ${shop}
				left join listings l on l.id = x.listing_id and l.shop = ${shop}
				where s.id in ${sql(p.sourceIds)} and s.deleted_at is null`;
			return sourcePrompt(
				target.shop,
				p.sourceIds,
				rows.map(({ id, platform, sourceId, capturedAt, listingUpdatedAt, research, ...progress }) => ({
					id,
					platform,
					sourceId,
					research,
					snapshot: sourcePromptSnapshotSchema.parse({
						...progress,
						capturedAt: capturedAt.toISOString(),
						listingUpdatedAt: listingUpdatedAt?.toISOString() ?? null,
					}),
				})),
			);
		}),
		"source-delete": get("只从共享上架备选区移除明确选中的商品；保留商品稿与已上架历史，不操作外站", sourceDeleteParams, async (p) =>
			deleteSources(await db(), p),
		),
		"source-detail": get("备选商品的原始主图、规格、文字和详情图，以及当前店铺补充值", sourceDetailParams, async (p) => detail(await db(), p)),
		"source-update": get("明确补充备选商品资料；保留来源快照，不覆盖已发布或结果未知商品", sourceUpdateParams, async (p) => update(await db(), p)),
		"source-prepare": get("按现有规则做原文原图商品稿：缺项留在备选区，不提交外站", sourceSelectionParams, async (p) => prepareSources(await db(), p)),
		"source-publish-preview": get("冻结本次可上架子集及内容指纹，缺项商品保留，不提交", sourceSelectionParams, async (p) => publishPreview(await db(), p)),
		"source-publish": write("人点击全部或选中上架：按冻结原文原图指纹复用既有发布写入，不重发未知结果", sourcePublishParams, (sql, p) =>
			publishSourcePlan(sql, p, plan),
		),
		"source-publish-result": get("读取本次人工上架持久结果；未知结果只读核对，禁止重发", sourcePublishResultParams, async (p) => publishResult(await db(), p)),
	};
}
