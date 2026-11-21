// Catalog 上下架的身份、精确确认、并发幂等和未知结果核对测试；只用内存DB和网站fixture。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProductInfo } from "../../connectors/sites/shopee/products.ts";
import { ItemId } from "../../connectors/sites/shopee/seller.ts";
import type { Sql } from "../../platform/db/index.ts";
import type { ProductFact } from "./facts.ts";
import {
	planStatus,
	previewStatus,
	readStatusResult,
	reconcileStatus,
	replayStatus,
	STATUS_OP,
	type StatusDriver,
	type StatusExpected,
	type StatusInput,
	type StatusParams,
	statusFingerprint,
	statusInput,
	statusTried,
	statusWrite,
} from "./status.ts";

const input: StatusInput = {
	shop: "ni1206",
	productId: ItemId.parse("42"),
	targetState: "unlisted",
	requestId: "11111111-1111-4111-8111-111111111111",
};
const expected: StatusExpected = { shopId: "77", name: "商品甲", parentSku: "sku-42", status: 1, unlisted: false };
const original: ProductFact = {
	productId: "42",
	name: "商品甲",
	parentSku: "sku-42",
	cover: null,
	status: 1,
	reportedStatus: 1,
	statusLabel: "在售",
	unlisted: false,
	models: [{ modelId: "100", sku: "one", name: "红", price: 199, stock: 0, tierIndex: [0] }],
	priceMin: 199,
	priceMax: 199,
	stockTotal: 0,
	stockState: "sold_out",
	detailError: null,
};
type Intent = { input: StatusInput; expected: StatusExpected; fingerprint: string; claimed: boolean; started: boolean; created_at: Date };
type FixtureWrite = {
	id: string;
	batch: string;
	op: string;
	display: string;
	key: string;
	target: string;
	params: StatusParams;
	status: string;
	error: string | null;
	readback: { before?: StatusExpected; after?: unknown } | null;
};
function fixture() {
	const intents = new Map<string, Intent>();
	const writes: FixtureWrite[] = [];
	const history: { id: string; key: string; op: string; target: string; status: string; params: Record<string, unknown>; productId?: string }[] = [];
	let fact = structuredClone(original),
		revision = "rev-1",
		startedAt = new Date("2000-01-01T00:00:00.000Z"),
		serial: Promise<unknown> = Promise.resolve(),
		submitted = 0;
	let info: ProductInfo = { id: "42", name: expected.name, parent_sku: expected.parentSku, status: 1, is_unlisted: false, first_publish_time: 1700000000 };
	let actualIdentity = { shopId: "77", username: "ni1206" };
	const run = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
		const q = strings.join("?").replace(/\s+/g, " ").trim();
		if (q.startsWith("select shop_id from shop_settings")) return values[0] === "ni1206" ? [{ shop_id: "77" }] : [];
		if (q.startsWith("select p.facts, p.revision")) {
			if (values[0] !== "ni1206" || values[1] !== "77" || values[2] !== "42") return [];
			if (q.includes("b.started_at <=")) {
				if (startedAt > (values[3] as Date)) return [];
			}
			return [{ facts: structuredClone(fact), revision }];
		}
		if (q.startsWith("select w.id::text, w.key, w.status from writes w")) {
			assert.match(q, /w\.params->'expected'->>'shopId'/);
			assert.match(q, /known\.product_id is null and w\.target/);
			const [, catalogOp, shopId, id, listingShopId, listingId, legacyTarget] = values;
			return [...writes, ...history].filter((w) => {
				const params: Record<string, unknown> = w.params;
				if (w.op === catalogOp) return (params.expected as StatusExpected).shopId === shopId && params.productId === id;
				if (!["建商品", "上架", "下架", "追加尺寸"].includes(w.op) || params.shopId !== listingShopId) return false;
				const known = params.productId || (w.op === "追加尺寸" ? params.id : undefined) || ("productId" in w ? w.productId : undefined);
				return known ? known === listingId : w.target === legacyTarget;
			});
		}
		if (q.startsWith("insert into catalog_status_intents")) {
			const id = String(values[0]);
			if (!intents.has(id))
				intents.set(id, {
					input: structuredClone(values[5]) as StatusInput,
					expected: structuredClone(values[6]) as StatusExpected,
					fingerprint: String(values[7]),
					claimed: false,
					started: false,
					created_at: new Date(),
				});
			return [];
		}
		if (q.startsWith("select input, expected, fingerprint")) {
			const old = intents.get(String(values[0]));
			if (values.length > 1 && (old?.input.shop !== values[1] || old?.input.productId !== values[2])) return [];
			return old ? [old] : [];
		}
		if (q.startsWith("update catalog_status_intents set claimed")) {
			intents.get(String(values[0]))!.claimed = true;
			return [];
		}
		if (q.startsWith("update catalog_status_intents set submission_started")) {
			const old = intents.get(String(values[0]));
			if (!old?.claimed || old.started) return [];
			old.started = true;
			return [{ request_id: values[0] }];
		}
		if (q.startsWith("select 1 from writes"))
			return writes.some((w) => w.op === values[0] && w.status === "已核对" && w.params.targetState === values[1]) ? [{ exists: 1 }] : [];
		if (q.startsWith("select status, error from writes")) return writes.filter((w) => w.op === values[0] && w.key === values[1]).slice(-1);
		if (q.startsWith("select id::text, params, status")) return writes.filter((w) => w.op === values[0] && w.key === values[1]).slice(-1);
		if (q.startsWith("select id::text, batch::text"))
			return writes.filter((w) => w.op === values[0] && w.key === values[1]).map((w) => ({ ...w, why: w.error }));
		if (q.startsWith("select id::text, readback from writes"))
			return writes.filter((w) => w.op === values[0] && w.key === values[1] && w.status === "已核对").slice(-1);
		if (q.startsWith("update writes set status")) {
			const row = writes.find((w) => w.id === values[3]);
			if (!row || values[4] !== 123 || !["已提交", "结果未知", "不一致"].includes(row.status)) return [];
			row.status = String(values[0]);
			row.error = values[1] as string | null;
			row.readback = values[2] as FixtureWrite["readback"];
			return [{ id: row.id }];
		}
		if (q.startsWith("update catalog_products set status")) {
			assert.deepEqual(values.slice(3), ["ni1206", "77", revision, "42"]);
			fact = structuredClone(values[2]) as ProductFact;
			return [];
		}
		if (q.startsWith("select pg_backend_pid()")) return [{ pid: 123 }];
		if (q.startsWith("select pg_try_advisory_lock") || q === "select ? as ok") return [{ ok: true }];
		if (q.startsWith("exists (select 1 from pg_locks") || q.startsWith("select pg_advisory_")) return [];
		throw new Error(`未声明的fixture查询：${q}`);
	};
	const sql = Object.assign(run, {
		json: (v: unknown) => v,
		begin: (fn: (tx: Sql) => Promise<unknown>) => {
			const next = serial.then(() => fn(sql as unknown as Sql));
			serial = next.catch(() => {});
			return next;
		},
		reserve: async () => sql,
		release: () => {},
	});
	const driver: StatusDriver = {
		where: (_shopId, fn) => fn(),
		identity: async () => actualIdentity,
		detail: async () => structuredClone(info),
		submit: async (p) => {
			submitted++;
			// 网站下架后可暂时继续返回 status=1，is_unlisted=true 才是明确下架证据。
			info = { ...info, status: 1, is_unlisted: p.targetState === "unlisted" };
			return { kind: "done" };
		},
		wait: async () => {},
	};
	return {
		sql: sql as unknown as Sql,
		driver,
		intents,
		writes,
		history,
		fact: () => fact,
		submitted: () => submitted,
		setInfo: (v: Partial<ProductInfo>) => {
			info = { ...info, ...v };
		},
		setIdentity: (v: typeof actualIdentity) => {
			actualIdentity = v;
		},
		sync: (fresh: ProductFact, start: Date) => {
			fact = structuredClone(fresh);
			revision = "rev-new";
			startedAt = start;
		},
		write: (params: StatusParams, status: string, readback: FixtureWrite["readback"] = { before: expected }) => {
			const w: FixtureWrite = {
				id: String(writes.length + 1),
				batch: "1",
				op: STATUS_OP,
				key: `catalog-status:${params.requestId}`,
				target: `shopee:${params.expected.shopId}:${params.expected.parentSku || params.productId}`,
				params,
				status,
				error: null,
				readback,
				display: "fixture",
			};
			writes.push(w);
			return w;
		},
	};
}
async function confirmed(f: ReturnType<typeof fixture>, p = input): Promise<StatusParams> {
	await previewStatus(f.sql, p, f.driver);
	return (await planStatus(f.sql, p))[0]![0]!.params as StatusParams;
}

test("状态修改必须明确商品、方向和 requestId，拒绝精度丢失及任意目标状态", () => {
	assert.equal(statusInput.safeParse(input).success, true);
	for (const bad of [
		{ ...input, requestId: undefined },
		{ ...input, targetState: "deleted" },
		{ ...input, productId: "9007199254740993" },
	])
		assert.equal(statusInput.safeParse(bad).success, false);
});
test("预览只允许明确在售和下架，不把禁卖、审核、删除、未知或矛盾字段当成可切换状态", async () => {
	for (const fields of [{ status: 3 }, { status: 4 }, { status: 0 }, { status: null }, { status: 8, is_unlisted: false }, { is_unlisted: null }]) {
		const f = fixture();
		f.setInfo(fields);
		await assert.rejects(previewStatus(f.sql, input, f.driver));
		assert.equal(f.submitted(), 0);
	}
	const f = fixture();
	await assert.rejects(previewStatus(f.sql, { ...input, targetState: "listed" }, f.driver), /已经是目标状态/);
});
test("精确预览包含店铺商品和方向，冻结后商品变化不能复用 requestId", async () => {
	const f = fixture();
	const preview = await previewStatus(f.sql, input, f.driver);
	assert.deepEqual(preview.params, input);
	assert.match(preview.display, /ni1206.*77/);
	assert.match(preview.display, /42「商品甲」/);
	assert.match(preview.display, /在售 → 下架/);
	assert.equal(preview.trialRequired, true);
	f.setInfo({ name: "商品乙" });
	await assert.rejects(previewStatus(f.sql, input, f.driver), /已冻结/);
	assert.equal(f.submitted(), 0);
});
test("未预览不能执行；并发和重复确认只产生一份计划，换目标不能重用 requestId", async () => {
	const f = fixture();
	await assert.rejects(planStatus(f.sql, input), /先预览/);
	await previewStatus(f.sql, input, f.driver);
	const plans = await Promise.all([planStatus(f.sql, input), planStatus(f.sql, input)]);
	assert.equal(plans.filter((p) => p.length === 1).length, 1);
	assert.deepEqual(await planStatus(f.sql, input), []);
	await assert.rejects(planStatus(f.sql, { ...input, targetState: "listed" }), /已绑定不同/);
	const replay = await replayStatus(f.sql, input);
	assert.equal(replay.unknown, true);
	assert.equal(f.submitted(), 0);
});
test("超过确认时限的预览不可执行，不借重新预览延长旧 requestId", async () => {
	const f = fixture();
	await previewStatus(f.sql, input, f.driver);
	f.intents.get(input.requestId)!.created_at = new Date(Date.now() - 11 * 60_000);
	await assert.rejects(planStatus(f.sql, input), /预览已过期/);
	await assert.rejects(previewStatus(f.sql, input, f.driver), /预览已过期/);
});
test("确认后账号、名称、SKU 或状态变化都挡住提交；不把过时预览当授权", async () => {
	for (const field of [{ name: "新名称" }, { parent_sku: "new" }, { is_unlisted: true }]) {
		const f = fixture();
		const p = await confirmed(f);
		f.setInfo(field);
		await assert.rejects(statusWrite(f.driver).prepare(f.sql, p), /已改变/);
		assert.equal(f.intents.get(input.requestId)!.started, false);
		assert.equal(f.submitted(), 0);
	}
	const f = fixture();
	const p = await confirmed(f);
	f.setIdentity({ shopId: "other", username: "ni1206" });
	await assert.rejects(statusWrite(f.driver).prepare(f.sql, p), /身份不匹配/);
});
test("Catalog target 按店铺和商品 id 固定，不随 SKU 改名而改变", async () => {
	const f = fixture();
	const p = await confirmed(f);
	const op = statusWrite(f.driver);
	assert.equal(op.target(p), "shopee:77:product:42");
	assert.equal(op.target({ ...p, expected: { ...p.expected, parentSku: "renamed" } }), op.target(p));
});
test("旧 SKU target 的未知请求在商品 SKU 改名后仍阻止新 requestId", async () => {
	const f = fixture();
	const p = await confirmed(f);
	f.write(p, "结果未知");
	f.setInfo({ parent_sku: "renamed" });
	await assert.rejects(previewStatus(f.sql, { ...input, requestId: "22222222-2222-4222-8222-222222222222" }, f.driver), /没核清/);
	assert.equal(f.submitted(), 0);
});
test("预览后才出现的旧未知请求仍在 prepare 阻断，不领取提交", async () => {
	const f = fixture();
	const old = await confirmed(f);
	const p = await confirmed(f, { ...input, requestId: "22222222-2222-4222-8222-222222222222" });
	f.write(old, "结果未知");
	await assert.rejects(statusWrite(f.driver).prepare(f.sql, p), /没核清/);
	assert.equal(f.intents.get(p.requestId)!.started, false);
	assert.equal(f.submitted(), 0);
});
test("Catalog 兼容 listing 商品 id、追加尺寸 id 和尚无商品 id 的建商品 SKU 历史", async () => {
	for (const params of [
		{ op: "下架", productId: "42", parentSku: "old-sku" },
		{ op: "追加尺寸", id: "42", parentSku: "old-sku" },
		{ op: "建商品", listingId: 1, parentSku: "sku-42", knownProductId: "42" },
		{ op: "建商品", parentSku: "sku-42" },
	]) {
		const f = fixture();
		f.history.push({
			id: "9",
			key: "listing-old",
			op: params.op,
			target: `shopee:77:${params.parentSku}`,
			status: "结果未知",
			params: { shopId: "77", ...params },
			productId: "knownProductId" in params ? params.knownProductId : undefined,
		});
		await assert.rejects(previewStatus(f.sql, input, f.driver), /没核清/);
		assert.equal(f.submitted(), 0);
	}
});
test("其他店铺、其他商品及已核清记录不阻断；同 SKU 但已知不同商品也不误挡", async () => {
	for (const change of [{ status: "已核对" }, { status: "被拒" }, { status: "未执行" }, { productId: "43" }, { shopId: "78" }]) {
		const f = fixture();
		const old = await confirmed(f);
		f.write(
			{ ...old, productId: ItemId.parse(change.productId ?? "42"), expected: { ...old.expected, shopId: change.shopId ?? "77" } },
			change.status ?? "结果未知",
		);
		await previewStatus(f.sql, { ...input, requestId: "22222222-2222-4222-8222-222222222222" }, f.driver);
	}
	const f = fixture();
	f.history.push({ id: "9", key: "other-product", op: "下架", target: "shopee:77:sku-42", status: "结果未知", params: { shopId: "77", productId: "43" } });
	await previewStatus(f.sql, input, f.driver);
});
test("准备阶段只领取一次，提交后 status=1/unlisted=true 也能确认下架且只更新当前商品状态", async () => {
	const f = fixture();
	const p = await confirmed(f);
	const op = statusWrite(f.driver);
	assert.equal(op.target(p), "shopee:77:product:42");
	const prepared = await op.prepare(f.sql, p);
	assert.ok("before" in prepared);
	assert.ok("skip" in (await op.prepare(f.sql, p)));
	await op.submit(f.sql, p);
	const check = await op.check(p, prepared.before, true);
	assert.equal(check.done, true);
	const row = f.write(p, "已核对", { before: prepared.before, after: check.readback });
	await op.after!(f.sql, p);
	assert.equal(f.fact().status, 8);
	assert.equal(f.fact().unlisted, true);
	assert.deepEqual(f.fact().models, original.models);
	assert.equal(f.fact().priceMin, 199);
	assert.equal(f.fact().stockTotal, 0);
	const replay = await replayStatus(f.sql, input);
	assert.equal(replay.ran[0]?.id, row.id);
	assert.equal(replay.unknown, false);
	assert.equal(f.submitted(), 1);
});
test("上架操作使用原商品；两个方向分别按已核对记录解除首次试跑提示", async () => {
	const f = fixture();
	const p = await confirmed(f);
	f.write(p, "被拒");
	assert.equal(await statusTried(f.sql, "unlisted"), false);
	f.write(p, "已核对");
	assert.equal(await statusTried(f.sql, "unlisted"), true);
	assert.equal(await statusTried(f.sql, "listed"), false);
	f.setInfo({ status: 8, is_unlisted: true });
	const relist: StatusInput = { ...input, targetState: "listed", requestId: "22222222-2222-4222-8222-222222222222" };
	const r = await confirmed(f, relist);
	const op = statusWrite(f.driver);
	const before = await op.prepare(f.sql, r);
	assert.ok("before" in before);
	await op.submit(f.sql, r);
	assert.equal((await op.check(r, before.before, true)).done, true);
	assert.equal(r.productId, input.productId);
});
test("Catalog 的首次上架也要求从商品读取最终图片结论", async () => {
	const f = fixture();
	f.setInfo({ status: 8, is_unlisted: true, first_publish_time: 0 });
	const p = await confirmed(f, { ...input, targetState: "listed" });
	await assert.rejects(statusWrite(f.driver).prepare(f.sql, p), /图片语言审阅：未读取到最终主图/);
	assert.equal(f.submitted(), 0);
});
test("没有提交前证据或未读到目标时保持未知，核对不调用 submit，读到目标后更新保存状态", async () => {
	const f = fixture();
	const p = await confirmed(f);
	const op = statusWrite(f.driver);
	assert.equal((await op.check(p, undefined, false)).done, null);
	assert.equal((await op.check(p, expected, false)).done, null);
	f.write(p, "结果未知", { before: expected });
	const unknown = await reconcileStatus(f.sql, input, f.driver);
	assert.equal(unknown.statusChange.status, "结果未知");
	assert.equal(f.fact().status, 1);
	f.setInfo({ is_unlisted: true });
	const done = await reconcileStatus(f.sql, input, f.driver);
	assert.equal(done.statusChange.status, "已核对");
	assert.equal(done.statusChange.error, null);
	assert.equal(f.fact().status, 8);
	assert.equal(f.submitted(), 0);
	assert.deepEqual((await readStatusResult(f.sql, input)).statusChange, done.statusChange);
});
test("冻结指纹覆盖原生状态、SKU 和身份；返回错商品不能通过预览", async () => {
	assert.notEqual(statusFingerprint(input, expected), statusFingerprint(input, { ...expected, shopId: "78" }));
	assert.notEqual(statusFingerprint(input, expected), statusFingerprint(input, { ...expected, parentSku: "other" }));
	const f = fixture();
	f.setInfo({ id: "other-product" });
	await assert.rejects(previewStatus(f.sql, input, f.driver), /商品编号不匹配/);
});

async function complete(f: ReturnType<typeof fixture>, p: StatusInput) {
	const params = await confirmed(f, p);
	const op = statusWrite(f.driver);
	const before = await op.prepare(f.sql, params);
	assert.ok("before" in before);
	await op.submit(f.sql, params);
	const checked = await op.check(params, before.before, true);
	assert.equal(checked.done, true);
	f.write(params, "已核对", { before: before.before, after: checked.readback });
	await op.after!(f.sql, params);
	return { params, op };
}
test("下架A再上架B后，重复核对、回放或缓存恢复A均不把B状态改回下架", async () => {
	const f = fixture();
	const a = await complete(f, input);
	assert.equal(f.fact().status, 8);
	await complete(f, { ...input, targetState: "listed", requestId: "22222222-2222-4222-8222-222222222222" });
	assert.equal(f.fact().status, 1);
	assert.equal((await reconcileStatus(f.sql, input, f.driver)).statusChange.status, "已核对");
	assert.equal(f.fact().status, 1);
	assert.equal((await replayStatus(f.sql, input)).unknown, false);
	await a.op.after!(f.sql, a.params);
	assert.equal(f.fact().status, 1);
	assert.equal(f.fact().unlisted, false);
	assert.equal(f.submitted(), 2);
});
test("旧 SKU 和新稳定 target 的后续已核对操作都阻止旧缓存回写，SKU 改名也不能覆盖", async () => {
	for (const target of ["shopee:77:renamed", "shopee:77:product:42"]) {
		const f = fixture();
		const a = await complete(f, input);
		f.setInfo({ parent_sku: "renamed" });
		const b = await complete(f, { ...input, targetState: "listed", requestId: "22222222-2222-4222-8222-222222222222" });
		f.writes.at(-1)!.target = target;
		await a.op.after!(f.sql, a.params);
		assert.equal(f.fact().status, 1);
		assert.notEqual(a.params.expected.parentSku, b.params.expected.parentSku);
	}
});
test("全店新快照开始于旧操作回读后，重放或旧缓存恢复不得覆盖新快照", async () => {
	const f = fixture();
	const a = await complete(f, input);
	const at = new Date(Date.now() + 1000);
	f.sync({ ...original, stockTotal: 9 }, at);
	await replayStatus(f.sql, input);
	await reconcileStatus(f.sql, input, f.driver);
	await a.op.after!(f.sql, a.params);
	assert.equal(f.fact().status, 1);
	assert.equal(f.fact().stockTotal, 9);
	assert.equal(f.submitted(), 1);
});
test("先开始的全店采集可能在操作后发布旧状态，已核对操作仍能修正重叠批次", async () => {
	const f = fixture();
	const batchStarted = new Date(Date.now() - 1000);
	const a = await complete(f, input);
	assert.equal(f.fact().status, 8);
	// 该批次在下架前读取商品，在下架已核对后才发布，结束时间不能代表商品状态的新旧。
	f.sync(original, batchStarted);
	assert.equal(f.fact().status, 1);
	await a.op.after!(f.sql, a.params);
	assert.equal(f.fact().status, 8);
	assert.equal(f.fact().unlisted, true);
	assert.equal(f.submitted(), 1);
});
