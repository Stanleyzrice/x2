// 尺码图生成只接受明确数值/单位和完整源SKU绑定：拒绝占位表、错款、漏规格与把体重建议冒充成衣平量。
import assert from "node:assert/strict";
import { test } from "node:test";
import { OfferId, SkuId, SpecId } from "../../connectors/sites/1688/api.ts";
import { type ChartTable, chartPlan, chartRenderParams, chartTableSchema } from "./chart-render.ts";
import type { ListingRow } from "./row.ts";
import { specsOf } from "./variants.ts";

function source(): Pick<ListingRow, "shop" | "offer_id" | "offer" | "variants"> {
	const sizes = ["M【建议75-95斤】", "L【建议95-108斤】"];
	const skus = ["灰", "蓝"].flatMap((color, ci) =>
		sizes.map((size, si) => ({
			skuId: SkuId.parse(`${ci}-${si}`),
			specId: SpecId.parse(`spec${ci}-${si}`),
			name: `${color} / ${size}`,
			attrs: [color, size],
			price: 10,
			stock: 5,
			image: "",
		})),
	);
	return {
		shop: "cheeroutdoor",
		offer_id: OfferId.parse("123"),
		offer: {
			offerId: OfferId.parse("123"),
			url: "https://detail.1688.com/offer/123.html",
			title: "家居服",
			image: "",
			unit: "套",
			minQty: 1,
			skus,
			props: [
				{
					name: "颜色",
					values: [
						{ name: "灰", image: "" },
						{ name: "蓝", image: "" },
					],
				},
				{ name: "尺码", values: sizes.map((name) => ({ name, image: "" })) },
			],
		},
		variants: {
			tiers: [
				{
					source: "颜色",
					name: "顏色",
					options: [
						{ source: "灰", name: "灰" },
						{ source: "蓝", name: "藍" },
					],
				},
				{ source: "尺码", name: "尺碼", options: sizes.map((size, i) => ({ source: size, name: i ? "L" : "M" })) },
			],
			variants: skus.map((sku, index) => ({
				sku: `local-${index}`,
				skuId: sku.skuId,
				specId: sku.specId,
				options: [Math.floor(index / 2), index % 2],
				costRmb: 10,
				stock: 5,
				weightKg: null,
				priceTwd: null,
			})),
		},
	};
}
function table(): ChartTable {
	return {
		offerId: "123",
		sourceTier: "尺码",
		kind: "recommendation",
		title: "长袖家居服选码建议",
		columns: [{ title: "建议体重", unit: "市斤" }],
		rows: [
			{
				label: "M",
				sourceOption: "M【建议75-95斤】",
				sourceSkuIds: ["0-0", "1-0"],
				values: [[75, 95]],
				evidence: "https://detail.1688.com/offer/123.html 原尺码M明示75-95斤",
			},
			{
				label: "L",
				sourceOption: "L【建议95-108斤】",
				sourceSkuIds: ["0-1", "1-1"],
				values: [[95, 108]],
				evidence: "https://detail.1688.com/offer/123.html 原尺码L明示95-108斤",
			},
		],
		evidence: "已审核本源四SKU的原尺码选项；仅保留市斤，不补厘米或换算。",
	};
}

test("源体重建议保留区间和市斤，仅说明单位关系，不生成cm或自动换算区间", () => {
	const row = source(),
		input = table(),
		before = structuredClone({ row, input });
	const plan = chartPlan(row, input);
	assert.deepEqual(plan.headers, ["尺碼／款式", "建議體重\n市斤"]);
	assert.deepEqual(plan.rows, [
		["M", "75–95"],
		["L", "95–108"],
	]);
	assert.equal(plan.subtitle, "供貨商建議，非成衣平量");
	assert.ok(plan.notes.some((note) => note.includes("1市斤＝0.5公斤") && note.includes("非台斤")));
	assert.equal(plan.bindings.length, 4);
	assert.equal(plan.bindings[0]!.sourceAttrs[1], "M【建议75-95斤】");
	assert.match(plan.title, /長袖/);
	assert.ok(!JSON.stringify(plan.headers).includes("cm"));
	assert.deepEqual({ row, input }, before);
});

test("仅M/L标签、全缺行、全缺列及未注明/含糊单位不能形成看似完整尺码表", () => {
	for (const unit of ["", "斤", "台斤", "unknown"]) {
		const input = table();
		assert.equal(chartTableSchema.safeParse({ ...input, columns: [{ title: "體重", unit }] }).success, false);
	}
	const emptyRow = table();
	emptyRow.rows[0]!.values = [null];
	assert.equal(chartTableSchema.safeParse(emptyRow).success, false);
	const emptyColumn = table();
	emptyColumn.columns.push({ title: "衣长", unit: "cm" });
	for (const row of emptyColumn.rows) row.values.push(null);
	assert.equal(chartTableSchema.safeParse(emptyColumn).success, false);
	assert.equal(chartTableSchema.safeParse({ ...table(), columns: [] }).success, false);
	assert.equal(chartTableSchema.safeParse({ ...table(), evidence: " " }).success, false);
	assert.equal(chartTableSchema.safeParse({ ...table(), rows: [{ ...table().rows[0]!, evidence: "" }] }).success, false);
});

test("非法数值、反向区间、行列数不符和体重冒充成衣实测被拒绝", () => {
	for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, [108, 95], "75-95"]) {
		const input = table();
		assert.equal(chartTableSchema.safeParse({ ...input, rows: [{ ...input.rows[0]!, values: [bad] }, input.rows[1]] }).success, false);
	}
	assert.equal(chartTableSchema.safeParse({ ...table(), kind: "measurement" }).success, false);
	const badCount = table();
	badCount.rows[0]!.values.push(65);
	assert.equal(chartTableSchema.safeParse(badCount).success, false);
});

test("确有cm量测时只显示已给数值，局部缺项保持未提供且不补容差", () => {
	const input = table();
	input.kind = "measurement";
	input.columns = [
		{ title: "衣长", unit: "cm" },
		{ title: "胸围", unit: "cm" },
	];
	input.rows[0]!.values = [65, null];
	input.rows[1]!.values = [67, 108];
	const plan = chartPlan(source(), input);
	assert.deepEqual(plan.rows, [
		["M", "65", "未提供"],
		["L", "67", "108"],
	]);
	assert.equal(plan.subtitle, "供貨商成衣量測資料，非本店實測");
	assert.ok(!plan.notes.join().includes("1–3"));
});

test("仅有身高建议的表不把建议范围误称为体重", () => {
	const input = table();
	input.columns = [{ title: "建议身高", unit: "cm" }];
	input.rows[0]!.values = [[155, 160]];
	input.rows[1]!.values = [[160, 165]];
	const plan = chartPlan(source(), input);
	assert.deepEqual(plan.headers, ["尺碼／款式", "建議身高\ncm"]);
	assert.match(plan.notes.join(), /建議範圍僅供選碼參考/);
	assert.doesNotMatch(plan.notes.join(), /體重/);
});

test("全部选中源SKU必须精确覆盖一次，不能混尺码、借其他源、漏掉颜色或偷换specId", () => {
	const omitted = table();
	omitted.rows[1]!.sourceSkuIds.pop();
	assert.throws(() => chartPlan(source(), omitted), /未覆盖/);
	const duplicated = table();
	duplicated.rows[0]!.sourceSkuIds.push("0-0");
	assert.throws(() => chartPlan(source(), duplicated), /重复绑定/);
	const foreign = table();
	foreign.rows[0]!.sourceSkuIds.push("not-selected");
	assert.throws(() => chartPlan(source(), foreign), /未选源/);
	const mixed = table();
	mixed.rows[0]!.sourceOption = mixed.rows[1]!.sourceOption;
	assert.throws(() => chartPlan(source(), mixed), /原始尺码不符/);
	assert.throws(() => chartPlan(source(), { ...table(), offerId: "456" }), /货源与商品稿不一致/);
	assert.throws(() => chartPlan(source(), { ...table(), sourceTier: "不存在" }), /没有原始规格层/);
	const altered = source();
	altered.offer!.skus[0]!.specId = SpecId.parse("new-spec");
	assert.throws(() => chartPlan(altered, table()), /规格编号已变化/);
	const labels = table();
	labels.rows[1]!.label = "M";
	assert.throws(() => chartPlan(source(), labels), /行名重复/);
});

test("命令接收JSON并只允许X2本地origin，默认仅准备预览而不覆盖人工图", () => {
	const input = { id: "190", table: JSON.stringify(table()) };
	const parsed = chartRenderParams.parse(input);
	assert.equal(parsed.origin, "http://127.0.0.1:5170");
	assert.equal(parsed.replace, false);
	assert.deepEqual(parsed.table, table());
	assert.equal(chartRenderParams.parse({ ...input, origin: "http://localhost:5199/" }).origin, "http://localhost:5199");
	for (const origin of [
		"https://seller.shopee.tw",
		"https://example.com",
		"file:///tmp/x.html",
		"http://127.0.0.1:5170/?x=1",
		"http://user:pass@localhost:5170",
		"http://localhost:5170/page",
	])
		assert.equal(chartRenderParams.safeParse({ ...input, origin }).success, false);
});

function shoeSource(sizes = ["36-37【适合35-36脚穿】", "38/39"]) {
	const row = source();
	row.offer!.title = "成人棉拖鞋";
	row.offer!.unit = "双";
	row.offer!.props[1]!.values = sizes.map((name) => ({ name, image: "" }));
	for (const [index, sku] of row.offer!.skus.entries()) {
		sku.attrs[1] = sizes[index % 2]!;
		sku.name = sku.attrs.join(" / ");
	}
	const specs = specsOf(row.variants)!;
	specs.tiers[1]!.options = sizes.map((size) => ({ source: size, name: size }));
	row.variants = specs;
	return row;
}
function shoeTable(): ChartTable {
	return {
		offerId: "123",
		sourceTier: "尺码",
		kind: "size-label",
		title: "供货商鞋码说明",
		columns: [{ title: "标示鞋码", unit: "號" }],
		rows: [
			{
				label: "36–37",
				sourceOption: "36-37【适合35-36脚穿】",
				sourceSkuIds: ["0-0", "1-0"],
				values: [[36, 37]],
				evidence: "原SKU标示36-37，括号适合35-36不是标示鞋码",
			},
			{ label: "38–39", sourceOption: "38/39", sourceSkuIds: ["0-1", "1-1"], values: [[38, 39]], evidence: "原SKU原文38/39；不换算脚长" },
		],
		evidence: "https://detail.1688.com/offer/123.html 仅据全部已选源SKU标示鞋码，不推测厘米或脚长。",
	};
}

test("size-label鞋码只显示真实SKU标示区间和號，不生成成衣、体重或厘米量测", () => {
	const row = shoeSource(),
		input = shoeTable(),
		before = structuredClone({ row, input });
	const plan = chartPlan(row, input);
	assert.deepEqual(plan.headers, ["尺碼／款式", "標示鞋碼\n號"]);
	assert.deepEqual(plan.rows, [
		["36–37", "36–37"],
		["38–39", "38–39"],
	]);
	assert.equal(plan.subtitle, "供貨商尺碼標籤，非實際量測");
	assert.doesNotMatch([plan.subtitle, ...plan.notes].join(), /成衣|體重|衣物/);
	assert.match(plan.notes.join(), /未換算公分或其他尺碼系統/);
	assert.equal(plan.bindings.length, 4);
	assert.match(plan.scope, /^[a-f\d]{64}$/);
	assert.deepEqual({ row, input }, before, "预览不改源SKU、售价或任何输入");
	const parsed = chartRenderParams.parse({ id: "234", table: JSON.stringify(input) });
	assert.equal(parsed.table.kind, "size-label");
	assert.equal(parsed.replace, false);
});

test("size-label拒绝厘米/体重列、建议脚码替代原标示码、凭空换算和不完整SKU覆盖", () => {
	for (const unit of ["cm", "mm", "kg", "市斤"])
		assert.equal(chartTableSchema.safeParse({ ...shoeTable(), columns: [{ title: "鞋码", unit }] }).success, false);
	const extraColumn = shoeTable();
	extraColumn.columns.push({ title: "脚长", unit: "cm" });
	for (const row of extraColumn.rows) row.values.push(24);
	assert.equal(chartTableSchema.safeParse(extraColumn).success, false);
	assert.equal(chartTableSchema.safeParse({ ...shoeTable(), kind: "measurement" }).success, false);
	for (const value of [[35, 36], 24, [36, 38]]) {
		const wrong = shoeTable();
		wrong.rows[0]!.values = [value as number | [number, number]];
		assert.throws(() => chartPlan(shoeSource(), wrong), /标示鞋码须与原始SKU/);
	}
	const omitted = shoeTable();
	omitted.rows[0]!.sourceSkuIds.pop();
	assert.throws(() => chartPlan(shoeSource(), omitted), /未覆盖/);
	const foreign = shoeTable();
	foreign.rows[1]!.sourceSkuIds[0] = "not-selected";
	assert.throws(() => chartPlan(shoeSource(), foreign), /未选源/);
});

test("size-label保留单码、空格与鞋底前缀的源数字，不把cm字段解释成鞋码", () => {
	const row = shoeSource(["36", "鞋底38 / 39适合37-38脚"]),
		input = shoeTable();
	input.rows[0]!.sourceOption = "36";
	input.rows[0]!.label = "36";
	input.rows[0]!.values = [36];
	input.rows[1]!.sourceOption = "鞋底38 / 39适合37-38脚";
	assert.deepEqual(chartPlan(row, input).rows, [
		["36", "36"],
		["38–39", "38–39"],
	]);
	const measured = shoeSource(["24cm", "38/39"]),
		wrong = shoeTable();
	wrong.rows[0]!.sourceOption = "24cm";
	wrong.rows[0]!.values = [24];
	assert.throws(() => chartPlan(measured, wrong), /标示鞋码须与原始SKU/);
});

function apparelLabels() {
	const row = source(),
		sizes = ["M", "L", "XL", "2XL", "3XL"],
		styles = ["5116", "5106", "5110", "5108", "随机单裤一条"];
	row.offer!.props[0]!.values = styles.map((name) => ({ name, image: "" }));
	row.offer!.props[1]!.values = sizes.map((name) => ({ name, image: "" }));
	row.offer!.skus = styles.flatMap((style, ci) =>
		sizes.map((size, si) => ({
			...row.offer!.skus[0]!,
			skuId: SkuId.parse(`${ci}-${si}`),
			specId: SpecId.parse(`apparel${ci}-${si}`),
			name: `${style} / ${size}`,
			attrs: [style, size],
		})),
	);
	row.variants = {
		tiers: [
			{ source: "颜色", name: "款式", options: styles.map((name) => ({ source: name, name })) },
			{ source: "尺码", name: "尺碼", options: sizes.map((name) => ({ source: name, name })) },
		],
		variants: row.offer!.skus.map((sku, i) => ({
			sku: `apparel-local-${i}`,
			skuId: sku.skuId,
			specId: sku.specId,
			options: [Math.floor(i / sizes.length), i % sizes.length],
			costRmb: 10,
			stock: 5,
			weightKg: null,
			priceTwd: null,
		})),
	};
	const input = {
		offerId: "123",
		sourceTier: "尺码",
		kind: "size-label",
		title: "原标示尺码说明",
		columns: [{ title: "原标示尺码", unit: "標示" }],
		rows: sizes.map((size) => ({
			label: size,
			sourceOption: size,
			sourceSkuIds: row.offer!.skus.filter((sku) => sku.attrs[1] === size).map((sku) => sku.skuId),
			values: [size],
			evidence: `https://detail.1688.com/offer/123.html 原SKU尺码标签${size}；没有实际量测或体重数据。`,
		})),
		note: "未提供成衣公分量测或适穿体重资料。",
		evidence: "原SKU的M/L/XL/2XL/3XL标签，完整绑定四套装及随机单裤共25SKU。",
	};
	return { row, input };
}

test("size-label原服装标签逐字展示并覆盖25SKU，不补量测或适穿数值", () => {
	const { row, input } = apparelLabels(),
		before = structuredClone({ row, input });
	const plan = chartPlan(row, chartTableSchema.parse(input));
	assert.deepEqual(
		plan.rows,
		["M", "L", "XL", "2XL", "3XL"].map((size) => [size, size]),
	);
	assert.deepEqual(plan.headers, ["尺碼／款式", "原標示尺碼\n標示"]);
	assert.equal(plan.bindings.length, 25);
	assert.equal(plan.subtitle, "供貨商尺碼標籤，非實際量測");
	assert.doesNotMatch([plan.subtitle, ...plan.notes].join(), /鞋碼|腳長|鞋內長/);
	assert.match(plan.notes.join(), /未提供成衣公分量測或適穿體重資料/);
	assert.match(plan.notes.join(), /不代表實際尺寸或適穿保證/);
	assert.deepEqual({ row, input }, before);
});

test("服装标签拒绝换码、数值冒充、模糊文字、错误单位和漏SKU", () => {
	const { row, input } = apparelLabels();
	for (const value of ["L", "XXXL", 1, [1, 2], null, "均码", "M【建议75-95斤】"])
		assert.equal(chartTableSchema.safeParse({ ...input, rows: [{ ...input.rows[0]!, values: [value] }, ...input.rows.slice(1)] }).success, false);
	for (const kind of ["measurement", "recommendation"]) assert.equal(chartTableSchema.safeParse({ ...input, kind }).success, false);
	for (const unit of ["cm", "kg", "市斤", "號"]) assert.equal(chartTableSchema.safeParse({ ...input, columns: [{ title: "原尺码", unit }] }).success, false);
	const omitted = chartTableSchema.parse(input);
	omitted.rows[0]!.sourceSkuIds.pop();
	assert.throws(() => chartPlan(row, omitted), /未覆盖/);
	const mixed = chartTableSchema.parse(input);
	mixed.rows[0]!.sourceSkuIds[0] = mixed.rows[1]!.sourceSkuIds[0]!;
	assert.throws(() => chartPlan(row, mixed), /原始尺码不符/);
});
