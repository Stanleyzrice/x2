// 文案的硬规矩：标题 10–60 字、描述 3–3000 字、不写采购端和卖家话术；简称简体中文、最多 12 字。
// 写得好不好由 Gemini 文字检查和人审稿看
import * as OpenCC from "opencc-js";
import { type Specs, structureProblems } from "./variants.ts";

export const MAX_NICKNAME = 12;
const chars = (s: string) => [...s].length;
const BANNED = ["厂家", "廠家", "批发", "批發", "代发", "代發", "工厂", "工廠", "冲量", "沖量", "定制", "定製", "爆款", "直销", "直銷"];
const BANNED_PROBLEM = "有采购端、卖家话术：";

export const autoNickname = (title: string | null | undefined): string | null =>
	[...String(title ?? "").replace(/\s+/g, "")].slice(0, MAX_NICKNAME).join("") || null;

export const nicknameFor = (current: string | null | undefined, prevTitle: string | null | undefined, title: string): string | null =>
	current?.trim() && current !== autoNickname(prevTitle) ? current : autoNickname(title);

export const nicknameOpen = (l: { nickname?: string | null; offer?: { title?: string } | null }) =>
	!l.nickname?.trim() || l.nickname === autoNickname(l.offer?.title);

let toCn: ((s: string) => string) | null = null;
export function nicknameProblems(nickname: string): string[] {
	const n = nickname.trim();
	if (!n) return ["简称是空的"];
	const p: string[] = [];
	if (chars(n) > MAX_NICKNAME) p.push(`简称「${n}」 ${chars(n)} 字，最多 ${MAX_NICKNAME} 字`);
	const toSimplified = toCn ?? OpenCC.Converter({ from: "t", to: "cn" });
	toCn = toSimplified;
	const cn = toSimplified(n);
	if (cn !== n) p.push(`简称「${n}」有繁体字，要用简体中文（${cn}）`);
	return p;
}

export function listingName(
	l: { id?: unknown; shop?: string | null; nickname?: string | null; offer?: { title?: string } | null; offer_id?: string | null },
	withId = true,
): string {
	const name = l.nickname?.trim() || autoNickname(l.offer?.title) || `货源 ${l.offer_id ?? ""}`.trim();
	return `${name}（${[l.shop, withId && l.id !== undefined ? `#${l.id}` : ""].filter(Boolean).join("，")}）`;
}

export function textProblems(title: string, description: string): string[] {
	const p: string[] = [];
	if (title.length < 10 || title.length > 60) p.push(`标题 ${title.length} 字，要 10–60 字`);
	if (description.length < 3 || description.length > 3000) p.push(`描述 ${description.length} 字，要 3–3000 字`);
	const hit = BANNED.filter((w) => title.includes(w) || description.includes(w));
	if (hit.length) p.push(`${BANNED_PROBLEM}${hit.join("、")}`);
	return p;
}

/** 文字保存只刷新其自动校验；规格仅在显式重命名时按前后结构重算，其他硬问题和人工说明原样保留。 */
export function problemsAfterTextSave(
	previous: string | null,
	text: { title: string; description: string },
	renamed?: { before: Specs; after: Specs },
): string | null {
	const beforeStructure = new Set(renamed ? structureProblems(renamed.before) : []);
	const isTextProblem = (line: string) =>
		/^(?:标题 \d+ 字，要 10–60 字|描述 \d+ 字，要 3–3000 字)$/.test(line) ||
		(line.startsWith(BANNED_PROBLEM) &&
			line
				.slice(BANNED_PROBLEM.length)
				.split("、")
				.every((word) => BANNED.includes(word)));
	const kept = (previous ?? "").split("\n").filter((line) => line && !isTextProblem(line) && !beforeStructure.has(line));
	return [...new Set([...kept, ...textProblems(text.title, text.description), ...(renamed ? structureProblems(renamed.after) : [])])].join("\n") || null;
}
