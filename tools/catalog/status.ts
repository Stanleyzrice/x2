// Catalog 单件上下架：冻结人工选择和现读身份，确认后至多提交一次；未知结果只读回核对。
import { createHash } from "node:crypto";
import { z } from "zod";
import { type ProductInfo, productInfo, STATUS } from "../../connectors/sites/shopee/products.ts";
import { listProduct, unlistProduct } from "../../connectors/sites/shopee/publish.ts";
import { ItemId, shop as identity } from "../../connectors/sites/shopee/seller.ts";
import { inAccount } from "../../platform/browser/browser.ts";
import type { Json, Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import type { Planned, Sent } from "../../platform/tool.ts";
import { exclusive, type Outcome, type Ran, WriteId, type WriteOp, writeOp } from "../../platform/writes.ts";
import { imageLanguageBlock } from "../listing/index.ts";
import { checkIdentity, type Identity, type ProductFact } from "./facts.ts";

const productId = ItemId.refine((id) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0, "商品 id 要是正整数且不丢精度");
export const statusInput = z.object({
	shop: z.string().min(1),
	productId,
	targetState: z.enum(["listed", "unlisted"]),
	requestId: z.string().uuid(),
});
export const statusReference = statusInput.pick({ shop: true, productId: true, requestId: true });
export type StatusInput = z.output<typeof statusInput>;
type Reference = z.output<typeof statusReference>;
const expectedSchema = z.object({
	shopId: z.string().regex(/^\d+$/),
	name: z.string().min(1),
	parentSku: z.string(),
	status: z.union([z.literal(1), z.literal(8)]),
	unlisted: z.boolean(),
});
export type StatusExpected = z.output<typeof expectedSchema>;
export const statusParams = statusInput.extend({ expected: expectedSchema, fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
export type StatusParams = z.output<typeof statusParams>;
export type StatusChange = { requestId: string; targetState: StatusInput["targetState"]; status: string; error: string | null };
export const STATUS_OP = "Catalog状态";
const keyOf = (requestId: string) => `catalog-status:${requestId}`;
const targetOf = (p: StatusParams) => `shopee:${p.expected.shopId}:product:${p.productId}`;
type Intent = { input: StatusInput; expected: StatusExpected; fingerprint: string; claimed: boolean; created_at: Date };
type Readback = { observed: StatusExpected; checkedAt: string };
type WriteRow = { id: string; params: StatusParams; status: string; error: string | null; readback: { before?: StatusExpected; after?: Readback } | null };

export type StatusDriver = {
	where<T>(shopId: string, fn: () => Promise<T>): Promise<T>;
	identity(): Promise<Identity>;
	detail(productId: string): Promise<ProductInfo>;
	submit(p: StatusParams): Promise<Sent>;
	wait(): Promise<void>;
};
export const statusDriver: StatusDriver = {
	where: (shopId, fn) => inAccount("shopee", shopId, fn),
	identity,
	detail: productInfo,
	submit: (p) =>
		p.targetState === "unlisted" ? unlistProduct.submit({ productId: p.productId, shopId: p.expected.shopId }) : listProduct.submit({ productId: p.productId }),
	wait: () => new Promise((resolve) => setTimeout(resolve, 3000)),
};

export function stateOf(p: Pick<StatusExpected, "status" | "unlisted">): StatusInput["targetState"] {
	if (p.status === 1 && p.unlisted === false) return "listed";
	if ((p.status === 1 || p.status === 8) && p.unlisted === true) return "unlisted";
	throw new Usage("无法明确确认在售或下架；禁卖、审核、删除及未知状态不能用此操作切换");
}
export const statusFingerprint = (p: StatusInput, expected: StatusExpected) =>
	createHash("sha256")
		.update(JSON.stringify([p.shop, p.productId, expected.shopId, expected.name, expected.parentSku, expected.status, expected.unlisted]))
		.digest("hex");
export const sameStatusInput = (a: StatusInput, b: StatusInput) =>
	a.shop === b.shop && a.productId === b.productId && a.targetState === b.targetState && a.requestId === b.requestId;
export function assertStatusFresh(p: StatusParams, actual: StatusExpected): void {
	if (statusFingerprint(p, actual) !== p.fingerprint || statusFingerprint(p, p.expected) !== p.fingerprint)
		throw new Usage("店铺、商品名称、SKU 或状态已改变，请重新预览并确认");
	if (stateOf(actual) === p.targetState) throw new Usage("商品已经是目标状态，不再提交");
}
async function configured(sql: Sql, shop: string): Promise<string> {
	const [row] = await sql<{ shop_id: string }[]>`select shop_id from shop_settings where shop = ${shop}`;
	if (!row) throw new Usage(`没有已配置的店铺 ${shop}`);
	return row.shop_id;
}
async function currentFact(sql: Sql, shop: string, shopId: string, id: string) {
	const [row] = await sql<{ facts: ProductFact; revision: string }[]>`select p.facts, p.revision from catalog_products p join catalog_heads h
		on h.shop = p.shop and h.shop_id = p.shop_id and h.revision = p.revision
		where p.shop = ${shop} and p.shop_id = ${shopId} and p.product_id = ${id}`;
	if (!row) throw new Usage("当前 Catalog 没有该店铺商品，请先读取目录");
	return row;
}
async function readCurrent(
	p: Pick<StatusInput, "shop" | "productId">,
	shopId: string,
	driver: StatusDriver,
	checkImages?: (info: ProductInfo) => Promise<void>,
): Promise<StatusExpected> {
	checkIdentity({ shop: p.shop, shopId }, await driver.identity());
	const info = await driver.detail(p.productId);
	checkIdentity({ shop: p.shop, shopId }, await driver.identity());
	if (info.id != null && String(info.id) !== p.productId) throw new Usage("Shopee 回读商品编号不匹配");
	const parsed = expectedSchema.safeParse({
		shopId,
		name: info.name,
		parentSku: info.parent_sku ?? "",
		status: Number(info.status),
		unlisted: info.is_unlisted,
	});
	if (!parsed.success) throw new Usage("Shopee 未返回明确的商品名称、在售/下架状态或 unlisted 标识；未提交");
	stateOf(parsed.data);
	await checkImages?.(info);
	return parsed.data;
}
async function intentOf(sql: Sql, p: Reference): Promise<Intent> {
	const [intent] = await sql<Intent[]>`select input, expected, fingerprint, claimed, created_at from catalog_status_intents
		where request_id = ${p.requestId} and shop = ${p.shop} and product_id = ${p.productId}`;
	if (!intent) throw new Usage("没有这个店铺商品的状态修改请求，请先预览");
	if ((await configured(sql, p.shop)) !== intent.expected.shopId) throw new Usage("店铺配置已变化，不能复用旧请求");
	return intent;
}
function paramsOf(intent: Intent, p: StatusInput): StatusParams {
	if (!sameStatusInput(intent.input, p)) throw new Usage("同一 requestId 已绑定不同店铺、商品或目标状态");
	return statusParams.parse({ ...p, expected: intent.expected, fingerprint: intent.fingerprint });
}
export async function statusTried(sql: Sql, targetState: StatusInput["targetState"]): Promise<boolean> {
	return (await sql`select 1 from writes where op = ${STATUS_OP} and status = '已核对' and params->>'targetState' = ${targetState} limit 1`).length > 0;
}

// 商品 id 不随 SKU 改名；旧 Catalog 和 listing 的 SKU target 仍按保存的商品身份核对。
// 建商品尚未取得 id 时保留旧 SKU 互斥口径，已有 id 的其他商品不因同 SKU 被误认。
async function productWrites(sql: Sql, p: StatusParams) {
	return sql<{ id: string; key: string; status: string }[]>`select w.id::text, w.key, w.status from writes w
		left join listings l on l.id::text = w.params->>'listingId' and l.shop = ${p.shop}
		cross join lateral (select coalesce(nullif(w.params->>'productId', ''),
			case when w.op = '追加尺寸' then nullif(w.params->>'id', '') end,
			nullif(w.readback->'after'->>'productId', ''), l.product_id) as product_id) known
		where (w.op = ${STATUS_OP} and w.params->'expected'->>'shopId' = ${p.expected.shopId} and w.params->>'productId' = ${p.productId})
			or (w.op in ('建商品', '上架', '下架', '追加尺寸') and w.params->>'shopId' = ${p.expected.shopId}
				and (known.product_id = ${p.productId}
					or (known.product_id is null and w.target = ${`shopee:${p.expected.shopId}:${p.expected.parentSku || p.productId}`})))`;
}
async function assertProductClear(sql: Sql, p: StatusParams) {
	const pending = (await productWrites(sql, p)).find((w) => w.key !== keyOf(p.requestId) && ["已提交", "结果未知", "不一致"].includes(w.status));
	if (pending) throw new Usage(`同一个商品有没核清的写入 #${pending.id}：先核清再做，不换 requestId 重发`);
}

export async function previewStatus(sql: Sql, p: StatusInput, driver: StatusDriver = statusDriver) {
	const shopId = await configured(sql, p.shop);
	await currentFact(sql, p.shop, shopId, p.productId);
	const expected = await driver.where(shopId, () => readCurrent(p, shopId, driver));
	const fingerprint = statusFingerprint(p, expected);
	const frozen = { ...p, expected, fingerprint };
	await assertProductClear(sql, frozen);
	assertStatusFresh(frozen, expected);
	await sql.begin(async (tx) => {
		await tx`insert into catalog_status_intents (request_id, shop, shop_id, product_id, target_state, input, expected, fingerprint)
			values (${p.requestId}, ${p.shop}, ${shopId}, ${p.productId}, ${p.targetState}, ${tx.json(p as Json)}, ${tx.json(expected as Json)}, ${fingerprint}) on conflict do nothing`;
		const [old] = await tx<
			Intent[]
		>`select input, expected, fingerprint, claimed, created_at from catalog_status_intents where request_id = ${p.requestId} for update`;
		if (!old || !sameStatusInput(old.input, p) || old.fingerprint !== fingerprint) throw new Usage("同一 requestId 已冻结另一份商品或状态事实，请重新预览");
		if (old.claimed) throw new Usage("该请求已确认，查看状态结果；不会重复提交");
		if (Date.now() - old.created_at.getTime() > 10 * 60_000) throw new Usage("预览已过期，请使用新 requestId 重新预览");
	});
	return {
		params: p,
		display: `${p.shop}（shopId ${shopId}）\n商品 ${p.productId}「${expected.name}」\nSKU：${expected.parentSku || "未设置"}\n${stateOf(expected) === "listed" ? "在售" : "下架"} → ${p.targetState === "listed" ? "在售" : "下架"}\n仅修改此商品的上下架状态，价格与库存保持原样。`,
		trialRequired: !(await statusTried(sql, p.targetState)),
	};
}
export async function planStatus(sql: Sql, p: StatusInput): Promise<Planned[][]> {
	const claimed = await sql.begin(async (tx) => {
		const [intent] = await tx<
			Intent[]
		>`select input, expected, fingerprint, claimed, created_at from catalog_status_intents where request_id = ${p.requestId} for update`;
		if (!intent) throw new Usage("请先预览并确认具体商品及目标状态");
		const params = paramsOf(intent, p);
		if ((await configured(tx as unknown as Sql, p.shop)) !== params.expected.shopId) throw new Usage("店铺配置已变化，请重新预览");
		if (intent.claimed) return null;
		if (Date.now() - intent.created_at.getTime() > 10 * 60_000) throw new Usage("预览已过期，请重新预览");
		await tx`update catalog_status_intents set claimed = true where request_id = ${p.requestId}`;
		return params;
	});
	return claimed ? [[{ op: STATUS_OP, params: claimed }]] : [];
}

export function statusWrite(driver: StatusDriver = statusDriver): WriteOp<StatusParams, StatusExpected> {
	return {
		describe: "修改人工确认的单件 Shopee 商品上下架状态",
		params: statusParams,
		target: targetOf,
		key: (p) => keyOf(p.requestId),
		display: (p) => `${p.shop} 商品 ${p.productId}「${p.expected.name}」→ ${p.targetState === "listed" ? "在售" : "下架"}`,
		link: "https://seller.shopee.tw/portal/product/list/all",
		untried: "该方向尚无已核对记录：请明确确认一个商品并勾选首次试跑（CLI --try），提交后读回核对",
		tried: (sql, p) => statusTried(sql, p.targetState),
		where: (_sql, p, fn) => driver.where(p.expected.shopId, fn),
		async prepare(sql, p) {
			const intent = await intentOf(sql, p);
			const frozen = paramsOf(intent, p);
			if (!intent.claimed || frozen.fingerprint !== p.fingerprint) throw new Usage("状态修改未确认或冻结参数不一致");
			await assertProductClear(sql, p);
			const before = await readCurrent(p, p.expected.shopId, driver, async (info) => {
				if (p.targetState !== "listed" || Number(info.first_publish_time) > 0) return;
				const language = await imageLanguageBlock(sql, p.shop, `商品 ${p.productId}`, info);
				if (language) throw new Usage(language);
			});
			assertStatusFresh(p, before);
			const claimed = await sql`update catalog_status_intents set submission_started = true
				where request_id = ${p.requestId} and claimed and not submission_started returning request_id`;
			if (!claimed.length) return { skip: "该 requestId 已进入提交或核对流程，不再提交" };
			return { params: p, before };
		},
		async submit(_sql, p) {
			assertStatusFresh(p, await readCurrent(p, p.expected.shopId, driver));
			return driver.submit(p);
		},
		async check(p, before, fresh) {
			if (!before || statusFingerprint(p, before) !== p.fingerprint) return { done: null, readback: { reason: "缺少一致的提交前事实，只能保留未知结果" } };
			for (let n = 0; n < (fresh ? 6 : 1); n++) {
				if (n) await driver.wait();
				const observed = await readCurrent(p, p.expected.shopId, driver);
				const sameProduct = observed.name === p.expected.name && observed.parentSku === p.expected.parentSku;
				const done = sameProduct && stateOf(observed) === p.targetState ? true : null;
				const readback: Readback = { observed, checkedAt: new Date().toISOString() };
				if (done || !fresh || n === 5) return { done, readback };
			}
			return { done: null, readback: { reason: "未读到目标状态" } };
		},
		after: (sql, p) => refreshConfirmedStatus(sql, p),
	};
}
export const CATALOG_STATUS_WRITES = { [STATUS_OP]: writeOp(statusWrite()) };

export async function replayStatus(sql: Sql, p: StatusInput): Promise<Outcome> {
	paramsOf(await intentOf(sql, p), p);
	const rows = await sql<{ id: string; batch: string; op: string; display: string; status: string; why: string | null }[]>`
		select id::text, batch::text, op, display, status, error as why from writes where op = ${STATUS_OP} and key = ${keyOf(p.requestId)} order by id`;
	if (!rows.length) return { ran: [], unknown: true, blocked: "请求已确认但还没有写入记录；未再次提交，请查看状态或人工核对" };
	const ran: Ran[] = rows.map((r) => ({ ...r, id: WriteId.parse(r.id), why: r.why ?? undefined }));
	return { ran, unknown: rows.some((r) => ["待执行", "已提交", "结果未知", "不一致"].includes(r.status)), blocked: null };
}
export async function readStatusResult(sql: Sql, p: Reference) {
	const intent = await intentOf(sql, p);
	const [row] = await sql<
		{ status: string; error: string | null }[]
	>`select status, error from writes where op = ${STATUS_OP} and key = ${keyOf(p.requestId)} order by id desc limit 1`;
	const statusChange: StatusChange = {
		requestId: p.requestId,
		targetState: intent.input.targetState,
		status: row?.status ?? (intent.claimed ? "未提交" : "待确认"),
		error: row?.error ?? (intent.claimed && !row ? "请求已确认但尚无写入记录；不会自动重发" : null),
	};
	return { shop: p.shop, shopId: intent.expected.shopId, productId: p.productId, statusChange };
}
export async function statusChanges(sql: Sql, shop: string, shopId: string, ids: string[]) {
	if (!ids.length) return new Map<string, StatusChange>();
	const rows = await sql<(StatusChange & { productId: string })[]>`
		select distinct on (i.product_id) i.product_id as "productId", i.request_id as "requestId", i.target_state as "targetState",
			coalesce(w.status, '未提交') as status, coalesce(w.error, case when w.status is null then '请求已确认但尚无写入记录；不会自动重发' end) as error
		from catalog_status_intents i left join lateral
			(select status, error from writes where op = ${STATUS_OP} and key = 'catalog-status:' || i.request_id order by id desc limit 1) w on true
		where i.shop = ${shop} and i.shop_id = ${shopId} and i.product_id in ${sql(ids)} and i.claimed
		order by i.product_id, i.created_at desc, i.request_id`;
	return new Map(rows.map(({ productId: id, ...change }) => [id, change]));
}

export async function refreshConfirmedStatus(sql: Sql, p: StatusParams) {
	const [row] = await sql<{ id: string; readback: { after?: Readback } | null }[]>`select id::text, readback from writes
		where op = ${STATUS_OP} and key = ${keyOf(p.requestId)} and status = '已核对' order by id desc limit 1`;
	const after = row?.readback?.after;
	const observed = after?.observed;
	if (!row || !after || !observed || observed.shopId !== p.expected.shopId || stateOf(observed) !== p.targetState)
		throw new Usage("缺少已核对的目标状态，未更新 Catalog");
	const checkedAt = new Date(after.checkedAt);
	if (!Number.isFinite(checkedAt.getTime())) throw new Usage("缺少有效的状态核对时间，未更新 Catalog");
	await sql.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(hashtext('x2 catalog'), hashtext(${p.shop}))`;
		if ((await configured(tx as unknown as Sql, p.shop)) !== p.expected.shopId) throw new Usage("店铺配置已变化，未更新旧店铺 Catalog");
		if ((await productWrites(tx as unknown as Sql, p)).some((w) => w.status === "已核对" && BigInt(w.id) > BigInt(row.id))) return;
		const [current] = await tx<{ facts: ProductFact; revision: string }[]>`select p.facts, p.revision from catalog_products p join catalog_heads h
			on h.shop = p.shop and h.shop_id = p.shop_id and h.revision = p.revision
			join catalog_syncs b on b.id = p.revision
			where p.shop = ${p.shop} and p.shop_id = ${p.expected.shopId} and p.product_id = ${p.productId}
			and b.started_at <= ${checkedAt} for update of p`;
		if (!current) return;
		const status = p.targetState === "listed" ? 1 : 8;
		const facts = { ...current.facts, status, statusLabel: STATUS[status]!, reportedStatus: observed.status, unlisted: observed.unlisted };
		await tx`update catalog_products set status = ${status}, status_label = ${facts.statusLabel}, facts = ${tx.json(facts as Json)}
			where shop = ${p.shop} and shop_id = ${p.expected.shopId} and revision = ${current.revision} and product_id = ${p.productId}`;
	});
}
export async function reconcileStatus(sql: Sql, p: Reference, driver: StatusDriver = statusDriver) {
	return exclusive(sql, async (lock) => {
		const intent = await intentOf(sql, p);
		const [row] = await sql<WriteRow[]>`select id::text, params, status, error, readback from writes
			where op = ${STATUS_OP} and key = ${keyOf(p.requestId)} order by id desc limit 1`;
		if (!row || !["已提交", "结果未知", "不一致"].includes(row.status)) {
			// 已完成的是历史操作结果；旧证据不能覆盖后续操作或新快照的状态。
			return readStatusResult(sql, p);
		}
		const frozen = paramsOf(intent, intent.input);
		if (!sameStatusInput(row.params, frozen) || row.params.fingerprint !== frozen.fingerprint) throw new Usage("写入记录与冻结请求不一致，未核对");
		const op = statusWrite(driver);
		const check = await op.where(sql, row.params, () => op.check(row.params, row.readback?.before, false));
		const updated = await sql`update writes set status = ${check.done === true ? "已核对" : "结果未知"},
			error = ${check.done === true ? null : "未读到可确认的目标状态；没有重新提交"},
			readback = ${sql.json({ before: row.readback?.before, after: check.readback } as Json)}, finished_at = now()
			where id = ${row.id} and status in ('已提交', '结果未知', '不一致')
			and exists (select 1 from pg_locks where pid = ${lock} and locktype = 'advisory' and classid = 2 and objid = 1 and objsubid = 2 and granted) returning id`;
		if (!updated.length) throw new Usage("核对锁或写入状态已改变，未更新结果，请重新核对");
		if (check.done === true) await refreshConfirmedStatus(sql, row.params);
		return readStatusResult(sql, p);
	});
}
