import { z } from "zod";
import { hold, page } from "../../../platform/browser/browser.ts";
import { NeedsHuman } from "../../../platform/errors.ts";

export const origin = "https://www.xiaohongshu.com";
const noteId = /^[a-f0-9]{24}$/i;
const dateFormat = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" });
const loginFields = "input[placeholder*='手机号'], input[placeholder*='手機號'], iframe[src*='login']";
export const localDate = (date: Date) => dateFormat.format(date);

export function publishedDate(label: string, now: Date): string | null {
	const text = label.trim();
	if (/^编辑于|^編輯於/.test(text)) return null;
	const today = localDate(now);
	const relative = /^(\d+)\s*天前/.exec(text);
	if (/^(刚刚|剛剛|今天)/.test(text)) return today;
	const clock = /^(\d+)\s*(小[时時]|分[钟鐘])前/.exec(text);
	if (clock) {
		const minutes = Number(clock[1]) * (clock[2]?.startsWith("小") ? 60 : 1);
		return minutes <= 1440 ? localDate(new Date(now.valueOf() - minutes * 60000)) : null;
	}
	if (/^昨天/.test(text) || relative) {
		const days = relative ? Number(relative[1]) : 1;
		if (days > 3650) return null;
		return new Date(Date.parse(today) - days * 86400000).toISOString().slice(0, 10);
	}
	const absolute = /^(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})(?=\s|$)/.exec(text);
	if (!absolute) return null;
	const suffix = `-${absolute[2]!.padStart(2, "0")}-${absolute[3]!.padStart(2, "0")}`;
	let year = absolute[1] ?? today.slice(0, 4);
	if (!absolute[1] && year + suffix > today) year = String(Number(year) - 1);
	const date = year + suffix;
	const milliseconds = Date.parse(date);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().startsWith(date) && date <= today ? date : null;
}

export const noteSchema = z.strictObject({
	id: z.string().regex(noteId),
	url: z.string().url(),
	publishedAt: z.iso.date(),
	title: z.string().max(400),
	body: z.string().max(10000),
	photos: z.array(z.object({ index: z.number().int().positive(), url: z.string().url() })).max(20),
});
type Note = z.output<typeof noteSchema>;

export function photoUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "https:" && !u.username && !u.password && !u.port && /(^|\.)xhscdn\.com$/.test(u.hostname);
	} catch {
		return false;
	}
}

export async function photoBytes(url: string): Promise<string> {
	if (!photoUrl(url)) throw new Error("图片地址超出小红书图片域名");
	const response = await fetch(url, { redirect: "error", headers: { Referer: `${origin}/` }, signal: AbortSignal.timeout(8000) });
	const maxBytes = 2 * 1024 * 1024;
	const type = response.headers.get("content-type")?.split(";")[0];
	if (!response.ok || !response.body || !type || !["image/jpeg", "image/png", "image/webp"].includes(type)) throw new Error("小红书图片未返回可读取的格式");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for await (const value of response.body) {
		bytes += value.byteLength;
		if (bytes > maxBytes) throw new Error("小红书图片超过 2 MB");
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("base64");
}

export async function identify() {
	const tab = await page(origin);
	const logged = await tab.run(() => Boolean(document.querySelector("a[href*='/user/profile/']") && !document.querySelector("input[placeholder*='手机号']")));
	return logged ? { id: "xiaohongshu", name: "小红书" } : null;
}

export async function searchNotes(keyword: string, since: string, limit: number): Promise<Note[]> {
	return hold(origin, async () => {
		const tab = await page(origin);
		const url = `${origin}/search_result?keyword=${encodeURIComponent(keyword)}`;
		await tab.goto(url);
		const cards = await tab.run(async (loginFields) => {
			const deadline = Date.now() + 8000;
			while (Date.now() < deadline) {
				if (document.querySelector(loginFields) || /\/login(?:\/|$)/.test(location.pathname)) return null;
				const cards = [...document.querySelectorAll<HTMLElement>("section.note-item")].flatMap((card) => {
					const a = card.querySelector<HTMLAnchorElement>("a[href^='/explore/']");
					const id = a?.pathname.split("/").at(-1);
					return id
						? [
								{
									id,
									lines: card.innerText
										.split("\n")
										.map((line) => line.trim())
										.filter(Boolean),
								},
							]
						: [];
				});
				if (cards.length || /暂无搜索结果|没有找到相关|没有搜到/.test(document.body.innerText)) return cards;
				await new Promise<void>((done) => setTimeout(done, 250));
			}
			return undefined;
		}, loginFields);
		if (cards === null) throw new NeedsHuman("小红书需要登录，请在连接 X2 的浏览器完成登录");
		if (!cards) throw new Error("小红书搜索结果未加载，或页面结构已变化");
		const now = new Date();
		const recent = new Map<string, string>();
		for (const card of cards) {
			const publishedAt = card.lines
				.map((line) => publishedDate(line, now))
				.filter(Boolean)
				.at(-1);
			if (noteId.test(card.id) && publishedAt && publishedAt >= since) recent.set(card.id, publishedAt);
		}
		const notes: Note[] = [];
		for (const [id, cardDate] of [...recent.entries()].slice(0, limit)) {
			const result = await tab.run(
				async (id, loginFields) => {
					const login = () => document.querySelector(loginFields) || /\/login(?:\/|$)/.test(location.pathname);
					const selector = `section.note-item:has(a[href='/explore/${id}']) a.cover`;
					const wait = () => new Promise<void>((done) => setTimeout(done, 200));
					const cardDeadline = Date.now() + 5000;
					let card = document.querySelector<HTMLElement>(selector);
					while (!card && Date.now() < cardDeadline && !login()) {
						await wait();
						card = document.querySelector<HTMLElement>(selector);
					}
					if (login()) return null;
					if (!card) return undefined;
					card.click();
					const deadline = Date.now() + 6500;
					while (Date.now() < deadline) {
						if (login()) return null;
						const root = document.querySelector<HTMLElement>("#noteContainer");
						const date = root?.querySelector<HTMLElement>(".note-content .date")?.innerText.trim();
						const desc = root?.querySelector<HTMLElement>("#detail-desc");
						const title = root?.querySelector<HTMLElement>("#detail-title");
						if (location.pathname === `/explore/${id}` && root && (desc || title) && date && date !== "刚刚") {
							const photos = [...root.querySelectorAll<HTMLImageElement>(".swiper-slide:not(.swiper-slide-duplicate) img")].map((img, index) => ({
								index: index + 1,
								url: img.currentSrc || img.dataset.src || img.src,
							}));
							const result = { title: title?.innerText ?? "", body: desc?.innerText ?? "", date, photos };
							history.back();
							return result;
						}
						await wait();
					}
					return undefined;
				},
				id,
				loginFields,
			);
			if (result === null) throw new NeedsHuman("小红书需要登录，请在连接 X2 的浏览器完成登录");
			if (!result) {
				await tab.goto(url);
				continue;
			}
			const publishedAt = publishedDate(result.date, now) ?? cardDate;
			if (publishedAt < since || (!result.title && !result.body)) continue;
			notes.push(
				noteSchema.parse({
					id,
					url: `${origin}/explore/${id}`,
					publishedAt,
					title: result.title.slice(0, 400),
					body: result.body.slice(0, 10000),
					photos: result.photos.filter((photo) => photoUrl(photo.url)).slice(0, 20),
				}),
			);
		}
		if (recent.size && !notes.length) throw new Error("找到近期小红书结果，但未读到对应笔记正文");
		return notes;
	});
}
