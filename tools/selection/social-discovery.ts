import { z } from "zod";
import { noteSchema } from "../../connectors/sites/xiaohongshu/index.ts";
import type { researchQuerySchema, SocialEvidence } from "../../platform/ui/interactable/selection/contract.ts";

const taipeiDate = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
const normal = (value: string) =>
	value
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s\p{P}\p{S}]/gu, "");
export const taiwanShopee = (value: string) => /台灣|臺灣|台湾|taiwan/i.test(value) && /蝦皮|虾皮|shopee/i.test(value);
export const noteListSchema = z.array(noteSchema);
export type SocialNote = z.output<typeof noteSchema>;
type Query = z.output<typeof researchQuerySchema>;
export type GroundedNote = SocialEvidence["note"];
const modifiers = /(防水|防風|遮雨|保暖|加厚|加絨|立體|觸控|可調式|免打孔)/g;

export function socialLookupWords<T extends { word: string }>(keyword: string, matchTerms: string[], words: T[]): T[] {
	const name = normal(keyword);
	const core = name.replace(modifiers, "");
	if (core.length < 2) return [];
	const terms = matchTerms.map(normal).filter((term) => term.length >= 3);
	return words
		.flatMap((entry) => {
			const native = normal(entry.word);
			if (native === name) return [{ entry, rank: 100 }];
			if (native.length < 3) return [];
			if (native === core) return [{ entry, rank: 80 }];
			if (core.includes(native) || native.includes(core)) return [{ entry, rank: 50 + Math.min(native.length, 20) }];
			return terms.some((term) => native.includes(term)) ? [{ entry, rank: 30 - Math.min(native.length, 20) }] : [];
		})
		.sort((a, b) => b.rank - a.rank)
		.slice(0, 2)
		.map(({ entry }) => entry);
}

export function dateWindow(now: Date, days: number) {
	const today = taipeiDate.format(now);
	const since = new Date(Date.parse(today) - (days - 1) * 86400000).toISOString().slice(0, 10);
	return { today, since };
}

export const photoTranscriptSchema = z.strictObject({
	images: z.array(z.strictObject({ index: z.number().int().positive(), text: z.string().trim().max(2500) })).max(10),
});

type NoteImage = { noteId: string; photo: SocialNote["photos"][number] };
export function imagesForNotes(notes: Iterable<SocialNote>): NoteImage[] {
	const byDetail = [...notes].filter((note) => taiwanShopee(note.title + note.body)).sort((a, b) => b.photos.length - a.photos.length);
	const out: NoteImage[] = [];
	for (const note of byDetail) {
		const photos = note.photos.length > 3 ? note.photos.slice(2) : note.photos;
		const count = Math.min(photos.length, 8, 10 - out.length);
		for (let i = 0; i < count; i++) {
			const position = Math.round((i * (photos.length - 1)) / Math.max(1, count - 1));
			out.push({ noteId: note.id, photo: photos[position]! });
		}
		if (out.length === 10) break;
	}
	return out;
}

export function groundedNote(
	query: Query,
	notes: ReadonlyMap<string, SocialNote>,
	transcripts: ReadonlyMap<string, string>,
	since: string,
	today: string,
): GroundedNote | null {
	const reference = query.note;
	const post = reference && notes.get(reference.noteId);
	if (!reference || !post || post.publishedAt < since || post.publishedAt > today || post.url !== `https://www.xiaohongshu.com/explore/${post.id}`) return null;
	const text = `${post.title}\n${post.body}`;
	const excerpt = reference.part === 0 ? text : transcripts.get(`${post.id}:${reference.part}`);
	if (!excerpt || !normal(excerpt).includes(normal(reference.quote))) return null;
	const market = reference.marketQuote;
	if (!taiwanShopee(market) || ![text, excerpt].some((part) => normal(part).includes(normal(market)))) return null;
	if (normal(reference.quote).length < 4 || reference.matchTerms.some((term) => normal(term).length < 2)) return null;
	return { url: post.url, publishedAt: post.publishedAt, title: post.title, reference };
}

const marketItem = z.looseObject({
	itemId: z.union([z.string(), z.number()]),
	shopId: z.union([z.string(), z.number()]),
	siteId: z.union([z.string(), z.number()]),
	itemName: z.string(),
	itemDataList: z.array(z.unknown()),
});
const marketSnapshot = z.looseObject({ sales30Day: z.union([z.string(), z.number()]), timest: z.union([z.string(), z.number()]) });
export type PurchaseExample = SocialEvidence["purchases"][number];
export function purchaseExamples(items: unknown[], terms: string[], since: string, today: string): PurchaseExample[] {
	const expected = terms.flatMap((term) => normal(term).split(modifiers).filter(Boolean));
	const examples = new Map<string, PurchaseExample>();
	for (const raw of items) {
		const item = marketItem.safeParse(raw);
		if (!item.success || Number(item.data.siteId) !== 1) continue;
		const { itemName, itemId, shopId, itemDataList } = item.data;
		if (!/^\d+$/.test(String(itemId)) || !/^\d+$/.test(String(shopId)) || !expected.every((part) => normal(itemName).includes(part))) continue;
		const snapshot = marketSnapshot.safeParse(itemDataList[0]);
		if (!snapshot.success) continue;
		const record = snapshot.data;
		const dataDate = String(record.timest).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
		const sales30Day = Number(record.sales30Day);
		if (!z.iso.date().safeParse(dataDate).success || dataDate < since || dataDate > today || !Number.isSafeInteger(sales30Day) || sales30Day <= 0) continue;
		examples.set(String(itemId), {
			itemId: String(itemId),
			title: itemName.slice(0, 300),
			url: `https://shopee.tw/product/${shopId}/${itemId}`,
			dataDate,
			sales30Day,
		});
		if (examples.size === 3) break;
	}
	return [...examples.values()];
}
