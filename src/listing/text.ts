// 文案的硬规矩（docs/listing.md「文案」）：标题 10–60 字、描述 3–3000 字、不写采购端和卖家话术。写得好不好由台湾成品审核和人审稿看
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

