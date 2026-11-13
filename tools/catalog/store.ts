// Catalog 的快照读写：同店同步互斥、完成后原子替换引用，外站失败只保存失败批次。
import { randomUUID } from "node:crypto";
import { allProducts, productInfo } from "../../connectors/sites/shopee/products.ts";
import { shop as identity } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import type { Json, Sql } from "../../platform/db/index.ts";
import { NeedsHuman, Usage } from "../../platform/errors.ts";
import { CATEGORY_RULES, UNCATEGORIZED } from "./categories.ts";
import { type EncodedSourceSnapshot, enrichEncodedProductSources, readEncodedSourceSnapshots } from "./encoded-sources.ts";
import {
	type CatalogReader,
	type ChosenLink,
	type CollectProgress,
	collectCatalog,
	type ListingLink,
	type Ownership,
	type ProductFact,
	supplierLinks,
} from "./facts.ts";
import { enrichProductImages, type ImageReader } from "./images.ts";
import { type CatalogSourceRow, enrichProductSources } from "./sources.ts";
import { statusChanges } from "./status.ts";

type Shop = { shop: string; shop_id: string };
type Batch = {
	id: string;
	status: "running" | "complete" | "partial" | "failed";
	started_at: Date;
	captured_at: Date | null;
	finished_at: Date | null;
	complete: boolean;
	details_complete: boolean;
	expected_count: number | null;
	product_count: number | null;
	error: string | null;
	phase: "listing" | "details" | null;
	page: number | null;
	observed: number | null;
};
export const batchOf = (b: Batch) => ({
	revision: b.id,
	status: b.status,
	startedAt: b.started_at.toISOString(),
	capturedAt: b.captured_at?.toISOString() ?? null,
	finishedAt: b.finished_at?.toISOString() ?? null,
	source: "shopee" as const,
	scope: "all" as const,
	complete: b.complete,
	detailsComplete: b.details_complete,
	expectedCount: b.expected_count,
	productCount: b.product_count,
	error: b.error,
	phase: b.phase,
	page: b.page,
	observed: b.observed,
});
async function configured(sql: Sql, shop: string): Promise<Shop> {
	const [row] = await sql<Shop[]>`select shop, shop_id from shop_settings where shop = ${shop}`;
	if (!row) throw new Usage(`没有已配置的店铺 ${shop}`);
	return row;
}

export async function catalogShops(sql: Sql) {
	const rows = await sql<(Shop & { captured_at: Date | null; product_count: number | null; status: string | null; error: string | null })[]>`
		select s.shop, s.shop_id, good.captured_at, good.product_count, last.status, last.error
		from shop_settings s left join catalog_heads h on h.shop = s.shop and h.shop_id = s.shop_id
		left join catalog_syncs good on good.id = h.revision
		left join lateral (select status, error from catalog_syncs where shop = s.shop and shop_id = s.shop_id order by started_at desc limit 1) last on true
		order by s.shop`;
	return {
		shops: rows.map((r) => ({
			shop: r.shop,
			shopId: r.shop_id,
			capturedAt: r.captured_at?.toISOString() ?? null,
			productCount: r.product_count,
			status: r.status,
			error: r.error,
		})),
	};
}

export async function syncCatalog(sql: Sql, shop: string, makeReader?: () => CatalogReader) {
	const target = await configured(sql, shop);
	const revision = randomUUID();
	const conn = await sql.reserve();
	let started = false;
	let locked = false;
	let transaction = false;
	let result: { ok: boolean; revision: string; error: string | null; errorKind: "human" | "error" | null };
	try {
		const [lock] = await conn<
			{ locked: boolean; pid: number }[]
		>`select pg_try_advisory_lock(hashtext('x2 catalog'), hashtext(${shop})) as locked, pg_backend_pid() as pid`;
		if (!lock?.locked) throw new Usage(`${shop} 的 Catalog 正在刷新，请稍后读取结果`);
		locked = true;
		await conn`update catalog_syncs set status = 'failed', finished_at = now(), error = '上次同步进程已中断；保留最后成功快照'
			where shop = ${shop} and shop_id = ${target.shop_id} and status = 'running'`;
		await conn`insert into catalog_syncs (id, shop, shop_id, scope, status, started_at, backend_pid)
			values (${revision}, ${shop}, ${target.shop_id}, 'all', 'running', now(), ${lock.pid})`;
		started = true;
		const progress = async (p: CollectProgress) => {
			if (p.phase === "details" && p.observed % 10 !== 0 && p.observed !== p.total) return;
			await conn`update catalog_syncs set phase = ${p.phase}, page = ${p.page}, observed = ${p.observed}, expected_count = ${p.total} where id = ${revision}`;
		};
		const read = () => collectCatalog({ shop, shopId: target.shop_id }, makeReader?.() ?? { identity, list: allProducts, detail: productInfo }, progress);
		const collected = makeReader ? await read() : await inAccount("shopee", target.shop_id, read);
		await conn.unsafe("begin");
		transaction = true;
		const [held] = await conn<{ held: boolean }[]>`select pg_backend_pid() = ${lock.pid} as held`;
		if (!held?.held) throw new Error("数据库连接已改变，同步锁丢失，本次目录不发布");
		const [unchanged] = await conn<Shop[]>`select shop, shop_id from shop_settings where shop = ${shop} and shop_id = ${target.shop_id}`;
		if (!unchanged) throw new Error("店铺配置在读取期间变化，本次目录不发布");
		const capturedAt = new Date();
		const rows = collected.products.map((p) => ({
			shop,
			shop_id: target.shop_id,
			revision,
			product_id: p.productId,
			name: p.name,
			parent_sku: p.parentSku,
			cover: p.cover,
			status: p.status,
			status_label: p.statusLabel,
			stock_state: p.stockState,
			price_min: p.priceMin,
			price_max: p.priceMax,
			stock_total: p.stockTotal,
			models: p.models === null ? null : conn.json(p.models as Json),
			facts: conn.json(p as Json),
			captured_at: capturedAt,
		}));
		for (let offset = 0; offset < rows.length; offset += 200) await conn`insert into catalog_products ${conn(rows.slice(offset, offset + 200))}`;
		await conn`update catalog_syncs set status = ${collected.detailsComplete ? "complete" : "partial"}, captured_at = ${capturedAt}, finished_at = now(),
			complete = true, details_complete = ${collected.detailsComplete}, expected_count = ${collected.expectedCount}, product_count = ${collected.products.length}
			where id = ${revision}`;
		await conn`insert into catalog_heads (shop, shop_id, revision) values (${shop}, ${target.shop_id}, ${revision})
			on conflict (shop, shop_id) do update set revision = excluded.revision`;
		await conn.unsafe("commit");
		transaction = false;
		result = { ok: true, revision, error: null, errorKind: null };
	} catch (e) {
		if (transaction) await conn.unsafe("rollback").catch(() => {});
		const error = (e as Error).message;
		if (started) await sql`update catalog_syncs set status = 'failed', finished_at = now(), error = ${error} where id = ${revision}`;
		result = { ok: false, revision, error, errorKind: e instanceof NeedsHuman ? "human" : "error" };
	} finally {
		if (locked) await conn`select pg_advisory_unlock(hashtext('x2 catalog'), hashtext(${shop}))`.catch(() => {});
		conn.release();
	}
	return { ...result, ...(await readCatalog(sql, { shop, query: "", status: "all", stock: "all", page: 1, pageSize: 50 })) };
}

export type CatalogQuery = { shop: string; query: string; status: string; stock: string; category?: string; page: number; pageSize: number };
type CatalogFact = ProductFact & { modelsDeferred?: boolean };
type FactRow = { facts: CatalogFact };
export async function readCatalog(sql: Sql, p: CatalogQuery, summary = false) {
	const target = await configured(sql, p.shop);
	// 同一阶段的只读查询并发发起，避免远程数据库的网络往返逐条累加。
	const [[good], [last]] = await Promise.all([
		sql<Batch[]>`select b.* from catalog_syncs b join catalog_heads h on h.revision = b.id where h.shop = ${p.shop} and h.shop_id = ${target.shop_id}`,
		sql<Batch[]>`select * from catalog_syncs where shop = ${p.shop} and shop_id = ${target.shop_id} order by started_at desc limit 1`,
	]);
	const snapshot = good ? batchOf(good) : null;
	const lastAttempt = last ? batchOf(last) : null;
	if (!good)
		return {
			shop: p.shop,
			shopId: target.shop_id,
			snapshot,
			lastAttempt,
			rows: [],
			total: 0,
			listedCount: 0,
			listedDetailsComplete: false,
			page: p.page,
			pageSize: p.pageSize,
			statuses: [],
			categories: [],
		};
	let categoryExpression = sql`${UNCATEGORIZED}::text`;
	for (const [label, pattern] of [...CATEGORY_RULES].reverse())
		categoryExpression = sql`case when name ~* ${pattern} then ${label}::text else ${categoryExpression} end`;
	const filter = sql`shop = ${p.shop} and shop_id = ${target.shop_id} and revision = ${good.id}
		and (${p.status} = 'all' or (${p.status} = 'unknown' and status is null) or status::text = ${p.status}) and (${p.stock} = 'all' or stock_state = ${p.stock})
		and (${p.category ?? "all"} = 'all' or ${categoryExpression} = ${p.category ?? "all"})
 and (${p.query} = '' or position(lower(${p.query}) in lower(name || ' ' || product_id || ' ' || coalesce(parent_sku, '') || ' ' || coalesce(models::text, ''))) > 0)`;
	const [[count], rows, statuses, categories] = await Promise.all([
		sql<{ total: number; listedCount: number; listedDetailsComplete: boolean }[]>`
		select count(*) filter (where ${filter})::int as total,
			count(*) filter (where status = 1)::int as "listedCount",
			count(*) filter (where status = 1 and facts->>'detailError' is not null) = 0 as "listedDetailsComplete"
		from catalog_products where shop = ${p.shop} and shop_id = ${target.shop_id} and revision = ${good.id}`,
		// 网页列表不展示 SKU 明细，在数据库端裁掉大字段，避免先经远程连接传输后再删。
		sql<FactRow[]>`select ${summary ? sql`(facts - 'models') || jsonb_build_object('models', null, 'modelsDeferred', true)` : sql`facts`} as facts
		from catalog_products where ${filter}
		order by coalesce(
			(select max(l.listed_at) from listings l join shop_settings s on s.shop = l.shop
				where l.shop = catalog_products.shop and s.shop_id = catalog_products.shop_id and l.product_id = catalog_products.product_id),
			nullif(facts->>'createdAt', '')::timestamptz
		) desc nulls last, name, product_id limit ${p.pageSize} offset ${(p.page - 1) * p.pageSize}`,
		sql<{ status: number | null; label: string }[]>`select distinct status, status_label as label from catalog_products
		where shop = ${p.shop} and shop_id = ${target.shop_id} and revision = ${good.id} order by status nulls last`,
		sql<{ name: string; count: number }[]>`select ${categoryExpression} as name, count(*)::int as count from catalog_products
 where shop = ${p.shop} and shop_id = ${target.shop_id} and revision = ${good.id}
 and (${p.status} = 'all' or (${p.status} = 'unknown' and status is null) or status::text = ${p.status})
 group by 1 order by count desc, name`,
	]);
	const linked = await attachLinks(
		sql,
		p.shop,
		target.shop_id,
		rows.map((r) => r.facts),
	);
	return {
		shop: p.shop,
		shopId: target.shop_id,
		snapshot,
		lastAttempt,
		rows: linked,
		total: count?.total ?? 0,
		listedCount: count?.listedCount ?? 0,
		listedDetailsComplete: count?.listedDetailsComplete ?? false,
		page: p.page,
		pageSize: p.pageSize,
		statuses,
		categories,
	};
}

async function attachLinks(sql: Sql, shop: string, shopId: string, facts: CatalogFact[]) {
	const ids = facts.map((f) => f.productId);
	if (!ids.length) return [];
	type VerifiedSourceRow = EncodedSourceSnapshot & { shop: string; shopId: string; productId: string; models: ProductFact["models"] };
	const [listings, chosen, owners, changes, verified] = await Promise.all([
		sql<ListingLink[]>`select l.shop, s.shop_id as "shopId", l.product_id as "productId", l.offer_id as "offerId"
		from listings l join shop_settings s on s.shop = l.shop where l.product_id in ${sql(ids)}`,
		sql<ChosenLink[]>`select item_id as "productId", offer_id as "offerId", broken, chosen_at::text as "selectedAt"
		from sources where chosen and item_id in ${sql(ids)}`,
		sql<Ownership[]>`select distinct i->>'itemId' as "productId", o.shop_id as "shopId"
		from orders o cross join lateral jsonb_array_elements(o.items) i where i->>'itemId' in ${sql(ids)}`,
		statusChanges(sql, shop, shopId, ids),
		sql<VerifiedSourceRow[]>`select c.shop, c.shop_id as "shopId", c.product_id as "productId", c.offer_id as "offerId",
		c.offer, c.error, c.read_at as "readAt", p.models
		from catalog_source_offers c join catalog_current_products p on p.shop = c.shop and p.shop_id = c.shop_id and p.product_id = c.product_id
		where c.shop = ${shop} and c.shop_id = ${shopId} and c.product_id in ${sql(ids)}`,
	]);
	return facts.map((f) => {
		const links = supplierLinks(shop, shopId, f.productId, listings, chosen, owners);
		const own = verified.filter((row) => row.shop === shop && row.shopId === shopId && row.productId === f.productId);
		const models =
			(f.models ?? own[0]?.models)?.map((model) =>
				model.source || model.sourceWarning ? model : { ...model, source: null, sourceWarning: "未保存此商品的 SKU 货源对应" },
			) ?? null;
		const checked = enrichEncodedProductSources({ ...f, models }, own);
		for (const model of checked.models ?? []) {
			const source = model.source;
			if (source?.basis !== "encoded_sku" || links.suppliers.some((link) => link.offerId === source.offerId)) continue;
			if (links.suppliers.length) links.supplierWarnings.push("已核对规格来源与其他货源记录不同，分别展示，请人工核对");
			links.suppliers.push({ kind: "verified", offerId: source.offerId, url: source.url, broken: null, selectedAt: null });
		}
		return { ...f, ...links, statusChange: changes.get(f.productId) ?? null };
	});
}

export async function readProduct(sql: Sql, shop: string, productId: string, imageReader?: ImageReader, cacheOnly = false) {
	const target = await configured(sql, shop);
	const [row] = await sql<FactRow[]>`select p.facts from catalog_products p join catalog_heads h
		on h.shop = p.shop and h.shop_id = p.shop_id and h.revision = p.revision
		where p.shop = ${shop} and p.shop_id = ${target.shop_id} and p.product_id = ${productId}`;
	if (!row) throw new Usage(`当前 Catalog 没有 ${shop} 的商品 ${productId}`);
	const enriched = cacheOnly
		? { ...row.facts, imageError: null, detailReadAt: null }
		: await enrichProductImages({ shop, shopId: target.shop_id }, row.facts, imageReader);
	const sources = await sql<CatalogSourceRow[]>`select l.shop, s.shop_id as "shopId", l.product_id as "productId", l.offer_id as "offerId",
		l.variants, jsonb_build_object('offerId', l.offer->'offerId', 'skus', l.offer->'skus') as offer, l.offer_read_at as "readAt"
		from listings l join shop_settings s on s.shop = l.shop
		where l.shop = ${shop} and s.shop_id = ${target.shop_id} and l.product_id = ${productId}`;
	const listedSources = enrichProductSources({ shop, shopId: target.shop_id }, enriched, sources);
	const snapshots =
		cacheOnly || !enriched.detailReadAt
			? await sql<EncodedSourceSnapshot[]>`select offer_id as "offerId", offer, error, read_at as "readAt"
			from catalog_source_offers where shop = ${shop} and shop_id = ${target.shop_id} and product_id = ${productId}`
			: await readEncodedSourceSnapshots(listedSources);
	if (!cacheOnly && enriched.detailReadAt) {
		for (const snapshot of snapshots) {
			await sql`insert into catalog_source_offers (shop, shop_id, product_id, offer_id, offer, error, read_at)
				select ${shop}, ${target.shop_id}, ${productId}, ${snapshot.offerId},
					${snapshot.offer == null ? null : sql.json(snapshot.offer as Json)}, ${snapshot.error}, ${snapshot.readAt}
				where exists (select 1 from shop_settings where shop = ${shop} and shop_id = ${target.shop_id})
				on conflict (shop, shop_id, product_id, offer_id) do update
				set offer = excluded.offer, error = excluded.error, read_at = excluded.read_at
				where catalog_source_offers.read_at <= excluded.read_at`;
		}
	}
	const withSources = enrichEncodedProductSources(listedSources, snapshots);
	const [product] = await attachLinks(sql, shop, target.shop_id, [withSources]);
	return { shop, shopId: target.shop_id, product: { ...product!, imageError: enriched.imageError, detailReadAt: enriched.detailReadAt } };
}
