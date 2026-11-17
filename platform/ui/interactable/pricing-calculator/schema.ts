// 定价试算组件只保存店铺引用；模板参数和金额经只读业务工具现算。
import { z } from "zod";
import { title } from "../../props.ts";

export const description = "输入人民币进货价、重量和运费，按现行定价模板试算台币售价、人民币毛利及费用明细";
export const props = z.strictObject({ title, shop: z.string().trim().min(1) });
export type Props = z.infer<typeof props>;
export const actions = { settings: "listing.calculator-settings", calculate: "listing.calculator-preview" };
export const inputs = ["template", "costRmb", "weightKg", "freightRmb", "units", "priceTwd", "sellerDiscountTwd"];
export const examples: z.input<typeof props>[] = [{ shop: "cheeroutdoor", title: "定价模板" }];
