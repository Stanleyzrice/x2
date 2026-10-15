// 文案的硬规矩（docs/listing.md「文案」）：标题 10–60 字、描述 3–3000 字、不写采购端和卖家话术；简称简体中文、最多 12 字。
// 写得好不好由 Gemini 文字检查和人审稿看
import * as OpenCC from "opencc-js";

export const MAX_NICKNAME = 12;
const chars = (s: string) => [...s].length;

/** 简称还没人写时，x2 先填 1688 标题的前 12 个字（去掉空白） */
export const autoNickname = (title: string | null | undefined): string | null => [...String(title ?? "").replace(/\s+/g, "")].slice(0, MAX_NICKNAME).join("") || null;

/** 做商品稿时的简称：空着的、还是上一版自动填的（prevTitle 是上一版货源快照的标题），换成这一版 1688 标题的前 12 个字；人改过、agent 写过的不动 */
export const nicknameFor = (current: string | null | undefined, prevTitle: string | null | undefined, title: string): string | null =>
	current?.trim() && current !== autoNickname(prevTitle) ? current : autoNickname(title);

/** agent 能不能写简称：空着的、还是自动填的那个值才写（人在网页上改过的不改） */
export const nicknameOpen = (l: { nickname?: string | null; offer?: { title?: string } | null }) => !l.nickname?.trim() || l.nickname === autoNickname(l.offer?.title);

let toCn: ((s: string) => string) | null = null;
/** 简称的规矩：简体中文，1–12 字；回问题 */
export function nicknameProblems(nickname: string): string[] {
	const n = nickname.trim();
	if (!n) return ["简称是空的"];
	const p: string[] = [];
	if (chars(n) > MAX_NICKNAME) p.push(`简称「${n}」 ${chars(n)} 字，最多 ${MAX_NICKNAME} 字`);
	const cn = (toCn ??= OpenCC.Converter({ from: "t", to: "cn" }))(n);
	if (cn !== n) p.push(`简称「${n}」有繁体字，要用简体中文（${cn}）`);
	return p;
}

/** 商品稿在收件箱、命令输出里的叫法：简称（店铺），命令要用编号的跟在后面，例 浴水生财猫狗地垫（cheeroutdoor，#2）。还没有简称的用 1688 标题的前 12 个字、货源 id */
export function listingName(l: { id?: unknown; shop?: string | null; nickname?: string | null; offer?: { title?: string } | null; offer_id?: string | null }, withId = true): string {
	const name = l.nickname?.trim() || autoNickname(l.offer?.title) || `货源 ${l.offer_id ?? ""}`.trim();
	return `${name}（${[l.shop, withId && l.id !== undefined ? `#${l.id}` : ""].filter(Boolean).join("，")}）`;
}

/** 标题、描述的硬规矩（docs/listing.md「文案」）；回问题 */
export function textProblems(title: string, description: string): string[] {
	const p: string[] = [];
	if (title.length < 10 || title.length > 60) p.push(`标题 ${title.length} 字，要 10–60 字`);
	if (description.length < 3 || description.length > 3000) p.push(`描述 ${description.length} 字，要 3–3000 字`);
	const banned = ["厂家", "廠家", "批发", "批發", "代发", "代發", "工厂", "工廠", "冲量", "沖量", "定制", "定製", "爆款", "直销", "直銷"];
	const hit = banned.filter((w) => title.includes(w) || description.includes(w));
	if (hit.length) p.push(`有采购端、卖家话术：${hit.join("、")}`);
	return p;
}

