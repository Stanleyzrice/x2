// 单稿物流渠道：只保存未建商品的显式渠道集合；null/旧稿缺列沿用店铺配置，不改变其他稿件。
import { z } from "zod";
import type { Sql } from "../../platform/db/index.ts";
import { Usage } from "../../platform/errors.ts";
import { parseJson, strs } from "../../platform/tool.ts";
import { CHANNELS, type ChannelOption } from "./product.ts";
import { ListingId, type ListingRow } from "./row.ts";

const known = new Set(CHANNELS.map((c) => String(c.channelid)));
export const channelIds = z
	.array(z.string().min(1))
	.min(1)
	.refine((ids) => ids.every((id) => known.has(id)), "包含不认识的物流渠道")
	.transform((ids) => [...new Set(ids)]);
export const channelOptionSchema = z.object({
	channelId: z.string().refine((id) => known.has(id), "不认识的物流渠道"),
	sizeId: z.number().int().nonnegative(),
	priceTwd: z.number().nonnegative().finite(),
});
const channelOptions = z
	.array(channelOptionSchema)
	.refine((items) => new Set(items.map((i) => i.channelId)).size === items.length, "同一物流渠道的档位输入重复");
export const listingChannelsParams = z
	.object({
		id: ListingId.describe("商品稿编号"),
		channels: strs("本稿启用的物流渠道id，逗号分隔；至少一个已知渠道").pipe(channelIds),
		options: z
			.preprocess(parseJson, channelOptions)
			.optional()
			.describe("逐启用渠道的显式档位与运费JSON：channelId、sizeId、priceTwd；不传保留原覆盖，[]清空档位覆盖"),
	})
	.refine((p) => !p.options?.some((o) => !p.channels.includes(o.channelId)), "物流档位只能设置本稿启用的渠道");
type Input = z.output<typeof listingChannelsParams>;
type ChannelRow = Pick<ListingRow, "id" | "product_id" | "listed_at" | "channel_ids" | "channel_options">;

export const channelsOf = (row: Pick<ListingRow, "channel_ids">, shopChannels: string[]): string[] => [...(row.channel_ids ?? shopChannels)];

export function channelsPatch(
	row: Pick<ListingRow, "product_id" | "listed_at" | "channel_options">,
	channels: string[],
	options?: ChannelOption[],
): { channel_ids: string[]; channel_options: ChannelOption[] | null } {
	if (row.product_id !== null || row.listed_at !== null) throw new Usage("商品已经建成或上架；草稿物流渠道工具不修改现有商品");
	const ids = channelIds.parse(channels);
	const selected = options ?? row.channel_options ?? null;
	const parsed = selected === null ? null : channelOptions.parse(selected);
	if (parsed?.some((o) => !ids.includes(o.channelId))) throw new Usage("物流档位只能设置本稿启用的渠道；修改渠道时须同时给出对应options或[]");
	return { channel_ids: ids, channel_options: parsed };
}

export async function setListingChannels(sql: Sql, p: Input) {
	return sql.begin(async (tx) => {
		const [row] = await tx<ChannelRow[]>`select id::text, product_id, listed_at, channel_ids, channel_options from listings where id = ${p.id} for update`;
		if (!row) throw new Usage(`没有商品稿 ${p.id}`);
		const patch = channelsPatch(row, p.channels, p.options);
		const [saved] = await tx<Pick<ChannelRow, "channel_ids" | "channel_options">[]>`update listings
			set channel_ids = ${tx.json(patch.channel_ids)}, channel_options = ${patch.channel_options === null ? null : tx.json(patch.channel_options)}, updated_at = now()
			where id = ${p.id} returning channel_ids, channel_options`;
		return {
			id: p.id,
			channels: saved!.channel_ids,
			options: saved!.channel_options,
			before: row.channel_ids ?? null,
			beforeOptions: row.channel_options ?? null,
		};
	});
}
