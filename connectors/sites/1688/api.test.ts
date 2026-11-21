// 1688 的回包解析：拿 fixtures 里的样本（同目录 NOTES.md「回包样本」说哪份是真的、哪份照代码写的）跑解析，看解析出来的样子；回包变了要说哪个接口、哪一格
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { accountOf, buyerOrdersOf, cartOf, collectionLink, descriptionOf, OfferId, offerIdOf, offerOf, refundOf, searchHitsOf, tracesOf } from "./api.ts";

const sample = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
type CardNode = Parameters<typeof collectionLink>[0];
const cardNode = (attrs: Record<string, string>, parentElement: CardNode | null = null): CardNode => ({
	getAttribute: (name) => attrs[name] ?? null,
	parentElement,
});

test("真实首页无href的DIV卡片：普通卡与带明确offerId的广告卡共用原生商品编号", () => {
	const { cards } = sample("home-cards") as { cards: { href: string | null; report: string }[] };
	assert.deepEqual(
		cards.map((card) => {
			assert.equal(card.href, null);
			return collectionLink(cardNode({}, cardNode({ "data-aplus-report": card.report })));
		}),
		["https://detail.1688.com/offer/996533339912.html", "https://detail.1688.com/offer/921948191968.html", "https://detail.1688.com/offer/1083520648876.html"],
	);
});

test("节点编号冲突或损坏时明确拒绝，不借用其它卡片；保留长字符串编号", () => {
	assert.equal(collectionLink(cardNode({ "data-offer-id": "90071992547409931234" })), "https://detail.1688.com/offer/90071992547409931234.html");
	for (const node of [
		cardNode({ "data-offer-id": "123", "data-aplus-report": "object_type@offer^object_id@456" }),
		cardNode({ "data-aplus-report": "object_type@offer^offerId@123^offerId@456" }),
		cardNode({ "data-offer-id": "123" }, cardNode({ "data-offer-id": "456" })),
		cardNode({ "data-offer-id": "123bad" }),
		cardNode({ "data-aplus-report": "object_type@offer^object_id@123^offerId@bad" }),
	])
		assert.equal(collectionLink(node), null);
});

test("非商品object_id不能冒作商品编号；明确offerId不拿广告编号做冲突判断", () => {
	assert.equal(collectionLink(cardNode({ "data-aplus-report": "object_type@offerAd^object_id@999^offerId@123" })), "https://detail.1688.com/offer/123.html");
	assert.equal(collectionLink(cardNode({ "data-aplus-report": "object_type@offer^object_id@123" })), "https://detail.1688.com/offer/123.html");
	for (const report of ["object_type@offerAd^object_id@999", "object_type@topic^object_id@888", "object_id@777", "tab_name@推荐商品"])
		assert.equal(collectionLink(cardNode({ "data-aplus-report": report })), undefined);
});

test("商品编号兼容合法1688旧query卡片，保留数字和详情路径原行为，拒绝伪域名及歧义query", () => {
	assert.equal(offerIdOf(" 123 "), "123");
	assert.equal(offerIdOf("https://detail.1688.com/offer/456.html?from=search"), "456");
	assert.equal(offerIdOf("http://s.1688.com/offer?offerId=789"), "789");
	assert.equal(offerIdOf("https://s.1688.com/offer?from=search&offerId=789&spm=tracking"), "789");
	for (const url of [
		"https://s.1688.com.evil.com/offer?offerId=789",
		"https://user:password@s.1688.com/offer?offerId=789",
		"https://s.1688.com/offer?offerId=invalid",
		"https://s.1688.com/offer?offerId=1&offerId=2",
		"https://s.1688.com/other?offerId=789",
	])
		assert.equal(offerIdOf(url), null);
});

test("详情字图按页面顺序保留，图片去重，脚本与图片内文字不混入原文", () => {
	const parsed = descriptionOf(
		"var offer_details=" +
			JSON.stringify({
				content:
					'<p>鞋面：毛绒 &amp; EVA</p><img src="//cbu01.alicdn.com/a.jpg"><p>室内使用&#12290;</p><script>恶意脚本</script><img src="https://cbu01.alicdn.com/a.jpg">',
			}) +
			";",
	);
	assert.deepEqual(parsed, {
		text: "鞋面：毛绒 & EVA\n室内使用。",
		images: ["https://cbu01.alicdn.com/a.jpg"],
		blocks: [
			{ type: "text", text: "鞋面：毛绒 & EVA" },
			{ type: "image", src: "https://cbu01.alicdn.com/a.jpg" },
			{ type: "text", text: "室内使用。" },
		],
	});
});

test("真实商品详情回包：18张原图按顺序保存，纯图片页面的网页文字为空", () => {
	const { raw } = sample("description-live") as { raw: string };
	const result = descriptionOf(raw);
	assert.equal(result.images.length, 18);
	assert.equal(result.blocks.length, 18);
	assert.equal(result.text, "");
	assert.equal(result.images[0], "https://cbu01.alicdn.com/img/ibank/O1CN014L07x12NQMjAj9Zsz_!!2214608309957-0-cib.jpg");
	assert.equal(result.images.at(-1), "https://cbu01.alicdn.com/img/ibank/O1CN01ERQKjm2NQMZHDGUVZ_!!2214608309957-0-cib.jpg");
});

test("旧版详情回包：推荐商品区块内的JSON不吞掉正文，只保存本品图片", () => {
	const { raw } = sample("description-legacy-live") as { raw: string };
	const result = descriptionOf(raw);
	assert.equal(result.text, "");
	assert.equal(result.images.length, 5);
	assert.equal(result.images[0], "https://cbu01.alicdn.com/img/ibank/O1CN01boKNnv1dhKySuDSMW_!!2159063767-0-cib.jpg");
	assert.deepEqual(
		result.blocks,
		result.images.map((src) => ({ type: "image", src })),
	);
});

test("搜索新版商品卡：普通 HTTP 详情链接、拆行小数、起订量和全网销量照原字段读取", () => {
	const { cards } = sample("search-cards") as { cards: unknown };
	const hits = searchHitsOf(cards);
	assert.deepEqual(
		hits.map((h) => [h.offerId, h.price, h.minQty, h.sold, h.shop]),
		[
			["1082528475978", 0.11, 50, "10万+件", "义乌市烯宇贸易有限公司"],
			["820186435888", 1.8, 1, "全网10万+件", "南阳余生艾健康管理有限公司"],
			["1090213560301", 0.06, 50, "10万+件", "义乌市烯宇贸易有限公司"],
		],
	);
	assert.equal(hits[0]!.url, "https://detail.1688.com/offer/1082528475978.html");
	assert.match(hits[0]!.title, /^跨境亚马逊 y2k/);
	assert.match(hits[0]!.image, /^https:\/\/cbu01\.alicdn\.com\//);
});

test("搜索商品卡类名缺失时用可见文字，去重补全字段，不把运费或回头率当起订量", () => {
	const { cards } = sample("search-cards") as { cards: Record<string, string>[] };
	const raw = cards.map((c) => ({ ...c, title: "", price: "", minQty: "", sold: "", shop: "" }));
	const hits = searchHitsOf([...raw, ...cards]);
	assert.equal(hits.length, 3);
	assert.deepEqual(
		hits.map((h) => h.price),
		[0.11, 1.8, 0.06],
	);
	assert.deepEqual(
		hits.map((h) => h.minQty),
		[50, 1, 50],
	);
	assert.equal(hits[1]!.shop, "南阳余生艾健康管理有限公司");
	assert.equal(searchHitsOf(raw)[0]!.minQty, 0);
});

test("搜索旧版 offerId 链接仍可读；广告不充商品，损坏的字段报回包变了", () => {
	const card = {
		href: "https://s.1688.com/offer?offerId=123",
		text: "旧版商品标题\n¥\n31\n.5\n全网30+件",
		title: "",
		price: "",
		minQty: "≥2件",
		sold: "",
		shop: "",
		image: "//cbu01.alicdn.com/example.jpg",
	};
	assert.deepEqual(searchHitsOf([card])[0], {
		offerId: "123",
		url: "https://detail.1688.com/offer/123.html",
		title: "旧版商品标题",
		price: 31.5,
		minQty: 2,
		sold: "全网30+件",
		shop: "",
		image: "https://cbu01.alicdn.com/example.jpg",
	});
	assert.deepEqual(searchHitsOf([{ ...card, href: "https://ad.1688.com/" }]), []);
	assert.throws(() => searchHitsOf([{ ...card, text: null }]), /1688 搜索商品卡 的回包变了/);
});

test("商品页：规格的属性拆开、价格没有用折扣价、重量没有用整个商品的；图去重补 https；规格图取第一个属性的值", () => {
	const o = offerOf(sample("offer"), OfferId.parse("1014247787336"));
	assert.equal(o.offerId, "1014247787336");
	assert.equal(o.title, "浴水生财猫咪浴室地垫硅藻泥卫生间门口防滑脚垫异形卡通耐脏门垫");
	assert.equal(o.minQty, 1);
	assert.deepEqual(
		o.skus.map((s) => [s.skuId, s.specId, s.attrs, s.price, s.stock, s.weightKg]),
		[
			["6022174637511", "3071830fb9e7fcd58cfdc4a4b5f0d8d5", ["水生财黑猫咪", "60*90cm（升级版硅藻泥）"], 8.1, 9984, 0.486],
			["6022174637539", "9d51e543e760e554812ebd5303be915b", ["洗洗睡吧梅棕狗", "60*90cm（升级版硅藻泥）"], 8.1, 9998, 0.5],
		],
	);
	assert.equal(o.skus[1]!.image, "https://cbu01.alicdn.com/img/ibank/O1CN01RX4gZ81hzRDHzzb2n_!!2221163894348-0-cib.jpg");
	assert.deepEqual(
		o.props.map((p) => [p.name, p.values.map((v) => v.name)]),
		[
			["颜色", ["水生财黑猫咪", "洗洗睡吧梅棕狗"]],
			["尺寸", ["60*90cm（升级版硅藻泥）"]],
		],
	);
	assert.equal(o.images?.length, 3);
	assert.equal(o.images?.[2], "https://cbu01.alicdn.com/img/ibank/O1CN01szAzab1hzRDH8pOQp_!!2221163894348-0-cib.jpg");
	assert.equal(o.detailUrl, "https://itemcdn.tmall.com/1688offer/icoss1014247787336.html");
	assert.deepEqual(o.freight, { costRmb: 8, to: "广东省东莞市" });
});

test("商品页：只有一个规格的商品，规格 id 用商品 id、specId 是空的；包邮的运费是 0", () => {
	const o = offerOf(sample("offer-single"), OfferId.parse("720000000001"));
	assert.deepEqual(o.props, []);
	assert.deepEqual(o.skus, [
		{
			skuId: "720000000001",
			specId: "",
			name: "",
			attrs: [],
			price: 3.5,
			stock: 120,
			image: "https://cbu01.alicdn.com/img/ibank/single-1.jpg",
			weightKg: null,
		},
	]);
	assert.equal(o.minQty, 2);
	assert.equal(o.freight?.costRmb, 0);
});

test("商品页变了（没有标题）：说哪个商品、哪一格", () => {
	const raw = sample("offer") as { offerDetail: Record<string, unknown> };
	delete raw.offerDetail.subject;
	assert.throws(() => offerOf(raw, OfferId.parse("1014247787336")), /1688 商品 1014247787336 的回包变了：offerDetail\.subject 没有了/);
});

test("购物车：只取规格（type 是 item），没有 skuId 的用商品 id；读到的比汇总少就报错", () => {
	assert.deepEqual(cartOf(sample("cart")), [
		{ offerId: "1014247787336", skuId: "6022174637511", quantity: 3 },
		{ offerId: "720000000001", skuId: "720000000001", quantity: 1 },
	]);
	const short = JSON.stringify({ data: { r: { type: "root", fields: { totalSkuCount: 3 } } } });
	assert.throws(() => cartOf({ model: short }), /购物车有 3 个规格，只读到 0 个/);
});

test("采购单：单号用 idStr，金额分转元，行上带快递单号和售中退款；原样的一行留在 raw", () => {
	const r = buyerOrdersOf(sample("buyer-orders"));
	assert.deepEqual([r.total, r.pages, r.rows.length], [1, 1, 1]);
	const o = r.rows[0]!;
	assert.deepEqual([o.orderId, o.goods, o.freight, o.paid, o.paidAt], ["3012345678901234567", 24.3, 8, 32.3, 1760000000000]);
	assert.deepEqual(o.items, [
		{
			offerId: "1014247787336",
			specId: "3071830fb9e7fcd58cfdc4a4b5f0d8d5",
			skuId: "6022174637511",
			name: "浴水生财猫咪浴室地垫",
			spec: "水生财黑猫咪 / 60*90cm（升级版硅藻泥）",
			quantity: 3,
			price: 8.1,
			status: "waitbuyerreceive",
			statusLabel: "已发货",
			received: 0,
			refund: { id: "TQ0000000000000001", stage: "售中", status: "waitselleragree" },
			trackingNo: "YT0000000000001",
			shippedAt: 1760100000000,
		},
	]);
	assert.equal((o.raw as { idStr: string }).idStr, "3012345678901234567");
});

test("退款单：退货退款、钱分转元、退货运单号", () => {
	assert.deepEqual(refundOf("TQ0000000000000001", sample("refund")), {
		refundId: "TQ0000000000000001",
		status: "waitbuyersend",
		statusLabel: "等待买家退货",
		kind: "退货退款",
		amount: 24.3,
		returnTrackingNo: "SF0000000000001",
		returnLogistics: "已签收",
		createdAt: "2026-10-09 12:00:00",
		updatedAt: "2026-10-10 09:30:00",
	});
	assert.throws(() => refundOf("TQ1", { model: { statusLabel: "x" } }), /1688 退款单 TQ1（viewRefundDetail） 的回包变了：model\.status 没有了/);
});

test("物流：订单号丢了精度对不上时按运单号找；没有运单号的轨迹不要", () => {
	assert.deepEqual(tracesOf([{ orderId: "3012345678901234567", trackingNos: ["YT0000000000001"] }], sample("traces")), [
		{ orderId: "3012345678901234567", traces: [{ status: "已签收", trackingNo: "YT0000000000001", logisticsId: "LP001", remark: "快件已签收" }] },
	]);
	assert.deepEqual(tracesOf([{ orderId: "3012345678901234567" }], sample("traces")), [{ orderId: "3012345678901234567", traces: [] }]);
});

test("账号：登录着回 userId 和会员名；没登录是 null", () => {
	assert.deepEqual(accountOf(sample("account")), { userId: "2200000000001", loginId: "某某贸易" });
	assert.equal(accountOf({ isLogin: false }), null);
	assert.equal(accountOf(null), null);
});
