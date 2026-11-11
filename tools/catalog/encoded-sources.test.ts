// 旧商品没有商品稿时，用真实1688规格重建商家SKU核对；不凭名称猜测或改变Shopee事实。
import assert from "node:assert/strict";
import { test } from "node:test";
import { Gone } from "../../connectors/sites/1688/api.ts";
import {
	type EncodedSourceOffer,
	type EncodedSourceSnapshot,
	encodedOfferIds,
	enrichEncodedProductSources,
	readEncodedSourceSnapshots,
} from "./encoded-sources.ts";
import type { ProductFact } from "./facts.ts";

const offerId = "1073693357356";
const offer: EncodedSourceOffer = {
	offerId,
	skus: [
		["6123318244840", "4cdec6f0ad00f078f929f99dcb1be792", "大象灰（小号）"],
		["6123318244841", "2c72e440c7cc431bd912d32f949bd0ae", "咖啡色（小号）"],
		["6123318244842", "d759583751dd2efb59992c7d7eb3ea2e", "黑色（小号）"],
		["6123318244843", "269aab93144b9d8901a73cfd7a86cd72", "焦糖色（小号）"],
		["6123318244844", "3afd71047917997a92d604713a2a432c", "大象灰（mini）"],
		["6123318244845", "3ef43d4e6c3a9301661254102c9f5d29", "咖啡色（mini）"],
		["6123318244846", "c596fc7aad0fd0652cec7e34c770d8d3", "黑色（mini）"],
		["6123318244847", "cec56beef40c1d52ed56b478cfe0166a", "焦糖色（mini）"],
	].map(([skuId, specId, name]) => ({ skuId: skuId!, specId: specId!, name: name!, image: "https://supplier.example/sku.jpg" })),
};
const fact: ProductFact = {
	productId: "46269129022",
	name: "植鞣真皮信使包",
	parentSku: `LT${offerId}`,
	cover: "https://shop.example/cover.jpg",
	status: 1,
	reportedStatus: 1,
	statusLabel: "在售",
	unlisted: false,
	models: offer.skus.map((sku, index) => ({
		modelId: String(278013275970 + index),
		sku: `LT${offerId}-${sku.specId}`.slice(0, 40),
		name: sku.name.replace(/[（）]/g, " ").trim(),
		price: 897,
		stock: index === 4 ? 49 : 50,
		tierIndex: [index],
		image: "https://shop.example/sku.jpg",
		source: null,
		sourceWarning: "未保存此商品的 SKU 货源对应",
	})),
	priceMin: 897,
	priceMax: 897,
	stockTotal: 399,
	stockState: "in_stock",
	detailError: null,
};
const readAt = new Date("2026-11-11T03:30:00.000Z");
const snapshot = (source: unknown = offer): EncodedSourceSnapshot => ({ offerId, offer: source, readAt, error: null });
const one = () => ({ ...structuredClone(fact), models: [structuredClone(fact.models![4]!)] });

test("旧商品8款完整重建截断货号核对，大象灰mini得到真实规格且Shopee事实不变", () => {
	const before = structuredClone(fact);
	assert.deepEqual(encodedOfferIds(fact), [offerId]);
	const result = enrichEncodedProductSources(fact, [snapshot()]);
	assert.equal(result.models?.length, 8);
	for (const [index, model] of result.models!.entries()) {
		assert.deepEqual(model.source, {
			offerId,
			skuId: offer.skus[index]!.skuId,
			specId: offer.skus[index]!.specId,
			name: offer.skus[index]!.name,
			image: offer.skus[index]!.image,
			url: `https://detail.1688.com/offer/${offerId}.html`,
			readAt: readAt.toISOString(),
			basis: "encoded_sku",
		});
		assert.equal(model.sourceWarning, null);
		assert.deepEqual({ ...model, source: null, sourceWarning: null }, { ...fact.models![index], source: null, sourceWarning: null });
	}
	assert.equal(result.models![4]!.source!.skuId, "6123318244844");
	assert.deepEqual(fact, before);
	assert.equal(result.stockTotal, 399);
});

test("仅两种missing提示可恢复，保留已有商品稿映射和冲突提示", () => {
	const current = one();
	current.models![0]!.source = {
		offerId: "999",
		skuId: "1",
		specId: "a",
		name: "已有来源",
		image: null,
		url: "https://detail.1688.com/offer/999.html",
		readAt: null,
		basis: "listing_sku",
	};
	assert.deepEqual(encodedOfferIds(current), []);
	assert.deepEqual(enrichEncodedProductSources(current, [snapshot()]), current);
	for (const warning of ["同一 SKU 存在多个货源对应，待核对", "1688 快照没有同时匹配 skuId 和 specId 的规格", null, undefined]) {
		const bad = one();
		bad.models![0]!.sourceWarning = warning;
		assert.deepEqual(encodedOfferIds(bad), []);
		assert.deepEqual(enrichEncodedProductSources(bad, [snapshot()]), bad);
	}
	const missing = one();
	missing.models![0]!.sourceWarning = "商品稿没有此 SKU 的货源对应";
	assert.equal(enrichEncodedProductSources(missing, [snapshot()]).models![0]!.source!.skuId, "6123318244844");
});

test("不接受坏格式、重复LT前缀、无SKU、短前缀或超过40字符的SKU", () => {
	for (const sku of [
		null,
		"",
		"1073693357356-3afd71047917997a92d60471",
		`LT${offerId}LT${offerId}-3afd71047917997a92d60471`,
		`LT${offerId}-`,
		`LT${offerId}-3afd`,
		`LT${offerId}-3afd71047917997a92d604713a2a432c`,
		` LT${offerId}-3afd71047917997a92d60471`,
	]) {
		const current = one();
		current.models![0]!.sku = sku;
		assert.equal(enrichEncodedProductSources(current, [snapshot()]).models![0]!.source, null);
	}
});

test("父SKU与规格来源冲突时不读站点，缺父SKU仍能以完整规格货号核对", () => {
	for (const parentSku of ["LT999", "OTHER", `LT${offerId} `]) {
		const current = { ...one(), parentSku };
		assert.deepEqual(encodedOfferIds(current), []);
		const result = enrichEncodedProductSources(current, [snapshot()]);
		assert.equal(result.models![0]!.source, null);
		assert.match(result.models![0]!.sourceWarning!, /父.*SKU|主.*SKU/);
	}
	for (const parentSku of [null, ""])
		assert.equal(enrichEncodedProductSources({ ...one(), parentSku }, [snapshot()]).models![0]!.source!.skuId, "6123318244844");
});

test("Shopee重复SKU、1688截断碰撞、重复快照均拒绝关联", () => {
	const duplicated = one();
	duplicated.models!.push({ ...duplicated.models![0]!, modelId: "another" });
	assert.deepEqual(encodedOfferIds(duplicated), []);
	for (const model of enrichEncodedProductSources(duplicated, [snapshot()]).models!) {
		assert.equal(model.source, null);
		assert.match(model.sourceWarning!, /同一 SKU|重复/);
	}
	const collision = structuredClone(offer);
	collision.skus.push({ ...collision.skus[4]!, skuId: "99999", specId: `${collision.skus[4]!.specId.slice(0, 24)}ffffffff` });
	const collided = enrichEncodedProductSources(one(), [snapshot(collision)]).models![0]!;
	assert.equal(collided.source, null);
	assert.match(collided.sourceWarning!, /多个|重复|唯一/);
	assert.equal(enrichEncodedProductSources(one(), [snapshot(), snapshot()]).models![0]!.source, null);
});

test("快照编号冲突、缺字段、非数字skuId、站点错误与无规格匹配均明确待核对", () => {
	const corrupt: unknown[] = [
		null,
		{},
		{ ...offer, offerId: "999" },
		{ ...offer, skus: [{}] },
		{ ...offer, skus: [{ ...offer.skus[4], skuId: "bad" }] },
		{ ...offer, skus: [] },
	];
	for (const source of corrupt) {
		const model = enrichEncodedProductSources(one(), [snapshot(source)]).models![0]!;
		assert.equal(model.source, null);
		assert.ok(model.sourceWarning);
	}
	const failed = enrichEncodedProductSources(one(), [{ ...snapshot(), error: "登录已失效" }]);
	assert.equal(failed.models![0]!.source, null);
	assert.match(failed.models![0]!.sourceWarning!, /登录已失效/);
	assert.equal(failed.models![0]!.price, 897);
	assert.equal(enrichEncodedProductSources(one(), []).models![0]!.source, null);
	assert.equal(enrichEncodedProductSources({ ...fact, models: null }, []).models, null);
});

test("单规格无specId按skuId核对，图片只接受http协议，名称可取attrs", () => {
	const current = one();
	current.models![0]!.sku = `LT${offerId}-123`;
	const single = { offerId, skus: [{ skuId: "123", specId: "", name: " ", attrs: ["白色", "大号"], image: "javascript:bad()" }] };
	const model = enrichEncodedProductSources(current, [{ ...snapshot(single), readAt: null }]).models![0]!;
	assert.equal(model.source!.skuId, "123");
	assert.equal(model.source!.name, "白色 / 大号");
	assert.equal(model.source!.image, null);
	assert.equal(model.source!.readAt, null);
});

test("旧编码关联遇到新错误或规格消失时清空，不保留过期来源", () => {
	const linked = enrichEncodedProductSources(one(), [snapshot()]);
	assert.equal(linked.models![0]!.source!.skuId, "6123318244844");
	for (const newer of [[{ ...snapshot(), error: "站点读取失败" }], [snapshot({ ...offer, skus: [] })], []]) {
		const result = enrichEncodedProductSources(linked, newer);
		assert.equal(result.models![0]!.source, null);
		assert.ok(result.models![0]!.sourceWarning);
		assert.equal(result.models![0]!.price, 897);
		assert.equal(result.models![0]!.stock, 49);
	}
});

test("货源只顺序读一次并投影必要字段，不按库存过滤规格", async () => {
	const current = { ...one(), parentSku: null };
	current.models!.push({ ...current.models![0]!, modelId: "2", sku: "LT222-123" });
	const calls: string[] = [];
	let active = 0;
	const snapshots = await readEncodedSourceSnapshots(current, async (id) => {
		assert.equal(active++, 0);
		calls.push(id);
		await new Promise<void>((resolve) => setImmediate(resolve));
		active--;
		return id === offerId
			? { ...offer, title: "不保存的标题", skus: offer.skus.map((sku) => ({ ...sku, stock: 0, price: 108 })) }
			: { offerId: "222", skus: [{ skuId: "123", specId: "", name: "单规格", stock: 0 }] };
	});
	assert.deepEqual(calls, [offerId, "222"]);
	assert.equal(snapshots.length, 2);
	assert.deepEqual(snapshots[0]!.offer, offer);
	assert.ok(snapshots.every((row) => row.readAt instanceof Date && !row.error));
	assert.equal(enrichEncodedProductSources(current, snapshots).models![0]!.source!.skuId, "6123318244844");
});

test("读取失败、下架、回包格式或编号错误变成错误快照，保留Shopee资料", async () => {
	for (const failure of [new Error("浏览器断开"), new Gone("货源下架")]) {
		const snapshots = await readEncodedSourceSnapshots(one(), async () => {
			throw failure;
		});
		assert.equal(snapshots[0]!.offer, null);
		assert.match(snapshots[0]!.error!, new RegExp(failure.message));
		assert.equal(enrichEncodedProductSources(one(), snapshots).models![0]!.source, null);
	}
	for (const raw of [{}, { ...offer, offerId: "999" }]) {
		const snapshots = await readEncodedSourceSnapshots(one(), async () => raw);
		assert.equal(snapshots[0]!.offer, null);
		assert.ok(snapshots[0]!.error);
	}
	assert.deepEqual(
		await readEncodedSourceSnapshots({ ...fact, models: null }, async () => {
			throw new Error("不应读取");
		}),
		[],
	);
});
