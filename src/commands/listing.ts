// x2 listing：上品（docs/listing.md）。
// x2 listing add <店> <1688 链接…> [--strategy 名字]   添加货源：一个货源 × 一家店一份商品稿
// x2 listing make [商品稿…]                           做商品稿：读货源、规格和核价、图、类目属性（不给就做所有还没做好的）
// x2 listing show <商品稿>                            写文案要用的事实（货源标题、规格的层和选项、类目、属性、服务）
// x2 listing text <商品稿> --title … --description …  agent 写的标题和描述（也可以从 stdin 读 [{ id, title, description }]），写完马上台湾成品审核
// x2 listing audit [商品稿…]                          台湾成品审核（Gemini 看成品图和文案，挑简体字、错字、误译）；挑出的问题有编号，挑出的图 x2 先处理
// x2 listing audit <商品稿> --accept <编号…>           放行审核挑出的问题（人看过说是误报或无妨，人说了才用）
// x2 listing drop <商品稿> <选项名、层名:选项名或货号…> [--merge]
//                                                    去掉人不要的规格（例 店里接不了的「定製」）：人说了才用
// x2 listing list                                    所有商品稿走到哪了
import { syncImages } from "../check/index.ts";
import { db, type Sql } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { make, settingsOf } from "../listing/make.ts";
import { acceptIssues, type Audit, auditDropped, type AuditIssue, auditIssues, auditKey, auditPassed, auditTaiwan, dropAudited, restoreAudited } from "../listing/audit.ts";
import { productOf } from "../listing/ready.ts";
import { textProblems } from "../listing/text.ts";
import { dropSpecs, isSingle, OLD_SPECS, priceRange, removedOf, specsOf, specsText } from "../listing/variants.ts";
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
		// 不给就做：还没做的、待补充的、规格是旧格式的
		if (!ids.length) ids = (await sql`select id::text from listings where not cancelled and product_id is null and (offer is null or problems is not null or jsonb_typeof(variants) is distinct from 'object') order by id`).map((r) => r.id as string);
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
		// 规格：每层（第几层、1688 的层名、现在的名字）、每个选项（第几个、1688 的原值、现在的名字、这个选项的售价范围）。单规格的不写规格名，tiers 是空的
		const specs = specsOf(l.variants);
		const tiers = specs && !isSingle(specs) ? specs.tiers.map((t, a) => ({
			n: a + 1, source: t.source, name: t.name,
			options: t.options.map((o, k) => ({ n: k + 1, source: o.source, name: o.name, price: priceRange(specs.variants.filter((v) => v.options[a] === k)) })),
		})) : [];
		const facts = {
			id: String(l.id), shop: l.shop, offerTitle: l.offer?.title ?? null, category: l.category_name, attributes: l.attributes_text,
			variants: specs?.variants.length ?? 0, tiers, weights: [...new Set((specs?.variants ?? []).map((v) => v.weightKg))], tags: l.offer?.tags ?? null,
			title: l.title, description: l.description, problems: l.offer && !specs ? OLD_SPECS : l.problems,
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
		const at = rest.indexOf("--accept");
		if (at >= 0) {
			const ids = rest.slice(0, at).filter((a) => !a.startsWith("--"));
			const ns = rest.slice(at + 1).filter((a) => !a.startsWith("--")).flatMap((a) => a.split(/[,，、]/)).filter(Boolean);
			if (ids.length !== 1 || !ns.length || ns.some((n) => !/^\d+$/.test(n))) throw new Usage("x2 listing audit <商品稿> --accept <编号…>（编号是审核结果里的；人说了才放行）");
			await accept(sql, ids[0]!, ns.map(Number));
			const audits = await audit(sql, ids);
			return out(audits, audits.map(auditLine).join("\n"));
		}
		let ids = plain(rest);
		if (!ids.length) ids = (await sql`select id::text from listings where not cancelled and product_id is null and title is not null order by id`).map((r) => r.id as string);
		const audits = await audit(sql, ids);
		return out(audits, audits.map(auditLine).join("\n") || "没有要审的商品稿");
	}

	if (sub === "drop") {
		// 按存着的规格去掉：整个选项（选项名，两层有同名的写「层名:选项名」）或一个规格（货号）。去掉的货号记进已移除的规格，规格跟着改
		const merge = rest.includes("--merge");
		const [id, ...names] = plain(rest);
		if (!id || !names.length) throw new Usage("x2 listing drop <商品稿> <选项名、层名:选项名或货号…> [--merge]（人说了才用；--merge 也是人说了才加）");
		const [l] = await sql`select variants, offer, removed_variants, problems from listings where id = ${id}`;
		if (!l) throw new Usage(`没有商品稿 ${id}`);
		const specs = specsOf(l.variants);
		if (!specs) throw new Usage(`商品稿 ${id} 的规格是旧格式：先重做商品稿（x2 listing make ${id}），再去掉`);
		const r = dropSpecs(specs, names, merge);
		if ("error" in r) throw new Usage(`商品稿 ${id}：${r.error}`);
		const removed = [...new Set([...(l.removed_variants ?? []), ...r.skus])];
		await sql`update listings set variants = ${sql.json(r.specs)}, variants_text = ${specsText(r.specs, removedOf(l.offer, removed))}, removed_variants = ${sql.json(removed)}, updated_at = now() where id = ${id}`;
		const next = l.problems ? `x2 listing make ${id}（规格的问题要重新算）` : `x2 listing audit ${id}（规格变了，要再审）`;
		const left = r.specs.variants.length;
		return out({ id, dropped: r.skus, left, merged: r.merged }, `商品稿 ${id}：去掉 ${r.skus.length} 个规格，还剩 ${left} 个${r.merged ? "，两层合成一层「款式」" : ""}\n下一步：${next}`);
	}

	if (sub === "list") {
		const rows = await sql`select id::text, shop, offer_id, strategy, title, step, step_detail, problems, product_id from listings where not cancelled order by id`;
		return out(rows, rows.length ? rows.map((r) => `${r.id} ${r.shop} ${r.offer_id} ${r.step ?? "（还没检查）"}${r.title ? `「${r.title}」` : ""}${r.problems ? `\n    ${String(r.problems).split("\n").join("\n    ")}` : ""}`).join("\n") : "还没有商品稿：x2 listing add <店> <1688 链接>");
	}

	throw new Usage("x2 listing add | make | show | text | audit | drop | list（见 docs/listing.md）");
}

/** ok：通过；null 是审不了（problems 是原因） */
type AuditResult = { id: string; ok: boolean | null; cached?: boolean; problems?: string[]; issues: AuditIssue[] };
const auditLine = (a: AuditResult) => {
	if (a.ok === null) return `商品稿 ${a.id} 台湾审核：审不了：${(a.problems ?? []).join("；")}`;
	const what = (x: AuditIssue) => (x.kind === "图" ? `${x.role ?? "图"} ${x.image}${x.where ? `（${x.where}）` : ""}` : "文案");
	const lines = a.issues.map((x) => `  ${x.n}. ${what(x)}：${x.text}${x.status === "待处理" ? "" : `（${x.status}）`}`);
	const hint = a.ok ? [] : [`  人看过说是误报或无妨的才放行：x2 listing audit ${a.id} --accept <编号…>`];
	return [`商品稿 ${a.id} 台湾审核：${a.ok ? "通过" : "未通过"}${a.cached ? "（审过）" : ""}`, ...lines, ...hint].join("\n");
};

/** 现在这份商品稿：先把人在 NocoDB 删的图记下来（删了的不审），再组商品 */
async function listingNow(sql: Sql, id: string) {
	const [l] = await sql`select * from listings where id = ${id}`;
	if (!l) return null;
	await syncImages(sql, l);
	const [row] = await sql`select * from shop_settings where shop = ${l.shop}`;
	const s = settingsOf(row);
	return { l, mark: s.mark?.text ?? "", kept: (l.kept_images ?? []) as string[], r: productOf(l, s) };
}

/** 挑出后加文案的详情图、不是封面的主图：x2 去掉以后最多再审几轮 */
const MAX_REAUDIT = 2;

/** 台湾成品审核：内容没变的不重审（审核键记在商品稿的 audit 里）。挑出的图 x2 能去掉的去掉（不进已删除的图），重组商品再审，NocoDB 的附件跟着变 */
async function audit(sql: Sql, ids: string[]): Promise<AuditResult[]> {
	const out: AuditResult[] = [];
	for (const id of ids) {
		let c = await listingNow(sql, id);
		if (!c) { out.push({ id, ok: null, problems: ["没有这份商品稿"], issues: [] }); continue; }
		if (!c.r.product) { out.push({ id, ok: null, problems: c.r.problems, issues: [] }); continue; }
		let a = c.l.audit as Audit | null;
		const cached = a?.key === auditKey(c.r.product, c.mark);
		if (!cached) {
			for (let round = 0; c.r.product; round++) {
				console.error(`台湾成品审核：商品稿 ${id}${round ? `（去掉挑出的图以后第 ${round} 次再审）` : ""}`);
				a = await auditTaiwan(c.r.product, c.mark, { kept: c.kept, canDrop: round < MAX_REAUDIT });
				const drops = a.images.filter((x) => x.action === "已去掉");
				if (!drops.length) break;
				await sql`update listings set images = ${sql.json(dropAudited(c.l.images, drops) as any)}, updated_at = now() where id = ${id}`;
				c = (await listingNow(sql, id))!;
			}
			if (!c.r.product) { out.push({ id, ok: null, problems: c.r.problems, issues: [] }); continue; }
			// x2 去掉的图（这一次的、以前的）也记进审核结果：人看得到，要用可以放行
			a = { ...a!, images: [...auditDropped(c.l.images), ...a!.images] };
			await sql`update listings set audit = ${sql.json(a as any)}, updated_at = now() where id = ${id}`;
		}
		out.push({ id, ok: auditPassed(a!, c.kept), ...(cached ? { cached } : {}), issues: auditIssues(a!, c.kept) });
	}
	return out;
}

/** 放行（人说了才用）：编号是上次审核结果里的，内容变了就对不上，要先重审 */
async function accept(sql: Sql, id: string, ns: number[]): Promise<void> {
	const c = await listingNow(sql, id);
	if (!c) throw new Usage(`没有商品稿 ${id}`);
	if (!c.r.product || !c.l.audit || c.l.audit.key !== auditKey(c.r.product, c.mark)) throw new Usage(`商品稿 ${id} 的内容和上次审核时不一样，编号作废：先 x2 listing audit ${id}，照新的编号放行`);
	const x = acceptIssues(c.l.audit, c.kept, ns, new Date().toISOString());
	if (x.unknown.length) throw new Usage(`商品稿 ${id} 的审核结果里没有第 ${x.unknown.join("、")} 条（x2 listing audit ${id} 看编号）`);
	// x2 去掉的图放行了：放回来（内容变了，接着会再审一次）
	const images = x.restore.length ? restoreAudited(c.l.images, x.restore) : c.l.images;
	await sql`update listings set audit = ${sql.json(x.audit as any)}, kept_images = ${sql.json(x.kept)}, images = ${sql.json(images)}, updated_at = now() where id = ${id}`;
}

