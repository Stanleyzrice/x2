// x2 listing：上品（docs/listing.md）。
// x2 listing add <店> <1688 链接…> [--strategy 名字]   添加货源：一个货源 × 一家店一份商品稿
// x2 listing make [商品稿…]                           做商品稿：读货源、规格和核价、图、类目属性（不给就做所有还没做好的）
// x2 listing show <商品稿>                            写文案要用的事实（货源标题、规格、类目、属性、服务）
// x2 listing text <商品稿> --title … --description …  agent 写的标题和描述（也可以从 stdin 读 [{ id, title, description }]），写完马上台湾成品审核
// x2 listing audit [商品稿…]                          台湾成品审核（Gemini 看成品图和文案，挑简体字、错字、误译）
// x2 listing drop <商品稿> <选项名或货号…>             去掉人不要的规格（例 店里接不了的「定製」）：人说了才用
// x2 listing list                                    所有商品稿走到哪了
import { syncImages } from "../check/index.ts";
import { db } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { make, settingsOf } from "../listing/make.ts";
import { auditKey, auditTaiwan } from "../listing/audit.ts";
import { productOf } from "../listing/ready.ts";
import { textProblems } from "../listing/text.ts";
import { keptVariants, matchVariants } from "../listing/variants.ts";
import { offerIdOf } from "../site/1688.ts";

const readStdin = async () => {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
};
const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const plain = (args: string[], ...flags: string[]) => args.filter((a, j) => !a.startsWith("--") && !flags.includes(args[j - 1] ?? ""));

export async function listingCommand(args: string[], json: boolean): Promise<void> {
	const [sub, ...rest] = args;
	const sql = await db();
	const out = (value: unknown, text: string) => console.log(json ? JSON.stringify(value) : text);

	if (sub === "add") {
		const [shop, ...links] = plain(rest, "--strategy");
		const strategy = flag(rest, "--strategy") ?? "人选";
		if (!shop || !links.length) throw new Usage("x2 listing add <店> <1688 链接…> [--strategy 名字]");
		const [st] = await sql`select name from strategies where name = ${strategy}`;
		if (!st) throw new Usage(`没有策略「${strategy}」：先 x2 strategy add ${strategy} --bet "假设" --how "选品方法"`);
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
			// 做好的图马上放进 NocoDB 的附件（不等下一次 x2 status）
			const [l] = await sql`select * from listings where id = ${id}`;
			if (l) await syncImages(sql, l);
		}
		return out(results, results.map((r) => `商品稿 ${r.id}：${r.problems.length ? `\n  ${r.problems.join("\n  ")}` : "已做好，待写文案（x2 listing show " + r.id + "）"}`).join("\n"));
	}

	if (sub === "show") {
		const id = plain(rest)[0];
		if (!id) throw new Usage("x2 listing show <商品稿>");
		const [l] = await sql`select * from listings where id = ${id}`;
		if (!l) throw new Usage(`没有商品稿 ${id}`);
		const facts = {
			id: String(l.id), shop: l.shop, offerTitle: l.offer?.title ?? null, category: l.category_name, attributes: l.attributes_text,
			specs: keptVariants((l.variants ?? []) as any[], l.removed_variants).map((v) => v.specs.map((x: any) => `${x.label}：${x.value}`).join("，") || "（单规格）"),
			weights: [...new Set(keptVariants((l.variants ?? []) as any[], l.removed_variants).map((v) => v.weightKg))], tags: l.offer?.tags ?? null,
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
		const audits = await audit(sql, results.filter((r) => r.saved).map((r) => r.id));
		return out({ text: results, audit: audits }, [...results.map((r) => `商品稿 ${r.id}：${r.saved ? "记下了" : r.problems.join("；")}`), ...audits.map(auditLine)].join("\n"));
	}

	if (sub === "audit") {
		let ids = plain(rest);
		if (!ids.length) ids = (await sql`select id::text from listings where not cancelled and product_id is null and title is not null order by id`).map((r) => r.id as string);
		const audits = await audit(sql, ids);
		return out(audits, audits.map(auditLine).join("\n") || "没有要审的商品稿");
	}

	if (sub === "drop") {
		const [id, ...names] = plain(rest);
		if (!id || !names.length) throw new Usage("x2 listing drop <商品稿> <选项名或货号…>");
		const [l] = await sql`select variants, removed_variants, problems from listings where id = ${id}`;
		if (!l) throw new Usage(`没有商品稿 ${id}`);
		const live = keptVariants(l.variants ?? [], l.removed_variants);
		const { skus, unknown } = matchVariants(live, names);
		if (unknown.length) throw new Usage(`商品稿 ${id} 的规格里没有：${unknown.join("、")}（x2 listing show ${id} 看规格）`);
		if (skus.length === live.length) throw new Usage("规格都去掉了：不上这个货源就在「商品稿」里勾「放弃」");
		const removed = [...new Set([...(l.removed_variants ?? []), ...skus])];
		await sql`update listings set removed_variants = ${sql.json(removed)}, updated_at = now() where id = ${id}`;
		const next = l.problems ? `x2 listing make ${id}（规格的问题要重新算）` : `x2 listing audit ${id}（规格变了，要再审）`;
		return out({ id, dropped: skus, left: live.length - skus.length }, `商品稿 ${id}：去掉 ${skus.length} 个规格，还剩 ${live.length - skus.length} 个\n下一步：${next}`);
	}

	if (sub === "list") {
		const rows = await sql`select id::text, shop, offer_id, strategy, title, step, step_detail, problems, product_id from listings where not cancelled order by id`;
		return out(rows, rows.length ? rows.map((r) => `${r.id} ${r.shop} ${r.offer_id} ${r.step ?? "（还没检查）"}${r.title ? `「${r.title}」` : ""}${r.problems ? `\n    ${String(r.problems).split("\n").join("\n    ")}` : ""}`).join("\n") : "还没有商品稿：x2 listing add <店> <1688 链接>");
	}

	throw new Usage("x2 listing add | make | show | text | audit | drop | list（见 docs/listing.md）");
}

type AuditResult = { id: string; ok: boolean | null; cached?: boolean; issues: string[] };
const auditLine = (a: AuditResult) => `商品稿 ${a.id} 台湾审核：${a.ok === null ? `审不了：${a.issues.join("；")}` : a.ok ? `通过${a.cached ? "（审过）" : ""}` : `未通过\n  ${a.issues.join("\n  ")}`}`;

/** 台湾成品审核：内容没变的不重审（审核键记在商品稿的 audit 里） */
async function audit(sql: Awaited<ReturnType<typeof db>>, ids: string[]): Promise<AuditResult[]> {
	const out: AuditResult[] = [];
	for (const id of ids) {
		const [l] = await sql`select * from listings where id = ${id}`;
		if (!l) { out.push({ id, ok: null, issues: ["没有这份商品稿"] }); continue; }
		const [row] = await sql`select * from shop_settings where shop = ${l.shop}`;
		const s = settingsOf(row);
		const r = productOf(l, s);
		if (!r.product) { out.push({ id, ok: null, issues: r.problems }); continue; }
		const mark = s.mark?.text ?? "";
		if (l.audit?.key === auditKey(r.product, mark)) { out.push({ id, ok: Boolean(l.audit.ok), cached: true, issues: [...(l.audit.textIssues ?? []), ...((l.audit.images ?? []) as any[]).flatMap((x) => x.issues)] }); continue; }
		console.error(`台湾成品审核：商品稿 ${id}`);
		const a = await auditTaiwan(r.product, mark);
		await sql`update listings set audit = ${sql.json(a as any)}, updated_at = now() where id = ${id}`;
		out.push({ id, ok: a.ok, issues: [...a.textIssues, ...a.images.flatMap((x) => x.issues.map((i) => `图 ${x.id}：${i}`))] });
	}
	return out;
}

