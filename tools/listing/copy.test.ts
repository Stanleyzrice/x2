// 跨店复制保留人工规格，目标图片必须有独立上传记录。
import assert from "node:assert/strict";
import { test } from "node:test";
import { OfferId, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import type { Sql } from "../../platform/db/index.ts";
import { COPY_IMAGES_PENDING, copiedImageIds, copyDraft, copyDraftFields, copyImages, copyParams, originalCopyPlan } from "./copy.ts";
import { listing } from "./index.ts";
import type { Pic, Pics } from "./pics.ts";
import { ListingId, type ListingRow } from "./row.ts";
import type { Specs } from "./variants.ts";

const shaA = "a".repeat(64),
	shaB = "b".repeat(64);
const sourceShop = { shop: "ni1206", shop_id: "348425", min_purchase: 1 };
const targetShop = { shop: "cheeroutdoor", shop_id: "1554182542", min_purchase: 3 };
const params = copyParams.parse({ id: "87", shop: "cheeroutdoor", why: "用户指定同步", evidence: "用户授权本批已上架清单" });

function source(): ListingRow {
	const pics = (from: string, sha: string, imageId: string): Pic => ({ from, sha, imageId, final: sha, width: 800, height: 800 });
	const variants: Specs = {
		tiers: [
			{
				source: "颜色",
				name: "款式",
				options: [
					{ source: "花卉", name: "花卉人工名稱", image: "https://source/a.jpg" },
					{ source: "条纹", name: "條紋", image: "https://source/b.jpg" },
				],
			},
		],
		variants: [
			{
				sku: "LT991756966145-a",
				skuId: SkuId.parse("123"),
				specId: SpecId.parse("a"),
				options: [0],
				costRmb: 8.5,
				stock: 50,
				weightKg: 0.6,
				priceTwd: 149,
				pricingInput: { costRmb: 8.5, chargeableWeightKg: 0.6, priceTwd: 149, freightRmbPerUnit: 3, sourceEvidence: "单件渠道、每单位国内运费3元" },
			},
			{ sku: "LT991756966145-b", skuId: SkuId.parse("124"), specId: SpecId.parse("b"), options: [1], costRmb: 10, stock: 50, weightKg: 0.7, priceTwd: 169 },
		],
	};
	return {
		id: ListingId.parse("87"),
		shop: "ni1206",
		offer_id: OfferId.parse("991756966145"),
		strategy: "人选",
		cancelled: false,
		weight_kg: "0.6",
		weight_override: false,
		freight_rmb: "6",
		min_purchase: 2,
		title: "花卉抱枕套 兩件起",
		description: "人工確認的敘述。",
		note: "人工备注",
		noted: "人工备注",
		nickname: "花卉抱枕套",
		offer: {
			offerId: OfferId.parse("991756966145"),
			url: "https://detail.1688.com/offer/991756966145.html",
			title: "源标题",
			image: "https://source/a.jpg",
			unit: "只",
			minQty: 2,
			props: [],
			skus: [],
			tags: { onePsale: true, freeShipping: false, ship48h: true, deliveryDays: 2 },
		},
		offer_read_at: new Date(0),
		category_id: "101166",
		category_path: [100636, 101166],
		category_name: "抱枕、靠墊",
		attributes: [],
		attributes_text: "材质冲突已注明",
		days_to_ship: 10,
		variants,
		images: {
			imageMode: "original",
			main: [pics("https://source/b.jpg", shaB, "ni-b"), pics("https://source/a.jpg", shaA, "ni-a")],
			detail: [pics("https://source/a.jpg", shaA, "ni-a")],
			options: [pics("https://source/a.jpg", shaA, "ni-a"), pics("https://source/b.jpg", shaB, "ni-b")],
		},
		pricing: { model: "template", params: { fx: 4.8 }, freightRmb: 6 },
		audit: { key: "source-audit" },
		problems: "人工问题保留",
		step: "已上架",
		step_detail: "源状态",
		product_id: "123456789",
		listed_at: new Date(1),
		removed_images: [],
		removed_variants: ["LT991756966145-removed"],
		kept_images: ["ni-a", "ni-b"],
		pick_why: "源理由",
		pick_evidence: "源依据",
		pick_snapshot: { original: "source" },
		created_at: new Date(0),
		updated_at: new Date(1),
	};
}

function target(): ListingRow {
	const s = source();
	return { ...s, ...copyDraftFields(s, sourceShop, params), id: ListingId.parse("91"), created_at: new Date(2), updated_at: new Date(2) };
}

function uploaded(plan: Partial<Pics>): Pics {
	const role = (pics: Pic[] = []) => pics.map((p) => ({ ...p, imageId: `target-${p.sha}`, final: p.sha }));
	return { imageMode: "original", main: role(plan.main), detail: role(plan.detail), options: role(plan.options) };
}

type Query = { text: string; values: unknown[] };
/** 记录SQL语句并返回固定结果；不连接数据库，也不在stub重做生产判断。 */
function store(reply: (q: Query) => unknown[]) {
	const queries: Query[] = [];
	let transactions = 0;
	const tagged = (first: TemplateStringsArray | Record<string, unknown>, ...values: unknown[]) => {
		if (!Array.isArray(first)) return first;
		const q = { text: first.join("?").replace(/\s+/g, " ").trim(), values };
		queries.push(q);
		return Promise.resolve(reply(q));
	};
	const sql = Object.assign(tagged, {
		json: (v: unknown) => v,
		begin: async (fn: (tx: Sql) => Promise<unknown>) => {
			transactions++;
			return fn(tagged as unknown as Sql);
		},
	}) as unknown as Sql;
	return { sql, queries, transactions: () => transactions };
}

test("listing 暴露独立的本地 copy 与目标店 copy-images 工具", () => {
	assert.ok(listing.tools.copy, "不能通过重新 make 重建人工规格来复制");
	assert.ok(listing.tools["copy-images"], "目标店图片上传必须能独立执行");
});

test("复制精确保留规格、pricingInput、源事实和有效起购量，清除源站点与图片身份，源稿不变", () => {
	const s = source(),
		before = structuredClone(s);
	const out = copyDraftFields(s, sourceShop, params);
	for (const key of [
		"offer",
		"variants",
		"removed_variants",
		"attributes",
		"category_path",
		"days_to_ship",
		"weight_kg",
		"freight_rmb",
		"pricing",
		"pick_snapshot",
		"note",
		"noted",
	] as const)
		assert.deepEqual(out[key], s[key], key);
	assert.equal(out.min_purchase, 2);
	assert.equal(out.product_id, null);
	assert.equal(out.listed_at, null);
	assert.equal(out.audit, null);
	assert.equal(out.step, null);
	assert.equal(out.step_detail, null);
	assert.deepEqual(out.kept_images, []);
	assert.deepEqual(out.removed_images, []);
	assert.equal(out.problems, `人工问题保留\n${COPY_IMAGES_PENDING}`);
	assert.match(out.pick_evidence, /源依据\nlisting copy：源稿 #87.*348425\/123456789.*用户授权本批已上架清单/s);
	assert.equal(out.pick_why, "源理由\n跨店复制：用户指定同步");
	assert.deepEqual(
		out.images.main.map((p) => p.from),
		["https://source/b.jpg", "https://source/a.jpg"],
	);
	for (const p of [...out.images.main, ...out.images.detail, ...out.images.options])
		assert.deepEqual(Object.keys(p).sort(), ["from", "height", "sha", "width"]);
	assert.deepEqual(s, before);
	assert.notEqual(out.variants, s.variants);
});

test("显式weight_override true/false原样保留，旧快照缺列不捏造；起购空值固定源店有效值", () => {
	for (const flag of [true, false]) assert.equal(copyDraftFields({ ...source(), weight_override: flag }, sourceShop, params).weight_override, flag);
	const old = source();
	delete old.weight_override;
	old.min_purchase = null;
	const out = copyDraftFields(old, sourceShop, params);
	assert.equal("weight_override" in out, false);
	assert.equal(out.min_purchase, 1, "不沿用目标店的默认3件");
	assert.throws(() => copyDraftFields(source(), sourceShop, { ...params, shop: "ni1206" }), /相同/);
});

test("原图计划使用有效角色与原序，缺SHA/选项图/processed不能静默复制", () => {
	const s = source();
	assert.equal(originalCopyPlan(s).options.length, 2);
	for (const mutation of [
		(r: ListingRow) => {
			r.images.imageMode = "processed";
		},
		(r: ListingRow) => {
			delete r.images.main![0]!.sha;
		},
		(r: ListingRow) => {
			r.images.options!.pop();
		},
	]) {
		const r = structuredClone(s);
		mutation(r);
		assert.throws(() => originalCopyPlan(r));
	}
});

test("已存在目标稿立即返回且不INSERT/UPDATE；同店拒绝，不改源稿", async () => {
	const s = source();
	const db = store((q) => (q.text.includes("where id") ? [s] : q.text.includes("from shop_settings") ? [targetShop] : [{ id: "91" }]));
	assert.deepEqual(await copyDraft(db.sql, params), {
		id: "91",
		sourceId: "87",
		sourceShop: "ni1206",
		shop: "cheeroutdoor",
		offerId: "991756966145",
		isNew: false,
	});
	assert.equal(db.transactions(), 1);
	assert.equal(db.queries.length, 3);
	assert.ok(db.queries.every((q) => q.text.startsWith("select ")));
	const same = store(() => [s]);
	await assert.rejects(() => copyDraft(same.sql, { ...params, shop: "ni1206" }), /相同/);
	assert.equal(same.queries.length, 1);
});

test("新目标稿INSERT在事务内且冲突DO NOTHING，并发已存在时不覆盖", async () => {
	for (const race of [false, true]) {
		let targetReads = 0;
		const s = source(),
			before = structuredClone(s);
		const db = store((q) => {
			if (q.text.includes("where id")) return [s];
			if (q.text.includes("from shop_settings")) return [q.values[0] === "ni1206" ? sourceShop : targetShop];
			if (q.text.startsWith("insert ")) return race ? [] : [{ id: "91" }];
			return ++targetReads > 1 ? [{ id: "92" }] : [];
		});
		const result = await copyDraft(db.sql, params);
		assert.equal(result.id, race ? "92" : "91");
		assert.equal(result.isNew, !race);
		assert.equal(db.transactions(), 1);
		const insert = db.queries.find((q) => q.text.startsWith("insert "))!;
		assert.match(insert.text, /on conflict \(shop, offer_id\) do nothing returning id::text$/);
		const fields = insert.values[0] as ReturnType<typeof copyDraftFields>;
		assert.deepEqual(fields.variants, s.variants);
		assert.equal(fields.min_purchase, 2);
		assert.equal(fields.weight_override, false);
		assert.equal(fields.product_id, null);
		assert.equal(
			db.queries.some((q) => q.text.startsWith("update ")),
			false,
		);
		assert.deepEqual(s, before);
	}
});

test("目标图片按角色/from/SHA/原序核对，不能拿缺图或其他来源替代", () => {
	const plan = originalCopyPlan(source()),
		out = uploaded(plan);
	assert.deepEqual(copiedImageIds(plan, out), [`target-${shaB}`, `target-${shaA}`]);
	for (const mutation of [
		(p: Pics) => {
			p.main.reverse();
		},
		(p: Pics) => {
			p.main[0]!.sha = shaA;
		},
		(p: Pics) => {
			delete p.options[0]!.imageId;
		},
		(p: Pics) => {
			p.detail[0]!.final = "other";
		},
		(p: Pics) => {
			p.main[0]!.translated = "translated";
		},
		(p: Pics) => {
			p.options.pop();
		},
	]) {
		const r = structuredClone(out);
		mutation(r);
		assert.throws(() => copiedImageIds(plan, r), /不一致/);
	}
});

test("copy-images只传保存的原图URL和目标店，锁行后二次核对，仅清自己的pending问题", async () => {
	const row = target(),
		before = structuredClone(row);
	const fresh = { ...row, problems: `${COPY_IMAGES_PENDING}\n人工问题保留\n上传期间人新增的问题` };
	const db = store((q) =>
		q.text.includes("from shop_settings") ? [targetShop] : q.text.startsWith("select ") ? [q.text.includes("for update") ? fresh : row] : [],
	);
	let calls = 0;
	const result = await copyImages(db.sql, { id: row.id }, async (_sql, c) => {
		calls++;
		assert.equal(c.shop, "cheeroutdoor");
		assert.equal(c.imageMode, "original");
		assert.equal(c.mark, null);
		assert.deepEqual(
			c.main,
			row.images.main!.map((p) => p.from),
		);
		assert.deepEqual(
			c.options,
			row.images.options!.map((p) => p.from),
		);
		return uploaded(row.images);
	});
	assert.equal(calls, 1);
	assert.equal(db.transactions(), 1);
	assert.deepEqual(result.problems, ["人工问题保留", "上传期间人新增的问题"]);
	const update = db.queries.find((q) => q.text.startsWith("update "))!;
	assert.equal(update.text, "update listings set images = ?, kept_images = ?, audit = null, problems = ?, updated_at = now() where id = ?");
	assert.deepEqual(update.values, [uploaded(row.images), [`target-${shaB}`, `target-${shaA}`], "人工问题保留\n上传期间人新增的问题", row.id]);
	assert.deepEqual(row, before);
});

test("copy-images开始前和保存前拒绝已建/已上架稿；并发人工规格或图片选择变化不覆盖", async () => {
	for (const stage of ["before", "after"] as const)
		for (const patch of [
			{ product_id: "123" },
			{ listed_at: new Date(1) },
			...(stage === "after" ? [{ removed_images: ["manual"] }, { variants: { manual: true } }] : []),
		]) {
			const row = target();
			let calls = 0;
			const db = store((q) =>
				q.text.includes("from shop_settings") ? [targetShop] : [stage === "before" || q.text.includes("for update") ? { ...row, ...patch } : row],
			);
			await assert.rejects(() =>
				copyImages(db.sql, { id: row.id }, async () => {
					calls++;
					return uploaded(row.images);
				}),
			);
			assert.equal(calls, stage === "before" ? 0 : 1);
			assert.equal(
				db.queries.some((q) => q.text.startsWith("update ")),
				false,
			);
		}
});

test("copy-images成功重跑复用当前结果，不清目标已生成的audit或其他问题", async () => {
	const row = target();
	row.images = uploaded(row.images);
	row.kept_images = [`target-${shaB}`, `target-${shaA}`];
	row.problems = "人工问题保留";
	row.audit = { key: "target-audit" };
	const db = store((q) => (q.text.includes("from shop_settings") ? [targetShop] : [row]));
	const result = await copyImages(db.sql, { id: row.id }, async () => {
		assert.fail("没有自身pending时不能重新上传已有图片");
	});
	assert.equal(result.changed, false);
	assert.equal(
		db.queries.some((q) => q.text.startsWith("update ")),
		false,
	);
	assert.deepEqual(row.audit, { key: "target-audit" });
});

test("copy-images没有自身pending且缺上传记录时拒绝，不接管其他人工稿", async () => {
	const row = target();
	row.problems = "其他人工问题";
	const db = store(() => [row]);
	await assert.rejects(
		() =>
			copyImages(db.sql, { id: row.id }, async () => {
				assert.fail("不能上传其他稿");
			}),
		/不一致/,
	);
	assert.equal(db.queries.length, 1);
});
