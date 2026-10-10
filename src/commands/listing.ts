// x2 listing：上品（docs/listing.md）。
// x2 listing add <店> <1688 链接…> [--strategy 名字 --why "选品理由"] [--evidence "依据"]
//                                                    添加货源：一个货源 × 一家店一份商品稿；记下选品理由、依据和选品快照（当时的策略、在用的选品规矩）。
//                                                    按策略选的（带 --strategy）--why 必填；几个链接一起加的理由是同一份
// x2 listing why <商品稿> --why "选品理由" [--evidence "依据"] [--force]
//                                                    补记选品理由、依据：没有选品快照的照现在补一份（标明补记）；已有理由的要 --force 才覆盖
// x2 listing make [商品稿…] [--jobs N]                做商品稿：读货源、规格和核价、图、类目属性（不给就做所有还没做好的）；几份同时做（默认 3）
// x2 listing quote <1688 链接或货源 id> [--shop 店] [--weight kg] [--freight 元/件]
//                                                    报价（选品用）：读货源、排规格、按店铺设置核价，和做商品稿同一套代码，不做图、不存库
// x2 listing estimate <商品稿> [--weight <kg>] [--freight <元/件>]
//                                                    agent 估 1688 没给的重量、读不到的国内运费：只填空着的（人填过的不动），写完马上重新核价（不读 1688）
// x2 listing show <商品稿>                            写文案要用的事实（货源标题、规格的层和选项、类目、属性、服务）
// x2 listing text <商品稿> --title … --description … [--tiers <JSON>] [--nickname 简称]
//                                                    agent 写的标题、描述、规格名和简称（也可以从 stdin 读 [{ id, title, description, tiers: [{ name, options: [名字…] }], nickname }]），
//                                                    写完马上 Gemini 文字检查
// x2 listing audit [商品稿…]                          Gemini 文字检查（看文案和加水印之前的图，挑简体字、错字、误译）：只提示，挑出的问题带编号写进说明；
//                                                    详情图、不是封面的主图上后加的文案 x2 去掉
// x2 listing keep <商品稿> <主图 N、详情图 N…>          保留的图：x2 去掉的放回来，以后检查再挑它也不去掉（人说了才用）
// x2 listing drop <商品稿> <选项名、层名:选项名或货号…> [--merge]
//                                                    去掉人不要的规格（例 店里接不了的「定製」）：人说了才用
// x2 listing approve <商品稿…>                        人在终端里说「批准」：替人勾「批准上架」（只勾待批准、待上架的；有一份不行就都不勾），x2 run 建商品、上架
// x2 listing noted <商品稿…>                          照人写的「备注」做完：记下看过的备注（备注再改，x2 status 的 todo 又给出来）
// x2 listing list                                    所有商品稿走到哪了
// 输出里商品稿都叫「简称（店铺，#编号）」（listingName）：编号是命令要用的
import { z } from "zod";
import { listingsCheck, syncImages } from "../check/index.ts";
import { db, type Sql } from "../db/index.ts";
import { NeedsHuman, Usage } from "../errors.ts";
import { estimateNeeds, freightOf, make, pricingProblems, quote, readOffer1688, savePrices, settingsOf } from "../listing/make.ts";
import { type Audit, AUDIT_DROP, auditDropped, type AuditIssue, auditIssues, auditKey, dropAudited, issueLine, restoreAudited, textCheck } from "../listing/audit.ts";
import { type Pic, type Pics, unmarked } from "../listing/images.ts";
import { imageNames, LABEL, numbered } from "../listing/product.ts";
import { each } from "../listing/queue.ts";
import { productOf } from "../listing/ready.ts";
import { type PickSnapshot, pickSnapshot, snapshotLine } from "../listing/pick.ts";
import { listingName, nicknameOpen, nicknameProblems, textProblems } from "../listing/text.ts";
import { dropSpecs, isSingle, OLD_SPECS, priceRange, removedOf, renameSpecs, specsOf, specsText, tierNames } from "../listing/variants.ts";
import { offerIdOf } from "../site/1688.ts";

const readStdin = async () => {
	const chunks: Buffer[] = [];
	for await (const c of process.stdin) chunks.push(c as Buffer);
	return Buffer.concat(chunks).toString("utf8");
};
const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const plain = (args: string[], ...flags: string[]) => args.filter((a, j) => !a.startsWith("--") && !flags.includes(args[j - 1] ?? ""));

/** 命令输出里商品稿的叫法：简称（店铺，#编号）；没有的编号照原样写 */
async function namesOf(sql: Sql, ids: string[]): Promise<(id: string) => string> {
	const valid = [...new Set(ids.filter((id) => /^\d+$/.test(id)))];
	const rows = valid.length ? await sql`select id::text, shop, nickname, offer_id, offer->>'title' as title from listings where id in ${sql(valid)}` : [];
	const names = new Map(rows.map((r) => [r.id as string, listingName({ id: r.id, shop: r.shop, nickname: r.nickname, offer_id: r.offer_id, offer: { title: r.title } })]));
	return (id) => names.get(id) ?? `商品稿 ${id}`;
}

export async function listingCommand(args: string[], json: boolean): Promise<void> {
	const [sub, ...rest] = args;
	const sql = await db();
	const out = (value: unknown, text: string) => console.log(json ? JSON.stringify(value) : text);

	if (sub === "add") {
		const usage = `x2 listing add <店> <1688 链接…> [--strategy 名字 --why "选品理由"] [--evidence "依据"]（带 --strategy 时 --why 必填）`;
		const [shop, ...links] = plain(rest, "--strategy", "--why", "--evidence");
		const text = z.string().trim().min(1);
		const a = z.object({ strategy: text.optional(), why: text.optional(), evidence: text.optional() }).refine((x) => !x.strategy || x.why)
			.safeParse({ strategy: flag(rest, "--strategy"), why: flag(rest, "--why"), evidence: flag(rest, "--evidence") });
		if (!shop || !links.length || !a.success) throw new Usage(usage);
		const strategy = a.data.strategy ?? "人选";
		const [st] = await sql`select name from strategies where name = ${strategy}`;
		if (!st) throw new Usage(`没有策略「${strategy}」：先 x2 strategy add ${strategy} --bet "假设" --how "选品方法"`);
		const [s] = await sql`select shop from shop_settings where shop = ${shop}`;
		if (!s) throw new Usage(`没有「${shop}」这家店（店铺设置里有的：${(await sql`select shop from shop_settings`).map((r) => r.shop).join("、")}）`);
		const offerIds = links.map((link) => {
			const id = offerIdOf(link);
			if (!id) throw new Usage(`认不出 1688 链接：${link}`);
			return id;
		});
		// 选品快照：这一刻的策略和在用的选品规矩，几个链接一起加的是同一份
		const snapshot = await pickSnapshot(sql, strategy);
		// 回库里存着的理由、依据、快照：已经有的商品稿是它原来的
		const added: { id: string; offerId: string; isNew: boolean; why: string | null; evidence: string | null; snapshot: PickSnapshot | null }[] = [];
		for (const offerId of offerIds) {
			// 已经有的不改（理由、快照照旧）：补理由用 x2 listing why
			const [r] = await sql`insert into listings (shop, offer_id, strategy, pick_why, pick_evidence, pick_snapshot)
				values (${shop}, ${offerId}, ${strategy}, ${a.data.why ?? null}, ${a.data.evidence ?? null}, ${sql.json(snapshot as any)})
				on conflict (shop, offer_id) do update set updated_at = listings.updated_at returning id::text, (xmax = 0) as is_new, pick_why, pick_evidence, pick_snapshot`;
			added.push({ id: r!.id, offerId, isNew: Boolean(r!.is_new), why: r!.pick_why, evidence: r!.pick_evidence, snapshot: r!.pick_snapshot });
		}
		const name = await namesOf(sql, added.map((a) => a.id));
		const old = added.some((x) => !x.isNew) && a.data.why ? "\n已经有了的不改理由、快照：补记用 x2 listing why <商品稿> --why …" : "";
		return out(added.map((a) => ({ ...a, name: name(a.id) })),
			added.map((a) => `${name(a.id)}${a.isNew ? "" : "：已经有了"}`).join("\n") + (added.some((x) => x.isNew) ? `\n选品快照：${snapshotLine(snapshot)}` : "") + `${old}\n下一步：x2 listing make`);
	}

	if (sub === "why") {
		// 补记：给已经加进来的商品稿写选品理由、依据。快照只补没有的（照现在的策略和规矩，标明补记）；加进来时记的快照不动
		const usage = `x2 listing why <商品稿> --why "选品理由" [--evidence "依据"] [--force]（已有理由的要 --force 才覆盖）`;
		const id = plain(rest, "--why", "--evidence")[0];
		const text = z.string().trim().min(1);
		const a = z.object({ id: z.string().regex(/^\d+$/), why: text, evidence: text.optional() })
			.safeParse({ id, why: flag(rest, "--why"), evidence: flag(rest, "--evidence") });
		if (!a.success) throw new Usage(usage);
		const [l] = await sql`select id::text, shop, nickname, offer_id, offer->>'title' as title, strategy, pick_why, pick_evidence, pick_snapshot from listings where id = ${a.data.id}`;
		if (!l) throw new Usage(`没有商品稿 ${a.data.id}`);
		const name = listingName({ ...l, offer: { title: l.title } });
		if (l.pick_why && !rest.includes("--force")) throw new Usage(`${name}已经有选品理由：${l.pick_why}\n要覆盖加 --force`);
		const snapshot: PickSnapshot = l.pick_snapshot ?? await pickSnapshot(sql, l.strategy, true);
		const evidence = a.data.evidence ?? l.pick_evidence ?? null;
		await sql`update listings set pick_why = ${a.data.why}, pick_evidence = ${evidence}, pick_snapshot = ${sql.json(snapshot as any)}, updated_at = now() where id = ${a.data.id}`;
		const notes = [
			l.pick_why ? `覆盖了原来的理由：${l.pick_why}` : "",
			l.pick_evidence && a.data.evidence ? `覆盖了原来的依据：${l.pick_evidence}` : "",
			l.pick_snapshot ? "选品快照是加进来时记的，不改" : "补记了选品快照（照现在的）",
		].filter(Boolean);
		return out({ id: a.data.id, name, why: a.data.why, evidence, snapshot, replaced: Boolean(l.pick_why), backfilled: !l.pick_snapshot },
			[`${name}：记下选品理由`, ...notes.map((x) => `  ${x}`), `  选品快照：${snapshotLine(snapshot)}`].join("\n"));
	}

	if (sub === "make") {
		// 几份同时做（--jobs，默认 3）：问 Gemini、交象寄、取图几份重叠，碰浏览器的按浏览器排队（src/listing/queue.ts）
		const usage = "x2 listing make [商品稿…] [--jobs N]（N：几份同时做，1–10，默认 3）";
		const jobs = Number(flag(rest, "--jobs") ?? 3);
		if (!Number.isInteger(jobs) || jobs < 1 || jobs > 10) throw new Usage(usage);
		let ids = plain(rest, "--jobs");
		// 不给就做：还没做的、待补充的、规格是旧格式的
		if (!ids.length) ids = (await sql`select id::text from listings where not cancelled and product_id is null and (offer is null or problems is not null or jsonb_typeof(variants) is distinct from 'object') order by id`).map((r) => r.id as string);
		if (!ids.length) return out([], "没有要做的商品稿");
		const before = await namesOf(sql, ids);
		const settled = await each(ids, jobs, async (id) => {
			const r = await make(sql, id, (line) => console.error(`${before(id)}：${line}`));
			// 做好的图马上放进 NocoDB 的附件（不等下一次 x2 status）；缺重量、国内运费的告诉 agent 估，定不了价的、超过上限的现算
			const [l] = await sql`select * from listings where id = ${id}`;
			if (l) await syncImages(sql, l);
			const specs = l ? specsOf(l.variants) : null;
			const needs = l ? estimateNeeds(l) : [];
			return { ...r, name: l ? listingName(l) : `商品稿 ${id}`, needs, problems: [...r.problems, ...(specs ? pricingProblems(specs, needs) : [])] };
		});
		const results = settled.flatMap((x) => (x.ok ? [x.value] : []));
		// 有出错的：做完的照样记在库里；要人处理的（登录、滑块）在前面，没开始的等处理好了再跑
		const rank = (f: { error: Error; started: boolean }) => (!f.started ? 2 : f.error instanceof NeedsHuman ? 0 : 1);
		const failed = settled.flatMap((x, i) => (x.ok ? [] : [{ id: ids[i]!, error: x.error as Error, started: x.started }])).sort((a, b) => rank(a) - rank(b));
		if (failed.length) {
			const lines = [
				...failed.map((f) => `${before(f.id)}：${f.started ? f.error.message : "没开始（先处理上面要人处理的，再跑 x2 listing make）"}`),
				...(results.length ? [`做完了：${results.map((r) => `${r.name}${r.problems.length ? `（${r.problems[0]}）` : ""}`).join("；")}`] : []),
			];
			throw failed.some((f) => f.error instanceof NeedsHuman) ? new NeedsHuman(lines.join("\n")) : new Error(lines.join("\n"));
		}
		const hint = (r: { id: string; needs: string[] }) => (r.needs.length ? `\n  估：x2 listing estimate ${r.id}${r.needs.includes("重量") ? " --weight <kg>" : ""}${r.needs.includes("国内运费") ? " --freight <元/件>" : ""}` : "");
		return out(results, results.map((r) => `${r.name}：${r.problems.length ? `\n  ${r.problems.join("\n  ")}${hint(r)}` : "已做好，待写文案（x2 listing show " + r.id + "）"}`).join("\n"));
	}

	if (sub === "quote") {
		// 报价（选品用）：1688 没给重量的按 --weight 算（默认 1 kg），读不到国内运费的按 --freight 算（默认 10 元），都往重了、往高了估；用了估的写出来
		const usage = "x2 listing quote <1688 链接或货源 id> [--shop 店] [--weight kg] [--freight 元/件]（店默认 cheeroutdoor；1688 没给的重量按 --weight 算，默认 1；读不到的国内运费按 --freight 算，默认 10）";
		const link = plain(rest, "--shop", "--weight", "--freight")[0];
		const offerId = link ? offerIdOf(link) : null;
		const opts = z.object({ shop: z.string().min(1).default("cheeroutdoor"), weight: z.coerce.number().positive().finite().default(1), freight: z.coerce.number().nonnegative().finite().default(10) })
			.safeParse({ shop: flag(rest, "--shop"), weight: flag(rest, "--weight"), freight: flag(rest, "--freight") });
		if (!offerId || !opts.success) throw new Usage(usage);
		const [row] = await sql`select * from shop_settings where shop = ${opts.data.shop}`;
		if (!row) throw new Usage(`没有「${opts.data.shop}」这家店（店铺设置里有的：${(await sql`select shop from shop_settings`).map((r) => r.shop).join("、")}）`);
		const q = quote(await readOffer1688(offerId), settingsOf(row), { weightKg: opts.data.weight, freightRmb: opts.data.freight });
		const freight = q.freightAssumed ? `${q.freightRmb} 元/件（1688 读不到，按 --freight 估的）` : q.tags.freeShipping ? "0（包邮）" : `${q.freightRmb} 元/件（1688 页面上寄到我们这里买 1 件）`;
		const tags = [q.tags.onePsale ? "一件代发" : "", q.tags.ship48h ? "48 小时发货" : q.tags.deliveryDays ? `${q.tags.deliveryDays} 天内发货` : ""].filter(Boolean).join("、") || "无";
		return out(q, [
			`${q.title}（${q.offerId}）`, `${q.shop} 售价 ${q.priceTwd}（${q.variants} 个规格）`, ...q.specs.split("\n").map((x) => `  ${x}`),
			`国内运费：${freight}`, `重量：${q.weightAssumed ? `${q.weightAssumed}（估的）` : "1688 都给了"}`, `服务：${tags}；起订量 ${q.minQty}`,
			...(q.problems.length ? [`问题：${q.problems.join("；")}`] : []),
		].join("\n"));
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
		if (!l.offer || !specsOf(l.variants)) throw new Usage(`${listingName(l)}还没做好：先 x2 listing make ${id}`);
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
		return out({ id, name: listingName(now!), notes, needs: left, problems, prices: now!.variants_text }, [
			`${listingName(now!)}：${notes.join("；")}`, `规格和价格：\n  ${String(now!.variants_text ?? "").split("\n").join("\n  ")}`,
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
			id: String(l.id), shop: l.shop, nickname: l.nickname ?? null, offerTitle: l.offer?.title ?? null, category: l.category_name, attributes: l.attributes_text,
			variants: specs?.variants.length ?? 0, tiers, weights: [...new Set((specs?.variants ?? []).map((v) => v.weightKg))], needs: estimateNeeds(l), tags: l.offer?.tags ?? null,
			title: l.title, description: l.description, problems: l.offer && !specs ? OLD_SPECS : l.problems,
		};
		return out(facts, JSON.stringify(facts, null, 1));
	}

	if (sub === "text") {
		const usage = "x2 listing text <商品稿> --title … --description … [--tiers '[{ \"name\": \"款式\", \"options\": [\"…\"] }]'] [--nickname 简称]，或从 stdin 读 [{ id, title, description, tiers, nickname }]";
		const items: { id: string; title: string; description: string; tiers?: unknown; nickname?: string }[] = [];
		const id = plain(rest, "--title", "--description", "--tiers", "--nickname")[0];
		if (id) {
			const t = flag(rest, "--tiers");
			let tiers: unknown;
			if (t !== undefined) {
				try { tiers = JSON.parse(t); } catch { throw new Usage(`--tiers 要是 JSON：${usage}`); }
			}
			items.push({ id, title: flag(rest, "--title") ?? "", description: flag(rest, "--description") ?? "", tiers, nickname: flag(rest, "--nickname") });
		} else {
			let input: unknown;
			try { input = JSON.parse(await readStdin()); } catch { throw new Usage(usage); }
			if (!Array.isArray(input)) throw new Usage(usage);
			items.push(...input.map((x) => ({ id: String(x.id), title: String(x.title ?? ""), description: String(x.description ?? ""), tiers: x.tiers, nickname: x.nickname === undefined || x.nickname === null ? undefined : String(x.nickname) })));
		}
		const results: { id: string; saved: boolean; problems: string[]; notes?: string[] }[] = [];
		for (const it of items) {
			// 标题、描述的硬规矩；规格名（交了的话）照 show 的层和选项一个一个改，过一遍规格的规矩；简称（交了的话）简体中文、最多 12 字。有一样不对就什么都不存
			const problems = [...textProblems(it.title.trim(), it.description.trim()), ...(it.nickname === undefined ? [] : nicknameProblems(it.nickname))];
			const [l] = await sql`select variants, offer, removed_variants, nickname from listings where id = ${it.id}`;
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
			// 简称只在空着、还是自动填的那个值时写：人在 NocoDB 改过的不改
			const nick = it.nickname === undefined ? {} : nicknameOpen(l) ? { nickname: it.nickname.trim() } : null;
			await sql`update listings set ${sql({ title: it.title.trim(), description: it.description.trim(), ...renamed, ...nick, updated_at: new Date() } as any)} where id = ${it.id}`;
			results.push({ id: it.id, saved: true, problems: [], ...(nick ? {} : { notes: [`简称：已有「${l.nickname}」，不改（只在空着、还是自动填的时候写）`] }) });
		}
		const name = await namesOf(sql, results.map((r) => r.id));
		const checks = await textChecks(sql, results.filter((r) => r.saved).map((r) => r.id));
		return out({ text: results.map((r) => ({ ...r, name: name(r.id) })), audit: checks }, [
			...results.map((r) => `${name(r.id)}：${r.saved ? ["记下了", ...(r.notes ?? [])].join("；") : r.problems.join("；")}`), ...checks.map(checkLine),
		].join("\n"));
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
		if (unknown.length) throw new Usage(`${listingName(l)}没有${unknown.join("、")}（有：${[...named.keys()].join("、") || "无"}）`);
		const deleted = asked.filter((x) => (l.removed_images ?? []).includes(named.get(x)!.imageId));
		if (deleted.length) throw new Usage(`${listingName(l)}的${deleted.join("、")}是人在 NocoDB 删的（已删除的图），不放回来`);
		const ids = [...new Set(asked.map((x) => named.get(x)!.imageId!))];
		const restored = asked.filter((x) => named.get(x)!.drop?.startsWith(AUDIT_DROP));
		await sql`update listings set images = ${sql.json(restoreAudited(l.images, ids) as any)}, kept_images = ${sql.json([...new Set([...(l.kept_images ?? []), ...ids])])}, updated_at = now() where id = ${id}`;
		const checks = await textChecks(sql, [id]);
		return out({ id, name: listingName(l), kept: asked, restored, audit: checks }, [`${listingName(l)}：${asked.join("、")}记进保留的图${restored.length ? `，${restored.join("、")}放回来了` : ""}`, ...checks.map(checkLine)].join("\n"));
	}

	if (sub === "drop") {
		// 按存着的规格去掉：整个选项（选项名，两层有同名的写「层名:选项名」）或一个规格（货号）。去掉的货号记进已移除的规格，规格跟着改
		const merge = rest.includes("--merge");
		const [id, ...names] = plain(rest);
		if (!id || !names.length) throw new Usage("x2 listing drop <商品稿> <选项名、层名:选项名或货号…> [--merge]（人说了才用；--merge 也是人说了才加）");
		const [l] = await sql`select id::text, shop, nickname, offer_id, variants, offer, removed_variants, problems from listings where id = ${id}`;
		if (!l) throw new Usage(`没有商品稿 ${id}`);
		const specs = specsOf(l.variants);
		if (!specs) throw new Usage(`${listingName(l)}的规格是旧格式：先重做商品稿（x2 listing make ${id}），再去掉`);
		const r = dropSpecs(specs, names, merge);
		if ("error" in r) throw new Usage(`${listingName(l)}：${r.error}`);
		const removed = [...new Set([...(l.removed_variants ?? []), ...r.skus])];
		await sql`update listings set variants = ${sql.json(r.specs)}, variants_text = ${specsText(r.specs, removedOf(l.offer, removed))}, removed_variants = ${sql.json(removed)}, updated_at = now() where id = ${id}`;
		const next = l.problems ? `x2 listing make ${id}（规格的问题要重新算）` : `x2 listing audit ${id}（规格变了，要再查）`;
		const left = r.specs.variants.length;
		return out({ id, name: listingName(l), dropped: r.skus, left, merged: r.merged }, `${listingName(l)}：去掉 ${r.skus.length} 个规格，还剩 ${left} 个${r.merged ? "，两层合成一层「款式」" : ""}\n下一步：${next}`);
	}

	if (sub === "approve") {
		// 和人在 NocoDB 里勾是同一个勾：先重算（内容的 hash 是最新的），勾上时触发器记下这一刻的内容；再重算一次，当前步骤变成已批准
		const ids = z.array(z.string().regex(/^\d+$/)).min(1).safeParse(plain(rest));
		if (!ids.success) throw new Usage("x2 listing approve <商品稿…>（人在终端里说了「批准」才用）");
		const want = [...new Set(ids.data)];
		const name = await namesOf(sql, want);
		await listingsCheck(sql, want);
		const rows = await sql`select id::text, step, approve from listings where id in ${sql(want)}`;
		const bad = want.flatMap((id) => {
			const r = rows.find((x) => x.id === id);
			if (!r) return [`没有商品稿 ${id}`];
			return r.approve || r.step === "待批准" || r.step === "待上架" ? [] : [`${name(id)}是「${r.step ?? "还没检查"}」，不是待批准`];
		});
		if (bad.length) throw new Usage(`${bad.join("\n")}\n一份都没勾`);
		await sql`update listings set approve = true where id in ${sql(want)} and not approve`;
		const r = await listingsCheck(sql, want);
		const done = want.map((id) => ({ id, name: name(id), step: r.steps.get(id)?.step ?? null, detail: r.steps.get(id)?.detail ?? null }));
		return out(done, [...done.map((x) => `${x.name}：${x.step}`), "下一步：x2 run"].join("\n"));
	}

	if (sub === "noted") {
		// 记下看过的备注原文；人写的备注不改
		const ids = z.array(z.string().regex(/^\d+$/)).min(1).safeParse(plain(rest));
		if (!ids.success) throw new Usage("x2 listing noted <商品稿…>（照备注做完以后）");
		const want = [...new Set(ids.data)];
		const rows = await sql`update listings set noted = note where id in ${sql(want)} returning id::text, note`;
		const missing = want.filter((id) => !rows.some((r) => r.id === id));
		if (missing.length) throw new Usage(`没有商品稿 ${missing.join("、")}`);
		const name = await namesOf(sql, want);
		return out(rows.map((r) => ({ id: r.id, name: name(r.id), note: r.note })), rows.map((r) => `${name(r.id)}：看过备注「${r.note ?? ""}」`).join("\n"));
	}

	if (sub === "list") {
		const rows = (await sql`select id::text, shop, nickname, offer_id, offer->>'title' as offer_title, strategy, title, step, step_detail, problems, product_id from listings where not cancelled order by id`)
			.map((r) => ({ ...r, name: listingName({ ...r, offer: { title: r.offer_title } }) }));
		const line = (r: any) => `${r.name} ${r.step ?? "（还没检查）"}${r.step_detail ? `：${String(r.step_detail).split("\n")[0]}` : ""}${r.problems ? `\n    ${String(r.problems).split("\n").join("\n    ")}` : ""}`;
		return out(rows, rows.length ? rows.map(line).join("\n") : "还没有商品稿：x2 listing add <店> <1688 链接>");
	}

	throw new Usage("x2 listing add | why | quote | make | estimate | show | text | audit | keep | drop | approve | noted | list（见 docs/listing.md）");
}

/** checked：查过了（false 是查不了，problems 是原因）；issues：挑出的问题（带编号，图写附件上的名字） */
type CheckResult = { id: string; name: string; checked: boolean; cached?: boolean; problems?: string[]; issues: AuditIssue[] };
const checkLine = (c: CheckResult) => {
	if (!c.checked) return `${c.name} Gemini 文字检查：查不了：${(c.problems ?? []).join("；")}`;
	const dropped = c.issues.filter((x) => x.status === "已去掉");
	return [
		`${c.name} Gemini 文字检查：${c.issues.length ? `挑出 ${c.issues.length} 条（只提示，写在说明里）` : "没挑出问题"}${c.cached ? "（查过）" : ""}`,
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
		if (!c) { out.push({ id, name: `商品稿 ${id}`, checked: false, problems: ["没有这份商品稿"], issues: [] }); continue; }
		const name = listingName(c.l);
		if (!c.r.product) { out.push({ id, name, checked: false, problems: c.r.problems, issues: [] }); continue; }
		let a = c.l.audit as Audit | null;
		const cached = a?.key === auditKey(c.r.product);
		if (!cached) {
			for (let round = 0; c.r.product; round++) {
				console.error(`Gemini 文字检查：${name}${round ? `（去掉挑出的图以后第 ${round} 次再查）` : ""}`);
				const pics = (c.l.images ?? {}) as Pics;
				a = await textCheck(c.r.product, { image: (x) => unmarked(sql, pics, x), kept: c.kept, canDrop: round < MAX_RECHECK });
				const drops = a.images.filter((x) => x.dropped);
				if (!drops.length) break;
				await sql`update listings set images = ${sql.json(dropAudited(c.l.images, drops) as any)}, updated_at = now() where id = ${id}`;
				c = (await listingNow(sql, id))!;
			}
			if (!c.r.product) { out.push({ id, name, checked: false, problems: c.r.problems, issues: [] }); continue; }
			// x2 去掉的图（这一次的、以前的）也记进检查结果：人看得到，要用可以保留
			a = { ...a!, images: [...auditDropped(c.l.images), ...a!.images] };
			await sql`update listings set audit = ${sql.json(a as any)}, updated_at = now() where id = ${id}`;
		}
		const issues = auditIssues(a!, c.kept, imageNames(c.l.images ?? {}, specsOf(c.l.variants)));
		out.push({ id, name, checked: true, ...(cached ? { cached } : {}), issues });
	}
	return out;
}
