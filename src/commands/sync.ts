// x2 sync：读 Shopee 待出货的订单，整份写进 orders.json
import { toShipOrders } from "../site/shopee.ts";
import * as store from "../store.ts";

export async function sync(json: boolean): Promise<void> {
	const orders = await toShipOrders();
	await store.write("orders", { syncedAt: new Date().toISOString(), orders });
	const items = orders.reduce((n, o) => n + o.items.length, 0);
	console.log(json ? JSON.stringify({ orders: orders.length, items }) : `读到待出货的订单 ${orders.length} 张、${items} 项商品 → ${store.home}/orders.json`);
}
