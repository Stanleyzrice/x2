// 描述保留 Shopee 原生文字和详情图的次序；格式异常、未知项及缺失字段不冒充空描述。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { productInfoOf } from "../../connectors/sites/shopee/products.ts";
import { productContent } from "./description.ts";

const info = (description: string, description_type?: string) =>
	productInfoOf({ data: { product_info: { description_info: { description, description_type } } } });

test("详情图真回包的文字和四张图片按原顺序保留，不混入商品主图", () => {
	const fixture = JSON.parse(readFileSync(new URL("../../connectors/sites/shopee/fixtures/get-product-description-images.json", import.meta.url), "utf8"));
	const p = productInfoOf(fixture);
	const result = productContent(p);
	assert.equal(result.description?.error, null);
	assert.equal(result.description?.blocks.length, 5);
	assert.equal(result.description?.blocks[0]?.type, "text");
	assert.deepEqual(result.description?.blocks[1], { type: "image", src: "https://down-tw.img.susercontent.com/file/tw-11134207-820l6-mv4hwnecl6h356" });
	assert.deepEqual(result.description?.blocks[4], { type: "image", src: "https://down-tw.img.susercontent.com/file/tw-11134207-820lf-mv4d4exrl2pu82" });
	assert.equal(result.productImages, null);
});

test("普通描述保留换行、原文及 HTML 字面文字，不执行 HTML", () => {
	const text = "材質：矽藻泥\n尺寸：60×90cm\n<img src=x onerror=alert(1)>";
	assert.deepEqual(productContent(info(text, "normal")).description, { blocks: [{ type: "text", text }], error: null });
	assert.deepEqual(productContent(info("普通文字")).description, { blocks: [{ type: "text", text: "普通文字" }], error: null });
});

test("无类型但符合原生 field_list 的旧回包照样解析，混排不去重或挪动", () => {
	const fields = [
		{ type: 1, value: "same" },
		{ type: 0, value: "尺寸见上图" },
		{ type: 1, value: "same" },
	];
	assert.deepEqual(productContent(info(JSON.stringify({ field_list: fields }))).description, {
		blocks: [
			{ type: "image", src: "https://down-tw.img.susercontent.com/file/same" },
			{ type: "text", text: "尺寸见上图" },
			{ type: "image", src: "https://down-tw.img.susercontent.com/file/same" },
		],
		error: null,
	});
});

test("缺失和明确为空分开；损坏 JSON、未知格式不当作正常空描述", () => {
	assert.equal(productContent(productInfoOf({ data: { product_info: {} } })).description, null);
	assert.deepEqual(productContent(info("", "normal")).description, { blocks: [], error: null });
	assert.deepEqual(productContent(info('{"field_list":[]}', "json")).description, { blocks: [], error: null });
	for (const p of [info("{broken", "json"), info("{}", "json"), info("<p>内容</p>", "html")]) {
		const result = productContent(p).description;
		assert.deepEqual(result?.blocks, []);
		assert.ok(result?.error);
	}
});

test("部分富文本项异常时保留可读项，并标明未完整显示；拒绝非 HTTP(S) 图片", () => {
	const fields = [
		{ type: 0, value: "保留文字" },
		{ type: 8, value: "video" },
		{ type: 1, value: "javascript:alert(1)" },
		{ type: 1, value: "https://example.com/detail.jpg" },
		{ type: 0 },
	];
	const result = productContent(info(JSON.stringify({ field_list: fields }), "json")).description;
	assert.deepEqual(result?.blocks, [
		{ type: "text", text: "保留文字" },
		{ type: "image", src: "https://example.com/detail.jpg" },
	]);
	assert.match(result?.error ?? "", /3/);
});

test("商品图片和原生尺码表单独返回，不拿封面或文字补成详情图", () => {
	const p = productInfoOf({
		data: {
			product_info: {
				images: ["cover", "https://example.com/second.jpg", null, "data:image/png;base64,xx"],
				size_chart_info: { size_chart: "native-size-chart" },
			},
		},
	});
	assert.deepEqual(productContent(p), {
		productImages: ["https://down-tw.img.susercontent.com/file/cover", "https://example.com/second.jpg"],
		sizeChartImage: "https://down-tw.img.susercontent.com/file/native-size-chart",
		description: null,
	});
});
