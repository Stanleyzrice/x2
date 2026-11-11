// 缓存单件只读取本店、本账号、本商品已核对的货源快照，不访问外站或改写任何表。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Sql } from "../../platform/db/index.ts";
import type { ProductFact } from "./facts.ts";
import type { ImageReader } from "./images.ts";
import { readProduct } from "./store.ts";

const fact: ProductFact = {
	productId: "42",
	name: "缓存商品",
	parentSku: "LT100",
	cover: null,
	status: 1,
	reportedStatus: 1,
	statusLabel: "在售",
	unlisted: false,
	models: [{ modelId: "11", sku: "LT100-abc", name: "店铺规格", price: 897, stock: 49, tierIndex: [0] }],
	priceMin: 897,
	priceMax: 897,
	stockTotal: 49,
	stockState: "in_stock",
	detailError: null,
};

function snapshot(shop = "fixture", shopId = "10", productId = "42") {
	return {
		shop,
		shopId,
		productId,
		offerId: "100",
		offer: { offerId: "100", skus: [{ skuId: "200", specId: "abc", name: "大象灰（mini）", image: "https://supplier.example/sku.jpg" }] },
		readAt: new Date("2026-11-11T03:30:29.797Z"),
		error: null as string | null,
	};
}

function fixture(snapshots: ReturnType<typeof snapshot>[]) {
	const queries: { text: string; values: unknown[] }[] = [];
	const run = (strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
		if (!("raw" in strings)) return strings;
		const text = strings.join("?").replace(/\s+/g, " ").trim();
		queries.push({ text, values });
		assert.match(text, /^select /, "缓存单件不得执行写入或事务语句");
		if (text.startsWith("select shop, shop_id")) return Promise.resolve([{ shop: "fixture", shop_id: "10" }]);
		if (text.startsWith("select p.facts")) return Promise.resolve([{ facts: structuredClone(fact) }]);
		if (text.startsWith("select c.shop")) {
			assert.match(text, /where c.shop = \? and c.shop_id = \? and c.product_id in \?/);
			assert.deepEqual(values, ["fixture", "10", ["42"]]);
			const ids = values[2];
			assert.ok(Array.isArray(ids));
			return Promise.resolve(
				snapshots
					.filter((row) => row.shop === values[0] && row.shopId === values[1] && ids.includes(row.productId))
					.map((row) => ({ ...row, models: structuredClone(fact.models) })),
			);
		}
		if (text.includes("from catalog_source_offers")) {
			assert.match(text, /where shop = \? and shop_id = \? and product_id = \?/);
			assert.deepEqual(values, ["fixture", "10", "42"]);
			return Promise.resolve(snapshots.filter((row) => row.shop === values[0] && row.shopId === values[1] && row.productId === values[2]));
		}
		if (
			text.startsWith("select l.shop") ||
			text.startsWith("select item_id") ||
			text.startsWith("select distinct i->>") ||
			text.startsWith("select distinct on (i.product_id)")
		)
			return Promise.resolve([]);
		throw new Error(`意外的缓存查询：${text}`);
	};
	let externalReads = 0;
	const forbidden = () => {
		externalReads++;
		throw new Error("缓存单件不得读取外站");
	};
	const imageReader: ImageReader = { where: forbidden, identity: forbidden, detail: forbidden };
	return { sql: run as unknown as Sql, imageReader, queries, externalReads: () => externalReads };
}

test("缓存单件按完整店铺归属加载已核对规格，不访问外站、不修改价格库存", async () => {
	const f = fixture([snapshot("other"), snapshot("fixture", "20"), snapshot("fixture", "10", "43"), snapshot()]);
	const result = await readProduct(f.sql, "fixture", "42", f.imageReader, true);
	assert.equal(result.product.models?.[0]?.source?.skuId, "200");
	assert.equal(result.product.models?.[0]?.source?.name, "大象灰（mini）");
	assert.equal(result.product.models?.[0]?.source?.url, "https://detail.1688.com/offer/100.html");
	assert.equal(result.product.models?.[0]?.source?.basis, "encoded_sku");
	assert.equal(result.product.models?.[0]?.source?.readAt, "2026-11-11T03:30:29.797Z");
	assert.equal(result.product.models?.[0]?.name, "店铺规格");
	assert.equal(result.product.models?.[0]?.price, 897);
	assert.equal(result.product.models?.[0]?.stock, 49);
	assert.equal(result.product.stockTotal, 49);
	assert.equal(result.product.detailReadAt, null);
	assert.equal(result.product.suppliers[0]?.kind, "verified");
	assert.equal(result.product.suppliers[0]?.offerId, "100");
	assert.equal(f.externalReads(), 0);
	assert.equal(f.queries.filter((query) => query.text.startsWith("select offer_id")).length, 1);
	assert.equal(f.queries.filter((query) => query.text.startsWith("select c.shop")).length, 1);
});

test("其他店铺、账号或商品的同编码货源快照不能填入当前商品", async () => {
	const f = fixture([snapshot("other"), snapshot("fixture", "20"), snapshot("fixture", "10", "43")]);
	const result = await readProduct(f.sql, "fixture", "42", f.imageReader, true);
	assert.equal(result.product.models?.[0]?.source, null);
	assert.deepEqual(result.product.suppliers, []);
	assert.ok(result.product.models?.[0]?.sourceWarning);
	assert.equal(f.externalReads(), 0);
});

test("缓存核对失败的结果保留失败原因，不从旧货号伪造可用关联", async () => {
	const failed = snapshot();
	failed.error = "1688 商品已下架";
	const f = fixture([failed]);
	const result = await readProduct(f.sql, "fixture", "42", f.imageReader, true);
	assert.equal(result.product.models?.[0]?.source, null);
	assert.match(result.product.models?.[0]?.sourceWarning ?? "", /1688 商品已下架/);
	assert.equal(f.externalReads(), 0);
});
