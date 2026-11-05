// 采购工作区固定店铺；网页只选订单和请求编号，精确货源与加购数量由服务端读取并冻结。
import { z } from "zod";
import { title } from "../../props.ts";

export const description = "Shopee 新订单提醒；人工开始采购，确认精确商品后加入 1688 购物车，由人付款下单";
export const props = z.strictObject({ title, shops: z.array(z.string().min(1)).min(1).default(["cheeroutdoor"]) });
export type Props = z.infer<typeof props>;
export const actions = { monitor: "orders.monitor", sync: "orders.monitor-sync", result: "orders.purchase-result" };
export const writeActions = { cart: "orders.purchase" };
export const writePreviews = { cart: "orders.purchase-preview" };
export const inputs = ["orders", "requestId"];
export const examples: z.input<typeof props>[] = [{ shops: ["cheeroutdoor"] }];
