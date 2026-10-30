// 1688 的回包解析：拿 fixtures 里的样本（同目录 NOTES.md「回包样本」说哪份是真的、哪份照代码写的）跑解析，看解析出来的样子；回包变了要说哪个接口、哪一格
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { accountOf, buyerOrdersOf, cartOf, OfferId, offerOf, refundOf, tracesOf } from "./api.ts";

const sample = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

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
