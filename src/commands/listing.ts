// x2 listing：上品（docs/listing.md）。
// x2 listing add <店> <1688 链接…> [--strategy 名字]   添加货源：一个货源 × 一家店一份商品稿
// x2 listing make [商品稿…]                           做商品稿：读货源、规格和核价、图、类目属性（不给就做所有还没做好的）
// x2 listing estimate <商品稿> [--weight <kg>] [--freight <元/件>]
//                                                    agent 估 1688 没给的重量、读不到的国内运费：只填空着的（人填过的不动），写完马上重新核价（不读 1688）
// x2 listing show <商品稿>                            写文案要用的事实（货源标题、规格的层和选项、类目、属性、服务）
// x2 listing text <商品稿> --title … --description … [--tiers <JSON>]
//                                                    agent 写的标题、描述和规格名（也可以从 stdin 读 [{ id, title, description, tiers: [{ name, options: [名字…] }] }]），
//                                                    写完马上 Gemini 文字检查
// x2 listing audit [商品稿…]                          Gemini 文字检查（看文案和加水印之前的图，挑简体字、错字、误译）：只提示，挑出的问题带编号写进说明；
//                                                    详情图、不是封面的主图上后加的文案 x2 去掉
// x2 listing keep <商品稿> <主图 N、详情图 N…>          保留的图：x2 去掉的放回来，以后检查再挑它也不去掉（人说了才用）
// x2 listing drop <商品稿> <选项名、层名:选项名或货号…> [--merge]
//                                                    去掉人不要的规格（例 店里接不了的「定製」）：人说了才用
// x2 listing list                                    所有商品稿走到哪了
import { z } from "zod";
import { syncImages } from "../check/index.ts";
import { db, type Sql } from "../db/index.ts";
import { Usage } from "../errors.ts";
import { estimateNeeds, freightOf, make, pricingProblems, savePrices, settingsOf } from "../listing/make.ts";
import { type Audit, AUDIT_DROP, auditDropped, type AuditIssue, auditIssues, auditKey, dropAudited, issueLine, restoreAudited, textCheck } from "../listing/audit.ts";
import { type Pic, type Pics, unmarked } from "../listing/images.ts";
import { imageNames, LABEL, numbered } from "../listing/product.ts";
import { productOf } from "../listing/ready.ts";
import { textProblems } from "../listing/text.ts";
import { dropSpecs, isSingle, OLD_SPECS, priceRange, removedOf, renameSpecs, specsOf, specsText, tierNames } from "../listing/variants.ts";
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
			const r = await make(sql, id);
			// 做好的图马上放进 NocoDB 的附件（不等下一次 x2 status）；缺重量、国内运费的告诉 agent 估，定不了价的、超过上限的现算
			const [l] = await sql`select * from listings where id = ${id}`;
			if (l) await syncImages(sql, l);
			const specs = l ? specsOf(l.variants) : null;
			const needs = l ? estimateNeeds(l) : [];
			results.push({ ...r, needs, problems: [...r.problems, ...(specs ? pricingProblems(specs, needs) : [])] });
		}
		const hint = (r: { id: string; needs: string[] }) => (r.needs.length ? `\n  估：x2 listing estimate ${r.id}${r.needs.includes("重量") ? " --weight <kg>" : ""}${r.needs.includes("国内运费") ? " --freight <元/件>" : ""}` : "");
		return out(results, results.map((r) => `商品稿 ${r.id}：${r.problems.length ? `\n  ${r.problems.join("\n  ")}${hint(r)}` : "已做好，待写文案（x2 listing show " + r.id + "）"}`).join("\n"));
	}

	if (sub === "estimate") {
		// agent 估 1688 没给的重量、读不到的国内运费：只填空着的、缺的（人填过的不动），写完马上重新核价（不读 1688）
		const usage = "x2 listing estimate <商品稿> [--weight <kg>] [--freight <元/件>]（1688 没给的重量往重了估，轻的写 1；读不到的国内运费往高了估）";
		const id = plain(rest, "--weight", "--freight")[0];
		const given = z.object({ weight: z.coerce.number().positive().finite().optional(), freight: z.coerce.number().nonnegative().finite().optional() })
			.safeParse({ weight: flag(rest, "--weight"), freight: flag(rest, "--freight") });
		if (!id || !given.success || (given.data.weight === undefined && given.data.freight === undefined)) throw new Usage(usage);
		const [l] = await sql`select * from listings where id = ${id}`;
		if (!l) throw new Usage(`没有商品稿 ${id}`);
		if (!l.offer || !specsOf(l.variants)) throw new Usage(`商品稿 ${id} 还没做好：先 x2 listing make ${id}`);
		const needs = estimateNeeds(l);
		const notes: string[] = [], set: Record<string, number> = {};
		const { weight, freight } = given.data;
		if (weight !== undefined) {
			if (l.weight_kg !== null) notes.push(`重量：已有 ${Number(l.weight_kg)} kg（人填的或估过的），不改`);
			else if (!needs.includes("重量")) notes.push("重量：1688 给了每个规格的重量，不用估");
			else { set.weight_kg = weight; notes.push(`重量：记为 ${weight} kg`); }
		}
		if (freight !== undefined) {
			const known = freightOf(l.offer, null);
			if (l.freight_rmb !== null) notes.push(`国内运费：已有 ${Number(l.freight_rmb)} 元/件（人填的或估过的），不改`);
			else if (known !== null) notes.push(`国内运费：${l.offer.tags?.freeShipping ? "货源包邮" : `1688 读得到（${known} 元/件）`}，不用估`);
			else { set.freight_rmb = freight; notes.push(`国内运费：记为 ${freight} 元/件`); }
		}
		// 只写还空着的（两个 x2 同时估，先写的算）
		if (set.weight_kg !== undefined) await sql`update listings set weight_kg = ${set.weight_kg}, updated_at = now() where id = ${id} and weight_kg is null`;
		if (set.freight_rmb !== undefined) await sql`update listings set freight_rmb = ${set.freight_rmb}, updated_at = now() where id = ${id} and freight_rmb is null`;
		const [now] = await sql`select * from listings where id = ${id}`;
		const [row] = await sql`select * from shop_settings where shop = ${now!.shop}`;
		await savePrices(sql, now, settingsOf(row));
		const left = estimateNeeds(now);
		const problems = [...String(now!.problems ?? "").split("\n").filter(Boolean), ...pricingProblems(specsOf(now!.variants)!, left)];
		return out({ id, notes, needs: left, problems, prices: now!.variants_text }, [
			`商品稿 ${id}：${notes.join("；")}`, `规格和价格：\n  ${String(now!.variants_text ?? "").split("\n").join("\n  ")}`,
			problems.length ? `还有：${problems.join("；")}` : "核价好了（下一步看 x2 status）",
		].join("\n"));
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
			variants: specs?.variants.length ?? 0, tiers, weights: [...new Set((specs?.variants ?? []).map((v) => v.weightKg))], needs: estimateNeeds(l), tags: l.offer?.tags ?? null,
			title: l.title, description: l.description, problems: l.offer && !specs ? OLD_SPECS : l.problems,
		};
		return out(facts, JSON.stringify(facts, null, 1));
	}

	if (sub === "text") {
		const usage = "x2 listing text <商品稿> --title … --description … [--tiers '[{ \"name\": \"款式\", \"options\": [\"…\"] }]']，或从 stdin 读 [{ id, title, description, tiers }]";
		const items: { id: string; title: string; description: string; tiers?: unknown }[] = [];
		const id = plain(rest, "--title", "--description", "--tiers")[0];
		if (id) {
			const t = flag(rest, "--tiers");
			let tiers: unknown;
			if (t !== undefined) {
				try { tiers = JSON.parse(t); } catch { throw new Usage(`--tiers 要是 JSON：${usage}`); }
			}
			items.push({ id, title: flag(rest, "--title") ?? "", description: flag(rest, "--description") ?? "", tiers });
		} else {
			let input: unknown;
			try { input = JSON.parse(await readStdin()); } catch { throw new Usage(usage); }
			if (!Array.isArray(input)) throw new Usage(usage);
			items.push(...input.map((x) => ({ id: String(x.id), title: String(x.title ?? ""), description: String(x.description ?? ""), tiers: x.tiers })));
		}
		const results = [];
		for (const it of items) {
			// 标题、描述的硬规矩；规格名（交了的话）照 show 的层和选项一个一个改，过一遍规格的规矩。有一样不对就什么都不存
			const problems = textProblems(it.title.trim(), it.description.trim());
			const [l] = await sql`select variants, offer, removed_variants from listings where id = ${it.id}`;
			if (!l) { results.push({ id: it.id, saved: false, problems: ["没有这份商品稿"] }); continue; }
			let specs = specsOf(l.variants);
			if (it.tiers !== undefined) {
				const names = tierNames.safeParse(it.tiers);
				if (!names.success) problems.push("规格名：tiers 要是 [{ name: 层名, options: [选项名…] }]，个数、顺序照 x2 listing show");
				else if (!specs) problems.push(OLD_SPECS);
				else {
					const r = renameSpecs(specs, names.data);
					problems.push(...r.problems);
					specs = r.specs ?? specs;
				}
			}
			if (problems.length) { results.push({ id: it.id, saved: false, problems }); continue; }
			const renamed = it.tiers !== undefined && specs ? { variants: sql.json(specs), variants_text: specsText(specs, removedOf(l.offer, l.removed_variants)) } : {};
			await sql`update listings set ${sql({ title: it.title.trim(), description: it.description.trim(), ...renamed, updated_at: new Date() } as any)} where id = ${it.id}`;
			results.push({ id: it.id, saved: true, problems: [] });
		}
		const checks = await textChecks(sql, results.filter((r) => r.saved).map((r) => r.id));
		return out({ text: results, audit: checks }, [...results.map((r) => `商品稿 ${r.id}：${r.saved ? "记下了" : r.problems.join("；")}`), ...checks.map(checkLine)].join("\n"));
	}

	if (sub === "audit") {
		if (rest.some((a) => a.startsWith("--"))) throw new Usage("x2 listing audit [商品稿…]（Gemini 文字检查只提示；x2 去掉的图人要用：x2 listing keep <商品稿> <主图 N、详情图 N…>）");
		let ids = plain(rest);
		if (!ids.length) ids = (await sql`select id::text from listings where not cancelled and product_id is null and title is not null order by id`).map((r) => r.id as string);
		const checks = await textChecks(sql, ids);
		return out(checks, checks.map(checkLine).join("\n") || "没有要查的商品稿");
	}

	if (sub === "keep") {
		// 保留的图（人说了才用）：按附件上的名字（主图 N、详情图 N）找图；x2 去掉的放回来；都记进保留的图，以后检查再挑它也不去掉
		const [id, ...words] = plain(rest);
		const asked = [...new Set([...words.join(" ").matchAll(/(主图|详情图)\s*(\d+)/g)].map((m) => `${m[1]} ${m[2]}`))];
		if (!id || !asked.length) throw new Usage("x2 listing keep <商品稿> <主图 N、详情图 N…>（附件上的名字，见商品稿的说明；人说了才用）");
		const [l] = await sql`select * from listings where id = ${id}`;
		if (!l) throw new Usage(`没有商品稿 ${id}`);
		await syncImages(sql, l);
		const named = new Map<string, Pic>();
		for (const role of ["main", "detail"] as const) for (const { pic, n } of numbered(l.images ?? {}, role)) named.set(`${LABEL[role]} ${n}`, pic);
		const unknown = asked.filter((x) => !named.has(x));
		if (unknown.length) throw new Usage(`商品稿 ${id} 没有${unknown.join("、")}（有：${[...named.keys()].join("、") || "无"}）`);
		const deleted = asked.filter((x) => (l.removed_images ?? []).includes(named.get(x)!.imageId));
		if (deleted.length) throw new Usage(`商品稿 ${id} 的${deleted.join("、")}是人在 NocoDB 删的（已删除的图），不放回来`);
		const ids = [...new Set(asked.map((x) => named.get(x)!.imageId!))];
		const restored = asked.filter((x) => named.get(x)!.drop?.startsWith(AUDIT_DROP));
		await sql`update listings set images = ${sql.json(restoreAudited(l.images, ids) as any)}, kept_images = ${sql.json([...new Set([...(l.kept_images ?? []), ...ids])])}, updated_at = now() where id = ${id}`;
		const checks = await textChecks(sql, [id]);
		return out({ id, kept: asked, restored, audit: checks }, [`商品稿 ${id}：${asked.join("、")}记进保留的图${restored.length ? `，${restored.join("、")}放回来了` : ""}`, ...checks.map(checkLine)].join("\n"));
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

	throw new Usage("x2 listing add | make | estimate | show | text | audit | keep | drop | list（见 docs/listing.md）");
}

/** checked：查过了（false 是查不了，problems 是原因）；issues：挑出的问题（带编号，图写附件上的名字） */
type CheckResult = { id: string; checked: boolean; cached?: boolean; problems?: string[]; issues: AuditIssue[] };
const checkLine = (c: CheckResult) => {
	if (!c.checked) return `商品稿 ${c.id} Gemini 文字检查：查不了：${(c.problems ?? []).join("；")}`;
	const dropped = c.issues.filter((x) => x.status === "已去掉");
	return [
		`商品稿 ${c.id} Gemini 文字检查：${c.issues.length ? `挑出 ${c.issues.length} 条（只提示，写在说明里）` : "没挑出问题"}${c.cached ? "（查过）" : ""}`,
		...c.issues.map((x) => `  ${issueLine(x)}`),
		...(dropped.length ? [`  x2 去掉的图人说要用才放回来：x2 listing keep ${c.id} ${dropped.map((x) => x.name ?? x.image).join(" ")}`] : []),
	].join("\n");
};

/** 现在这份商品稿：先把人在 NocoDB 删的图记下来（删了的不查），再组商品 */
async function listingNow(sql: Sql, id: string) {
	const [l] = await sql`select * from listings where id = ${id}`;
	if (!l) return null;
	await syncImages(sql, l);
	const [row] = await sql`select * from shop_settings where shop = ${l.shop}`;
	return { l, kept: (l.kept_images ?? []) as string[], r: productOf(l, settingsOf(row)) };
}

/** 挑出后加文案的详情图、不是封面的主图：x2 去掉以后最多再查几轮 */
const MAX_RECHECK = 2;

/** Gemini 文字检查：内容没变的不重查（检查键记在商品稿的 audit 里）。看的是加水印之前的图（unmarked）。
 * 挑出的图 x2 能去掉的去掉（不进已删除的图），重组商品再查，NocoDB 的附件跟着变 */
async function textChecks(sql: Sql, ids: string[]): Promise<CheckResult[]> {
	const out: CheckResult[] = [];
	for (const id of ids) {
		let c = await listingNow(sql, id);
		if (!c) { out.push({ id, checked: false, problems: ["没有这份商品稿"], issues: [] }); continue; }
		if (!c.r.product) { out.push({ id, checked: false, problems: c.r.problems, issues: [] }); continue; }
		let a = c.l.audit as Audit | null;
		const cached = a?.key === auditKey(c.r.product);
		if (!cached) {
			for (let round = 0; c.r.product; round++) {
				console.error(`Gemini 文字检查：商品稿 ${id}${round ? `（去掉挑出的图以后第 ${round} 次再查）` : ""}`);
				const pics = (c.l.images ?? {}) as Pics;
				a = await textCheck(c.r.product, { image: (x) => unmarked(sql, pics, x), kept: c.kept, canDrop: round < MAX_RECHECK });
				const drops = a.images.filter((x) => x.dropped);
				if (!drops.length) break;
				await sql`update listings set images = ${sql.json(dropAudited(c.l.images, drops) as any)}, updated_at = now() where id = ${id}`;
				c = (await listingNow(sql, id))!;
			}
			if (!c.r.product) { out.push({ id, checked: false, problems: c.r.problems, issues: [] }); continue; }
			// x2 去掉的图（这一次的、以前的）也记进检查结果：人看得到，要用可以保留
			a = { ...a!, images: [...auditDropped(c.l.images), ...a!.images] };
			await sql`update listings set audit = ${sql.json(a as any)}, updated_at = now() where id = ${id}`;
		}
		const issues = auditIssues(a!, c.kept, imageNames(c.l.images ?? {}, specsOf(c.l.variants)));
		out.push({ id, checked: true, ...(cached ? { cached } : {}), issues });
	}
	return out;
}
