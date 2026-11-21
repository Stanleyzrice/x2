import { z } from "zod";
import { title } from "../../props.ts";

export const description = "查看虾皮店铺流量、按日对比商品访客及点击来源，监控商品可售状态";
export const props = z.strictObject({ shop: z.literal("cheeroutdoor"), title });
export const actions = { snapshot: "store-monitor.snapshot", refresh: "store-monitor.refresh", daily: "store-monitor.daily" };
export const inputs = ["date"];
export const examples: z.input<typeof props>[] = [{ shop: "cheeroutdoor", title: "店铺监控" }];
export type Props = z.infer<typeof props>;

const count = z.number().int().nonnegative();
const id = z.string().regex(/^\d+$/);
const metric = z.object({ total: count, change: z.number().nullable() });
export const snapshotSchema = z.object({
	shop: z.literal("cheeroutdoor"),
	shopId: id,
	capturedAt: z.iso.datetime({ offset: true }),
	start: z.iso.date(),
	end: z.iso.date(),
	traffic: z.object({
		visitors: metric,
		clicks: metric,
		paid: metric,
		confirmed: count,
		points: z.array(z.object({ date: z.iso.date(), visitors: count.nullable(), clicks: count.nullable(), paid: count.nullable() })).min(1),
	}),
	products: z.object({
		inStock: count,
		outOfStock: count,
		unknownStock: count,
		review: count,
		offShelf: count,
		reported: count,
		impressions: count.nullable(),
		blocked: z.array(z.object({ id, name: z.string().min(1) })),
	}),
	restriction: z.object({ status: z.enum(["unverified", "confirmed"]), evidence: z.string().min(1) }),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

export const dailyReportSchema = z.object({
	date: z.iso.date(),
	rows: z.array(
		z.object({
			id,
			name: z.string(),
			visitors: count.nullable(),
			search: count.nullable(),
			recommendation: count.nullable(),
		}),
	),
});
export type DailyReport = z.infer<typeof dailyReportSchema>;
