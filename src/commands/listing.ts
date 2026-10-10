// x2 listing：上品（docs/listing.md）。
// x2 listing add <店> <1688 链接…> [--strategy 名字]   要上的货源：一个货源 × 一家店一份商品稿
// x2 listing make [商品稿…]                           做商品稿：读货源、规格和核价、图、类目属性（不给就做所有还没做好的）
// x2 listing show <商品稿>                            写文案要用的事实（货源标题、规格、类目、属性、服务）
// x2 listing text <商品稿> --title … --description …  agent 写的标题和描述（也可以从 stdin 读 [{ id, title, description }]）
// x2 listing list                                    所有商品稿走到哪了
import { db } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { make } from "../listing/make.ts";
import { offerIdOf } from "../site/1688.ts";

const readStdin = async () => {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
};
const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const plain = (args: string[], ...flags: string[]) => args.filter((a, j) => !a.startsWith("--") && !flags.includes(args[j - 1] ?? ""));

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

export async function listingCommand(args: string[], json: boolean): Promise<void> {
	const [sub, ...rest] = args;
	const sql = await db();
	const out = (value: unknown, text: string) => console.log(json ? JSON.stringify(value) : text);

	if (sub === "add") {
		const [shop, ...links] = plain(rest, "--strategy");
		const strategy = flag(rest, "--strategy") ?? "人选";
		if (!shop || !links.length) throw new Usage("x2 listing add <店> <1688 链接…> [--strategy 名字]");
		const [s] = await sql`select shop from shop_settings where shop = ${shop}`;
		if (!s) throw new Usage(`没有「${shop}」这家店（店铺设置里有的：${(await sql`select shop from shop_settings`).map((r) => r.shop).join("、")}）`);
		const added: { id: string; offerId: string; isNew: boolean }[] = [];
		for (const link of links) {
			const offerId = offerIdOf(link);
			if (!offerId) throw new Usage(`认不出 1688 链接：${link}`);
			const [r] = await sql`insert into listings (shop, offer_id, strategy) values (${shop}, ${offerId}, ${strategy})
				on conflict (shop, offer_id) do update set updated_at = listings.updated_at returning id::text, (xmax = 0) as is_new`;
			added.push({ id: r!.id, offerId, isNew: Boolean(r!.is_new) });
		}
		return out(added, added.map((a) => `商品稿 ${a.id}：${shop} × ${a.offerId}${a.isNew ? "" : "（已经有了）"}`).join("\n") + "\n下一步：x2 listing make");
	}

	if (sub === "make") {
		let ids = plain(rest);
		if (!ids.length) ids = (await sql`select id::text from listings where not cancelled and product_id is null and (offer is null or problems is not null) order by id`).map((r) => r.id as string);
		if (!ids.length) return out([], "没有要做的商品稿");
		const results = [];
		for (const id of ids) {
			console.error(`── 商品稿 ${id}`);
			results.push(await make(sql, id));
		}
		return out(results, results.map((r) => `商品稿 ${r.id}：${r.problems.length ? `\n  ${r.problems.join("\n  ")}` : "做好了，等文案（x2 listing show " + r.id + "）"}`).join("\n"));
	}

	if (sub === "show") {
		const id = plain(rest)[0];
		if (!id) throw new Usage("x2 listing show <商品稿>");
		const [l] = await sql`select * from listings where id = ${id}`;
		if (!l) throw new Usage(`没有商品稿 ${id}`);
		const facts = {
			id: String(l.id), shop: l.shop, offerTitle: l.offer?.title ?? null, category: l.category_name, attributes: l.attributes_text,
			specs: ((l.variants ?? []) as any[]).map((v) => v.specs.map((x: any) => `${x.label}：${x.value}`).join("，") || "（单规格）"),
			weights: [...new Set(((l.variants ?? []) as any[]).map((v) => v.weightKg))], tags: l.offer?.tags ?? null,
			title: l.title, description: l.description, problems: l.problems,
		};
		return out(facts, JSON.stringify(facts, null, 1));
	}

	if (sub === "text") {
		const items: { id: string; title: string; description: string }[] = [];
		const id = plain(rest, "--title", "--description")[0];
		if (id) items.push({ id, title: flag(rest, "--title") ?? "", description: flag(rest, "--description") ?? "" });
		else {
			let input: unknown;
			try { input = JSON.parse(await readStdin()); } catch { throw new Usage("x2 listing text <商品稿> --title … --description …，或从 stdin 读 [{ id, title, description }]"); }
			items.push(...(input as any[]).map((x) => ({ id: String(x.id), title: String(x.title ?? ""), description: String(x.description ?? "") })));
		}
		const results = [];
		for (const it of items) {
			const problems = textProblems(it.title.trim(), it.description.trim());
			if (problems.length) { results.push({ id: it.id, saved: false, problems }); continue; }
			const r = await sql`update listings set title = ${it.title.trim()}, description = ${it.description.trim()}, audit = null, updated_at = now() where id = ${it.id} returning id`;
			results.push({ id: it.id, saved: r.length > 0, problems: r.length ? [] : ["没有这份商品稿"] });
		}
		return out(results, results.map((r) => `商品稿 ${r.id}：${r.saved ? "记下了" : r.problems.join("；")}`).join("\n"));
	}

	if (sub === "list") {
		const rows = await sql`select id::text, shop, offer_id, strategy, title, step, step_detail, problems, product_id from listings where not cancelled order by id`;
		return out(rows, rows.length ? rows.map((r) => `${r.id} ${r.shop} ${r.offer_id} ${r.step ?? "（还没检查）"}${r.title ? `「${r.title}」` : ""}${r.problems ? `\n    ${String(r.problems).split("\n").join("\n    ")}` : ""}`).join("\n") : "还没有商品稿：x2 listing add <店> <1688 链接>");
	}

	throw new Usage("x2 listing add | make | show | text | list（见 docs/listing.md）");
}
