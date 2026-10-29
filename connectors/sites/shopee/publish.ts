// 建商品、上架（写）：提交一次，读回来核对。建商品读回来和提交的 product_info 逐项比（readbackProblems）；上架读回来看在售。
// 只经上品的写工具（listing.publish）调：照商品稿组 product_info、看还该不该建是上品的事
import { z } from "zod";
import type { SubmitTool } from "../../../platform/tool.ts";
import { allProducts, channels, createProduct, productInfo, setUnlisted } from "./products.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 图片 id：平台可能回地址，取最后一段、去掉查询串 */
const imageId = (v: unknown) =>
	String(v ?? "")
		.split("?")[0]!
		.replace(/\/+$/, "")
		.split("/")
		.pop()!;
const num = (v: unknown) => Number(v);

/** 读回来的（get_product_info 的 product_info 和物流渠道列表）和提交的逐项比，回不一致的项。不比属性、品牌、尺寸、起购量 */
export function readbackProblems(sent: any, got: any, channels: any[]): string[] {
	const problems: string[] = [];
	const check = (name: string, ok: boolean) => {
		if (!ok) problems.push(`${name}和提交的不一致`);
	};
	check("标题", got?.name === sent.name);
	check("货号", got?.parent_sku === sent.parent_sku);
	check("类目", JSON.stringify((got?.category_path ?? []).map(Number)) === JSON.stringify(sent.category_path));
	check("重量", num(got?.weight?.value) === num(sent.weight.value));
	check("主图", JSON.stringify((got?.images ?? []).map(imageId)) === JSON.stringify(sent.images));
	check("尺码表", imageId(got?.size_chart_info?.size_chart) === imageId(sent.size_chart_info.size_chart));
	check(
		"备货天数",
		Object.entries(sent.pre_order_info).every(([k, v]) => got?.pre_order_info?.[k] === v),
	);
	const enabled = new Set(channels.filter((c) => c.enabled).map((c) => String(c.channel_id ?? c.channelid ?? "")));
	const wanted = new Set((sent.logistics_channels as any[]).filter((c) => c.enabled).map((c) => String(c.channelid)));
	check("物流渠道", enabled.size === wanted.size && [...wanted].every((c) => enabled.has(c)));
	const fieldsOf = (info: any) =>
		(JSON.parse(String(info?.description ?? "{}")).field_list ?? []).map((x: any) => [Number(x.type), Number(x.type) === 1 ? imageId(x.value) : x.value]);
	let desc = false;
	try {
		desc = JSON.stringify(fieldsOf(got?.description_info)) === JSON.stringify(fieldsOf(sent.description_info));
	} catch {
		/* 读回来的描述不是 JSON */
	}
	check("描述（字和详情图）", desc);
	const models = (got?.model_list ?? []) as any[];
	const bySku = new Map(models.map((m) => [String(m.sku ?? ""), m]));
	check("规格货号", models.length === bySku.size && bySku.size === sent.model_list.length && (sent.model_list as any[]).every((m) => bySku.has(m.sku)));
	for (const m of sent.model_list as any[]) {
		const g = bySku.get(m.sku);
		const stock =
			g?.stock_detail?.total_seller_stock ?? ((g?.stock_detail?.seller_stock_info ?? []) as any[]).reduce((n, s) => n + Number(s.sellable_stock ?? 0), 0);
		const price = g?.price_info?.input_normal_price ?? g?.price_info?.normal_price;
		if (
			!g ||
			JSON.stringify((g.tier_index ?? []).map(Number)) !== JSON.stringify(m.tier_index) ||
			num(price) !== num(m.price) ||
			num(stock) !== m.stock_setting_list[0].sellable_stock
		) {
			problems.push(`规格 ${m.sku} 的选项、售价或库存和提交的不一致`);
		}
	}
	const tiers = (got?.std_tier_variation_list ?? []) as any[];
	const opts = (list: any[]) => JSON.stringify((list ?? []).map((o) => [o.custom_value ?? "", o.image_id ? imageId(o.image_id) : ""]));
	check(
		"规格名称和规格图",
		tiers.length === sent.std_tier_variation_list.length &&
			(sent.std_tier_variation_list as any[]).every((t, i) => tiers[i]?.custom_value === t.custom_value && opts(tiers[i]?.value_list) === opts(t.value_list)),
	);
	return problems;
}

/** 建商品结果未知时按货号找：新建的是下架，在售列表里没有，翻全部商品；名字一样的再读详情核对货号 */
export async function findByParentSku(parentSku: string, name: string): Promise<string | null> {
	for (let page = 1; page <= 20; page++) {
		const r = await allProducts(page);
		for (const p of r.rows.filter((x) => x.name === name)) if ((await productInfo(p.productId)).parent_sku === parentSku) return p.productId;
		if (page * 48 >= r.total || r.rows.length === 0) break;
	}
	return null;
}

/** 建商品：在这家店的卖家中心页面里发 create_product_info（先建成下架），回商品 id。check 读回来逐项核对（刚建完读得到要几秒：对不上就隔 3 秒再读，最多 3 次） */
export const createListing: SubmitTool = {
	kind: "write",
	description: "建商品（先建成下架；只经上品的写工具 listing.publish）",
	params: z.object({ productInfo: z.record(z.string(), z.unknown()).describe("create_product_info 的 product_info"), productId: z.string().optional() }),
	submit: async (p) => {
		const w = await createProduct(p.productInfo);
		if (w.kind === "refused") return { kind: "refused", why: `${w.code ?? ""} ${w.why}`.trim() };
		if (w.kind !== "done") return w;
		const id = String(w.data?.product_id ?? w.data?.id ?? "");
		if (!/^\d+$/.test(id) || id === "0") return { kind: "unknown", why: "Shopee 说建好了，但没回商品 id" };
		return { kind: "done", data: { productId: id } };
	},
	check: async (p) => {
		let problems: string[] = [];
		for (let i = 0; i < 3; i++) {
			if (i) await sleep(3000);
			const info = await productInfo(p.productId);
			const path = (p.productInfo.category_path as number[]) ?? [];
			problems = readbackProblems(p.productInfo, info, await channels(p.productId, path[path.length - 1]!));
			if (!problems.length) break;
		}
		return { done: problems.length === 0, readback: { productId: p.productId, problems } };
	},
};

/** 上架：建好的商品从下架翻成在售（update_product_info 的 unlisted: false）。check 读回来确认在售（翻在售以后要十几秒才读得到：隔 3 秒读一次，最多 6 次） */
export const listProduct: SubmitTool = {
	kind: "write",
	description: "上架：下架 → 在售（只经上品的写工具 listing.publish）",
	params: z.object({ productId: z.string().regex(/^\d+$/).describe("商品 id") }),
	submit: async (p) => {
		const w = await setUnlisted(p.productId, false);
		return w.kind === "done" ? { kind: "done" } : w.kind === "refused" ? { kind: "refused", why: `${w.code ?? ""} ${w.why}`.trim() } : w;
	},
	check: async (p, _before, fresh) => {
		let info: any = null;
		for (let i = 0; i < (fresh ? 6 : 1); i++) {
			if (i) await sleep(3000);
			info = await productInfo(p.productId);
			if (Number(info.status) === 1 && !info.is_unlisted) return { done: true, readback: { status: info.status } };
			if (Number(info.status) === 3) return { done: false, readback: { status: info.status, why: "禁卖" } };
		}
		return { done: null, readback: { status: info?.status ?? null, unlisted: info?.is_unlisted ?? null } };
	},
};
