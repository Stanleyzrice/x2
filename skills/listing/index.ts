// 上品（x2 listing <工具>）：把 1688 的货源做成店里在售的商品。x2 status 问它的检查（只看库里的）；建商品、上架是写（publish：人说了批准才调）。
// 输出里商品稿都叫「简称（店铺，#编号）」（listingName）：编号是工具要用的
import { z } from "zod";
import { offerIdOf } from "../../connectors/sites/1688/api.ts";
import { type Category, categoryTree } from "../../connectors/sites/shopee/products.ts";
import { inAccount } from "../../platform/browser/accounts.ts";
import { db, type Sql } from "../../platform/db/index.ts";
import { NeedsHuman, Usage } from "../../platform/errors.ts";
import { flag, get, parseJson, str, strs, type Toolkit } from "../../platform/tool.ts";
import type { Ran } from "../../platform/writes.ts";
import { addListings, type PickSnapshot, pickSnapshot, snapshotLine } from "../selection/index.ts";
import { AUDIT_DROP, type Audit, type AuditIssue, auditDropped, auditIssues, auditKey, dropAudited, issueLine, restoreAudited } from "./audit.ts";
import { CATEGORY_PROBLEM, leafPath } from "./category.ts";
import { unmarked } from "./images.ts";
import { make, readOffer1688, savePrices } from "./make.ts";
import type { Pic, Pics } from "./pics.ts";
import { estimateNeeds, freightOf, pricingProblems, quote, settingsOf } from "./pricing.ts";
import { imageNames, LABEL, numbered } from "./product.ts";
import { each } from "./queue.ts";
import { productOf } from "./ready.ts";
import { listingsCheck } from "./status.ts";
import { LISTING_TABLES } from "./tables.ts";
import { listingName, nicknameOpen, nicknameProblems, textProblems } from "./text.ts";
import { textCheck } from "./textcheck.ts";
import { dropSpecs, isSingle, OLD_SPECS, priceRange, removedOf, renameSpecs, specsOf, specsText, tierNames } from "./variants.ts";
import { LISTING_WRITES } from "./writes.ts";

/** 命令输出里商品稿的叫法：简称（店铺，#编号）；没有的编号照原样写 */
async function namesOf(sql: Sql, ids: string[]): Promise<(id: string) => string> {
	const valid = [...new Set(ids.filter((id) => /^\d+$/.test(id)))];
	const rows = valid.length ? await sql`select id::text, shop, nickname, offer_id, offer->>'title' as title from listings where id in ${sql(valid)}` : [];
	const names = new Map(
		rows.map((r) => [r.id as string, listingName({ id: r.id, shop: r.shop, nickname: r.nickname, offer_id: r.offer_id, offer: { title: r.title } })]),
	);
	return (id) => names.get(id) ?? `商品稿 ${id}`;
}

const id = z.string().regex(/^\d+$/, "商品稿编号是数字").describe("商品稿编号");
const ids = z
	.preprocess(
		(v) =>
			typeof v === "string"
				? v
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: v,
		z.array(z.string().regex(/^\d+$/, "商品稿编号是数字")).min(1),
	)
	.meta({ description: "商品稿编号，逗号分隔", placeholder: "1,2,…" });
const text = z.string().trim().min(1);

/** publish：人同意了，照检查算出来的写入（建商品、上架）一份商品稿一批；有一份不是待批准、待上架就都不做 */
export async function publishPlan(sql: Sql, want: string[]) {
	const name = await namesOf(sql, want);
	const r = await listingsCheck(sql, want);
	const bad = want.flatMap((id) => {
		if (r.ready.some((x) => x.id === id)) return [];
		const step = r.steps.get(id);
		return [step ? `${name(id)}是「${step.step}」，不是待批准、待上架` : `没有商品稿 ${id}`];
	});
	if (bad.length) throw new Usage(`${bad.join("\n")}\n一份都没做`);
	return r.ready.filter((x) => want.includes(x.id)).map((l) => l.writes);
}

/** 这一次碰过的商品稿（建商品、上架的写入）马上重算当前步骤，网页上不用等下一次 x2 status */
async function written(sql: Sql, ran: Ran[]): Promise<void> {
	const ids = [...new Set(ran.map((x) => x.id))];
	const rows = await sql`select params->>'listingId' as id from writes where id in ${sql(ids)} and op in ('建商品', '上架') and params ? 'listingId'`;
	if (rows.length) await listingsCheck(sql, [...new Set(rows.map((x) => x.id as string))]);
}

export const listing: Toolkit = {
	name: "listing",
	title: "上品：贴货源、做商品稿、写文案、建商品、上架",
	kind: "skill",
	tools: {
		add: {
			...get(
				"添加货源：一个货源 × 一家店一份商品稿；记下选品理由、依据和选品快照（当时的策略、在用的选品规矩）。按策略选的（带 --strategy）--why 必填；几个链接一起加的理由是同一份",
				z
					.object({
						shop: str("店（ni1206、cheeroutdoor）"),
						links: strs("1688 链接或货源 id"),
						strategy: text.optional().describe("按哪个策略选的"),
						why: text.optional().describe("选品理由（按策略选的必填）"),
						evidence: text.optional().describe("依据"),
					})
					.refine((x) => !x.strategy || x.why, { message: "带 --strategy 时 --why 必填" }),
				async (p) => {
					const sql = await db();
					const { added } = await addListings(sql, p);
					const name = await namesOf(
						sql,
						added.map((a) => a.id),
					);
					return added.map((a) => ({ ...a, name: name(a.id) }));
				},
			),
			text: (added) => {
				const fresh = added.find((x: any) => x.isNew);
				return [
					...added.map((a: any) => `${a.name}${a.isNew ? "" : "：已经有了"}`),
					...(fresh ? [`选品快照：${snapshotLine(fresh.snapshot)}`] : []),
					...(added.some((x: any) => !x.isNew) ? ["已经有了的不改理由、快照：补记用 x2 listing why --id <商品稿> --why …"] : []),
					"下一步：x2 listing make",
				].join("\n");
			},
		},
		why: {
			...get(
				"补记选品理由、依据：没有选品快照的照现在补一份（标明补记）；已有理由的要 --force 才覆盖",
				z.object({ id, why: text.describe("选品理由"), evidence: text.optional().describe("依据"), force: flag("覆盖已有的理由").default(false) }),
				async (p) => {
					const sql = await db();
					const [l] =
						await sql`select id::text, shop, nickname, offer_id, offer->>'title' as title, strategy, pick_why, pick_evidence, pick_snapshot from listings where id = ${p.id}`;
					if (!l) throw new Usage(`没有商品稿 ${p.id}`);
					const name = listingName({ ...l, offer: { title: l.title } });
					if (l.pick_why && !p.force) throw new Usage(`${name}已经有选品理由：${l.pick_why}\n要覆盖加 --force`);
					const snapshot: PickSnapshot = l.pick_snapshot ?? (await pickSnapshot(sql, l.strategy, true));
					const evidence = p.evidence ?? l.pick_evidence ?? null;
					await sql`update listings set pick_why = ${p.why}, pick_evidence = ${evidence}, pick_snapshot = ${sql.json(snapshot as any)}, updated_at = now() where id = ${p.id}`;
					const notes = [
						l.pick_why ? `覆盖了原来的理由：${l.pick_why}` : "",
						l.pick_evidence && p.evidence ? `覆盖了原来的依据：${l.pick_evidence}` : "",
						l.pick_snapshot ? "选品快照是加进来时记的，不改" : "补记了选品快照（照现在的）",
					].filter(Boolean);
					return { id: p.id, name, why: p.why, evidence, snapshot, replaced: Boolean(l.pick_why), backfilled: !l.pick_snapshot, notes };
				},
			),
			text: (r) => [`${r.name}：记下选品理由`, ...r.notes.map((x: string) => `  ${x}`), `  选品快照：${snapshotLine(r.snapshot)}`].join("\n"),
		},
		quote: {
			...get(
				"报价（选品用）：读货源、排规格、按店铺设置核价，和做商品稿同一套代码，不做图、不存库。1688 没给的重量按 --weight、读不到的国内运费按 --freight 算，都往重了、往高了估；用了估的写出来",
				z.object({
					link: str("1688 链接或货源 id"),
					shop: z.string().min(1).default("cheeroutdoor").describe("按哪家店的店铺设置核价"),
					weight: z.coerce.number().positive().finite().default(1).describe("1688 没给的重量（kg）"),
					freight: z.coerce.number().nonnegative().finite().default(10).describe("读不到的国内运费（元/件）"),
				}),
				async (p) => {
					const offerId = offerIdOf(p.link);
					if (!offerId) throw new Usage(`认不出 1688 链接：${p.link}`);
					const sql = await db();
					const [row] = await sql`select * from shop_settings where shop = ${p.shop}`;
					if (!row) throw new Usage(`没有「${p.shop}」这家店（店铺设置里有的：${(await sql`select shop from shop_settings`).map((r) => r.shop).join("、")}）`);
					return quote(await readOffer1688(offerId), settingsOf(row), { weightKg: p.weight, freightRmb: p.freight });
				},
			),
			text: (q) => {
				const freight = q.freightAssumed
					? `${q.freightRmb} 元/件（1688 读不到，按 --freight 估的）`
					: q.tags.freeShipping
						? "0（包邮）"
						: `${q.freightRmb} 元/件（1688 页面上寄到我们这里买 1 件）`;
				const tags =
					[q.tags.onePsale ? "一件代发" : "", q.tags.ship48h ? "48 小时发货" : q.tags.deliveryDays ? `${q.tags.deliveryDays} 天内发货` : ""]
						.filter(Boolean)
						.join("、") || "无";
				return [
					`${q.title}（${q.offerId}）`,
					`${q.shop} 售价 ${q.priceTwd}（${q.variants} 个规格）`,
					...q.specs.split("\n").map((x: string) => `  ${x}`),
					`国内运费：${freight}`,
					`重量：${q.weightAssumed ? `${q.weightAssumed}（估的）` : "1688 都给了"}`,
					`服务：${tags}；起订量 ${q.minQty}`,
					...(q.problems.length ? [`问题：${q.problems.join("；")}`] : []),
				].join("\n");
			},
		},
		make: {
			...get(
				"做商品稿：读货源、规格和核价、图（筛字、译图、译图检查、水印、传图）、类目属性；不给编号就做所有还没做好的。几份同时做：问 Gemini、交象寄、取图几份重叠，碰浏览器的按浏览器排队（queue.ts）",
				z.object({ ids: ids.optional(), jobs: z.coerce.number().int().min(1).max(10).default(3).describe("几份同时做") }),
				async (p) => {
					const sql = await db();
					// 不给就做：还没做的、待补充的、规格是旧格式的、换了类目还没照它做属性和备货天数的
					const want =
						p.ids ??
						(
							await sql`select id::text from listings where not cancelled and product_id is null and (offer is null or problems is not null or jsonb_typeof(variants) is distinct from 'object' or (category_path is not null and days_to_ship is null)) order by id`
						).map((r) => r.id as string);
					if (!want.length) return [];
					const before = await namesOf(sql, want);
					const settled = await each(want, p.jobs, async (id) => {
						const r = await make(sql, id, (line) => console.error(`${before(id)}：${line}`));
						// 缺重量、国内运费的告诉 agent 估，定不了价的、超过上限的现算
						const [l] = await sql`select * from listings where id = ${id}`;
						const specs = l ? specsOf(l.variants) : null;
						const needs = l ? estimateNeeds(l) : [];
						return { ...r, name: l ? listingName(l) : `商品稿 ${id}`, needs, problems: [...r.problems, ...(specs ? pricingProblems(specs, needs) : [])] };
					});
					const results = settled.flatMap((x) => (x.ok ? [x.value] : []));
					// 有出错的：做完的照样记在库里；要人处理的（登录、滑块）在前面，没开始的等处理好了再跑
					const rank = (f: { error: Error; started: boolean }) => (!f.started ? 2 : f.error instanceof NeedsHuman ? 0 : 1);
					const failed = settled
						.flatMap((x, i) => (x.ok ? [] : [{ id: want[i]!, error: x.error as Error, started: x.started }]))
						.sort((a, b) => rank(a) - rank(b));
					if (failed.length) {
						const lines = [
							...failed.map((f) => `${before(f.id)}：${f.started ? f.error.message : "没开始（先处理上面要人处理的，再跑 x2 listing make）"}`),
							...(results.length ? [`做完了：${results.map((r) => `${r.name}${r.problems.length ? `（${r.problems[0]}）` : ""}`).join("；")}`] : []),
						];
						throw failed.some((f) => f.error instanceof NeedsHuman) ? new NeedsHuman(lines.join("\n")) : new Error(lines.join("\n"));
					}
					return results;
				},
			),
			text: (results) => {
				if (!results.length) return "没有要做的商品稿";
				const hint = (r: { id: string; needs: string[] }) =>
					r.needs.length
						? `\n  估：x2 listing estimate --id ${r.id}${r.needs.includes("重量") ? " --weight <kg>" : ""}${r.needs.includes("国内运费") ? " --freight <元/件>" : ""}`
						: "";
				return results
					.map((r: any) => `${r.name}：${r.problems.length ? `\n  ${r.problems.join("\n  ")}${hint(r)}` : `已做好，待写文案（x2 listing show --id ${r.id}）`}`)
					.join("\n");
			},
		},
		estimate: {
			...get(
				"估 1688 没给的重量、读不到的国内运费：只填空着的（人填过的不动），写完马上重新核价（不读 1688）。重量往重了估，轻的写 1；国内运费往高了估",
				z.object({
					id,
					weight: z.coerce.number().positive().finite().optional().describe("重量（kg）"),
					freight: z.coerce.number().nonnegative().finite().optional().describe("国内运费（元/件）"),
				}),
				async (p) => {
					if (p.weight === undefined && p.freight === undefined)
						throw new Usage("x2 listing estimate --id <商品稿> --weight <kg> --freight <元/件>：至少给一样");
					const sql = await db();
					const [l] = await sql`select * from listings where id = ${p.id}`;
					if (!l) throw new Usage(`没有商品稿 ${p.id}`);
					if (!l.offer || !specsOf(l.variants)) throw new Usage(`${listingName(l)}还没做好：先 x2 listing make --ids ${p.id}`);
					const needs = estimateNeeds(l);
					const notes: string[] = [],
						set: Record<string, number> = {};
					if (p.weight !== undefined) {
						if (l.weight_kg !== null) notes.push(`重量：已有 ${Number(l.weight_kg)} kg（人填的或估过的），不改`);
						else if (!needs.includes("重量")) notes.push("重量：1688 给了每个规格的重量，不用估");
						else {
							set.weight_kg = p.weight;
							notes.push(`重量：记为 ${p.weight} kg`);
						}
					}
					if (p.freight !== undefined) {
						const known = freightOf(l.offer, null);
						if (l.freight_rmb !== null) notes.push(`国内运费：已有 ${Number(l.freight_rmb)} 元/件（人填的或估过的），不改`);
						else if (known !== null) notes.push(`国内运费：${l.offer.tags?.freeShipping ? "货源包邮" : `1688 读得到（${known} 元/件）`}，不用估`);
						else {
							set.freight_rmb = p.freight;
							notes.push(`国内运费：记为 ${p.freight} 元/件`);
						}
					}
					// 只写还空着的（两个 x2 同时估，先写的算）
					if (set.weight_kg !== undefined)
						await sql`update listings set weight_kg = ${set.weight_kg}, updated_at = now() where id = ${p.id} and weight_kg is null`;
					if (set.freight_rmb !== undefined)
						await sql`update listings set freight_rmb = ${set.freight_rmb}, updated_at = now() where id = ${p.id} and freight_rmb is null`;
					const [now] = await sql`select * from listings where id = ${p.id}`;
					const [row] = await sql`select * from shop_settings where shop = ${now!.shop}`;
					await savePrices(sql, now, settingsOf(row));
					const left = estimateNeeds(now);
					const problems = [
						...String(now!.problems ?? "")
							.split("\n")
							.filter(Boolean),
						...pricingProblems(specsOf(now!.variants)!, left),
					];
					const prices = specsText(specsOf(now!.variants)!, removedOf(now!.offer, now!.removed_variants));
					return { id: p.id, name: listingName(now!), notes, needs: left, problems, prices };
				},
			),
			text: (r) =>
				[
					`${r.name}：${r.notes.join("；")}`,
					`规格和价格：\n  ${r.prices.split("\n").join("\n  ")}`,
					r.problems.length ? `还有：${r.problems.join("；")}` : "核价好了（下一步看 x2 status）",
				].join("\n"),
		},
		show: get(
			"写文案要用的事实：货源标题、规格的层和选项（1688 原文、现在的名字、售价）、类目、属性、服务，和现在的标题、描述、简称",
			z.object({ id }),
			async (p) => {
				const [l] = await (await db())`select * from listings where id = ${p.id}`;
				if (!l) throw new Usage(`没有商品稿 ${p.id}`);
				// 规格：每层（第几层、1688 的层名、现在的名字）、每个选项（第几个、1688 的原值、现在的名字、这个选项的售价范围）。单规格的不写规格名，tiers 是空的
				const specs = specsOf(l.variants);
				const tiers =
					specs && !isSingle(specs)
						? specs.tiers.map((t, a) => ({
								n: a + 1,
								source: t.source,
								name: t.name,
								options: t.options.map((o, k) => ({
									n: k + 1,
									source: o.source,
									name: o.name,
									price: priceRange(specs.variants.filter((v) => v.options[a] === k)),
								})),
							}))
						: [];
				return {
					id: String(l.id),
					shop: l.shop,
					nickname: l.nickname ?? null,
					offerTitle: l.offer?.title ?? null,
					category: l.category_name,
					attributes: l.attributes_text,
					variants: specs?.variants.length ?? 0,
					tiers,
					weights: [...new Set((specs?.variants ?? []).map((v) => v.weightKg))],
					needs: estimateNeeds(l),
					tags: l.offer?.tags ?? null,
					title: l.title,
					description: l.description,
					problems: l.offer && !specs ? OLD_SPECS : l.problems,
				};
			},
		),
		text: {
			...get(
				'agent 写的标题、描述、规格名和简称，写完马上 Gemini 文字检查。一份：--id --title --description [--tiers \'[{ "name": "款式", "options": ["…"] }]\'] [--nickname]；几份：--items - 从 stdin 读 [{ id, title, description, tiers, nickname }]。有一样不对那一份就什么都不存',
				z
					.object({
						id: id.optional(),
						title: z.string().optional().describe("标题（台湾繁体）"),
						description: z.string().optional().describe("描述（台湾繁体）"),
						tiers: z.preprocess(parseJson, z.unknown()).optional().describe("规格名（JSON），个数、顺序照 x2 listing show"),
						nickname: z.string().optional().describe("简称（简体中文，最多 12 字）"),
						items: z
							.preprocess(
								parseJson,
								z.array(
									z.object({
										id: z.coerce.string(),
										title: z.coerce.string().default(""),
										description: z.coerce.string().default(""),
										tiers: z.unknown().optional(),
										nickname: z.string().nullish(),
									}),
								),
							)
							.optional()
							.describe("几份一起（JSON；写 - 从 stdin 读）"),
					})
					.refine((p) => Boolean(p.id) !== Boolean(p.items), { message: "给 --id（一份）或 --items（几份），不要都给" }),
				async (p) => {
					const sql = await db();
					const items = p.items
						? p.items.map((x) => ({ ...x, nickname: x.nickname ?? undefined }))
						: [{ id: p.id!, title: p.title ?? "", description: p.description ?? "", tiers: p.tiers, nickname: p.nickname }];
					const results: { id: string; saved: boolean; problems: string[]; notes?: string[] }[] = [];
					for (const it of items) {
						// 标题、描述的硬规矩；规格名（交了的话）照 show 的层和选项一个一个改，过一遍规格的规矩；简称（交了的话）简体中文、最多 12 字。有一样不对就什么都不存
						const problems = [...textProblems(it.title.trim(), it.description.trim()), ...(it.nickname === undefined ? [] : nicknameProblems(it.nickname))];
						const [l] = await sql`select variants, offer, removed_variants, nickname from listings where id = ${it.id}`;
						if (!l) {
							results.push({ id: it.id, saved: false, problems: ["没有这份商品稿"] });
							continue;
						}
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
						if (problems.length) {
							results.push({ id: it.id, saved: false, problems });
							continue;
						}
						const renamed = it.tiers !== undefined && specs ? { variants: sql.json(specs) } : {};
						// 简称只在空着、还是自动填的那个值时写：人在网页上改过的不改
						const nick = it.nickname === undefined ? {} : nicknameOpen(l) ? { nickname: it.nickname.trim() } : null;
						await sql`update listings set ${sql({ title: it.title.trim(), description: it.description.trim(), ...renamed, ...nick, updated_at: new Date() } as any)} where id = ${it.id}`;
						results.push({
							id: it.id,
							saved: true,
							problems: [],
							...(nick ? {} : { notes: [`简称：已有「${l.nickname}」，不改（只在空着、还是自动填的时候写）`] }),
						});
					}
					const name = await namesOf(
						sql,
						results.map((r) => r.id),
					);
					const checks = await textChecks(
						sql,
						results.filter((r) => r.saved).map((r) => r.id),
					);
					return { text: results.map((r) => ({ ...r, name: name(r.id) })), audit: checks };
				},
			),
			text: (r) =>
				[
					...r.text.map((x: any) => `${x.name}：${x.saved ? ["记下了", ...(x.notes ?? [])].join("；") : x.problems.join("；")}`),
					...r.audit.map(checkLine),
				].join("\n"),
		},
		audit: {
			...get(
				"Gemini 文字检查（看文案和加水印之前的图，挑简体字、错字、误译）：只提示，挑出的问题带编号写进说明；详情图、不是封面的主图上后加的文案 x2 去掉（人要用：x2 listing keep）。不给编号就查所有写了文案、还没建商品的",
				z.object({ ids: ids.optional() }),
				async (p) => {
					const sql = await db();
					const want =
						p.ids ??
						(await sql`select id::text from listings where not cancelled and product_id is null and title is not null order by id`).map((r) => r.id as string);
					return textChecks(sql, want);
				},
			),
			text: (checks) => checks.map(checkLine).join("\n") || "没有要查的商品稿",
		},
		keep: {
			...get(
				"保留的图（人说了才用）：按图的名字（主图 N、详情图 N，见商品稿的说明）找图；x2 去掉的放回来，以后检查再挑它也不去掉",
				z.object({ id, images: strs("图的名字，例 主图 2,详情图 3") }),
				async (p) => {
					const sql = await db();
					const asked = [...new Set([...p.images.join(" ").matchAll(/(主图|详情图)\s*(\d+)/g)].map((m) => `${m[1]} ${m[2]}`))];
					if (!asked.length) throw new Usage("x2 listing keep --id <商品稿> --images 主图 N,详情图 N（图的名字，见商品稿的说明；人说了才用）");
					const [l] = await sql`select * from listings where id = ${p.id}`;
					if (!l) throw new Usage(`没有商品稿 ${p.id}`);
					const named = new Map<string, Pic>();
					for (const role of ["main", "detail"] as const) for (const { pic, n } of numbered(l.images ?? {}, role)) named.set(`${LABEL[role]} ${n}`, pic);
					const unknown = asked.filter((x) => !named.has(x));
					if (unknown.length) throw new Usage(`${listingName(l)}没有${unknown.join("、")}（有：${[...named.keys()].join("、") || "无"}）`);
					const deleted = asked.filter((x) => (l.removed_images ?? []).includes(named.get(x)!.imageId));
					if (deleted.length) throw new Usage(`${listingName(l)}的${deleted.join("、")}是人删的（已删除的图），不放回来`);
					const imageIds = [...new Set(asked.map((x) => named.get(x)!.imageId!))];
					const restored = asked.filter((x) => named.get(x)!.drop?.startsWith(AUDIT_DROP));
					await sql`update listings set images = ${sql.json(restoreAudited(l.images, imageIds) as any)}, kept_images = ${sql.json([...new Set([...(l.kept_images ?? []), ...imageIds])])}, updated_at = now() where id = ${p.id}`;
					const checks = await textChecks(sql, [p.id]);
					return { id: p.id, name: listingName(l), kept: asked, restored, audit: checks };
				},
			),
			text: (r) =>
				[`${r.name}：${r.kept.join("、")}记进保留的图${r.restored.length ? `，${r.restored.join("、")}放回来了` : ""}`, ...r.audit.map(checkLine)].join("\n"),
		},
		drop: {
			...get(
				"去掉人不要的规格（例 店里接不了的「定製」；人说了才用）：整个选项（选项名，两层有同名的写「层名:选项名」）或一个规格（货号）。去掉的货号记进已移除的规格",
				z.object({ id, specs: strs("选项名、层名:选项名或货号"), merge: flag("两层合成一层「款式」（人说了才加）").default(false) }),
				async (p) => {
					const sql = await db();
					const [l] = await sql`select id::text, shop, nickname, offer_id, variants, offer, removed_variants, problems from listings where id = ${p.id}`;
					if (!l) throw new Usage(`没有商品稿 ${p.id}`);
					const specs = specsOf(l.variants);
					if (!specs) throw new Usage(`${listingName(l)}的规格是旧格式：先重做商品稿（x2 listing make --ids ${p.id}），再去掉`);
					const r = dropSpecs(specs, p.specs, p.merge);
					if ("error" in r) throw new Usage(`${listingName(l)}：${r.error}`);
					const removed = [...new Set([...(l.removed_variants ?? []), ...r.skus])];
					await sql`update listings set variants = ${sql.json(r.specs)}, removed_variants = ${sql.json(removed)}, updated_at = now() where id = ${p.id}`;
					return { id: p.id, name: listingName(l), dropped: r.skus, left: r.specs.variants.length, merged: r.merged, recheck: Boolean(l.problems) };
				},
			),
			text: (r) =>
				`${r.name}：去掉 ${r.dropped.length} 个规格，还剩 ${r.left} 个${r.merged ? "，两层合成一层「款式」" : ""}\n下一步：${r.recheck ? `x2 listing make --ids ${r.id}（规格的问题要重新算）` : `x2 listing audit --ids ${r.id}（规格变了，要再查）`}`,
		},
		category: {
			...get(
				"人在终端里定了类目：写成人定的类目（要是叶子、在本店允许的类目里；建了商品的不改），属性、备货天数清掉，再 x2 listing make（有类目就不再问 Shopee 推荐）。类目 id 见 x2 shopee category-tree",
				z.object({ id, category: z.string().regex(/^\d+$/).describe("叶子类目 id") }),
				async (p) => setCategory(await db(), p.id, p.category, (shopId) => inAccount("shopee", shopId, () => categoryTree())),
			),
			text: (r) => {
				const notes = [r.cancelled ? "这份已放弃：要上就去掉「放弃」" : "", r.before && r.before !== r.category ? `原来是「${r.before}」` : ""].filter(Boolean);
				return [
					`${r.name}：类目定为「${r.category}」，属性、备货天数清掉了${notes.length ? `（${notes.join("；")}）` : ""}`,
					`下一步：x2 listing make --ids ${r.id}（照新的类目做属性、备货天数）`,
				].join("\n");
			},
		},
		publish: {
			kind: "write",
			description: "人在终端里说「批准」：建商品（先建成下架，读回来逐项核对）、上架（读回来在售）。只收待批准、待上架的；有一份不行就都不做",
			params: z.object({ ids }),
			plan: (sql, p) => publishPlan(sql, [...new Set(p.ids as string[])]),
		},
		cancel: {
			...get(
				"人在终端里说「放弃」：替人勾「放弃」，马上是已放弃。建了商品的要下架，不是放弃；建商品还没核清的先核清；有一份不行就都不勾。原因只回显，不存",
				z.object({ ids, why: text.optional().describe("原因") }),
				async (p) => {
					// 和人在网页上勾「放弃」是同一个勾。原因不存：「备注」是人写的，也没有放原因的列，只回显。勾完马上重算当前步骤（已放弃）
					const sql = await db();
					const want = [...new Set(p.ids as string[])];
					const name = await namesOf(sql, want);
					const rows = await sql`select id::text, cancelled, product_id, listed_at from listings where id in ${sql(want)}`;
					const writes = await sql`select id::text, params->>'listingId' as listing, op, status from writes
						where op in ('建商品', '上架') and status in ('待执行', '已提交', '结果未知', '不一致') and params->>'listingId' in ${sql(want)} order by id`;
					const bad = want.flatMap((id) => {
						const r = rows.find((x) => x.id === id);
						if (!r) return [`没有商品稿 ${id}`];
						if (r.cancelled) return [];
						if (r.listed_at) return [`${name(id)}已上架（商品 ${r.product_id ?? "—"}）：不卖了是下架，不是放弃`];
						if (r.product_id) return [`${name(id)}已经建了商品（商品 ${r.product_id}，下架）：不上架就不 publish，不是放弃`];
						const unsure = writes.filter((w) => w.listing === id);
						return unsure.length ? [`${name(id)}在建商品中（${unsure.map((w) => `${w.op}：${w.status}`).join("；")}）：可能已经建了，先核清（x2 verify）`] : [];
					});
					if (bad.length) throw new Usage(`${bad.join("\n")}\n一份都没放弃`);
					const already = new Set(rows.filter((r) => r.cancelled).map((r) => r.id as string));
					await sql`update listings set cancelled = true, updated_at = now() where id in ${sql(want)} and not cancelled and product_id is null and listed_at is null`;
					const r = await listingsCheck(sql, want);
					return want.map((id) => ({ id, name: name(id), step: r.steps.get(id)?.step ?? null, already: already.has(id), why: p.why ?? null }));
				},
			),
			text: (done) =>
				[...done.map((x: any) => `${x.name}：${x.already ? "已经放弃了" : x.step}`), ...(done[0]?.why ? [`原因：${done[0].why}`] : [])].join("\n"),
		},
		noted: {
			...get("照人写的「备注」做完：记下看过的备注原文（备注再改，x2 status 的 todo 又给出来）；人写的备注不改", z.object({ ids }), async (p) => {
				const sql = await db();
				const want = [...new Set(p.ids as string[])];
				const rows = await sql`update listings set noted = note where id in ${sql(want)} returning id::text, note`;
				const missing = want.filter((id) => !rows.some((r) => r.id === id));
				if (missing.length) throw new Usage(`没有商品稿 ${missing.join("、")}`);
				const name = await namesOf(sql, want);
				return rows.map((r) => ({ id: r.id, name: name(r.id), note: r.note }));
			}),
			text: (rows) => rows.map((r: any) => `${r.name}：看过备注「${r.note ?? ""}」`).join("\n"),
		},
		list: {
			...get("所有商品稿走到哪了（放弃了的不列）", undefined, async () =>
				(
					await (await db())`select id::text, shop, nickname, offer_id, offer->>'title' as offer_title, strategy, title, step, step_detail, problems, product_id from listings where not cancelled order by id`
				).map((r) => ({ ...r, name: listingName({ ...r, offer: { title: r.offer_title } }) })),
			),
			text: (rows) =>
				rows.length
					? rows
							.map(
								(r: any) =>
									`${r.name} ${r.step ?? "（还没检查）"}${r.step_detail ? `：${String(r.step_detail).split("\n")[0]}` : ""}${r.problems ? `\n    ${String(r.problems).split("\n").join("\n    ")}` : ""}`,
							)
							.join("\n")
					: "还没有商品稿：x2 listing add --shop <店> --links <1688 链接>",
		},
	},
	check: async (sql) => {
		const r = await listingsCheck(sql);
		return { read: [], human: r.reminders, todo: r.todo };
	},
	writes: LISTING_WRITES,
	written,
	tables: LISTING_TABLES,
	schema: new URL("./schema.sql", import.meta.url),
};

/** 人定的类目（x2 listing category）：要是 Shopee 类目树里的叶子（tree 读这家店的类目树），在本店允许的类目里；已经建了商品的不改。
 * 写类目的路径、id、名字；属性、备货天数跟着类目变，清掉，做商品稿第 4 步记的问题（类目、属性、备货天数）也不算了；马上重算当前步骤（待做商品稿）。
 * 以后做商品稿照用这个类目，不再问 Shopee 推荐 */
export async function setCategory(sql: Sql, id: string, category: string, tree: (shopId: string) => Promise<Category[]>) {
	const [l] = await sql`select * from listings where id = ${id}`;
	if (!l) throw new Usage(`没有商品稿 ${id}`);
	const name = listingName(l);
	if (l.product_id || l.listed_at) throw new Usage(`${name}已经建了商品（商品 ${l.product_id ?? "—"}）：不改类目`);
	const [row] = await sql`select * from shop_settings where shop = ${l.shop}`;
	if (!row) throw new Usage(`店铺设置里没有「${l.shop}」`);
	const s = settingsOf(row);
	const found = leafPath(await tree(s.shopId), category);
	if ("error" in found) throw new Usage(`${name}：${found.error}`);
	const full = found.names.join(" > ");
	if (s.categories && !s.categories.has(category)) throw new Usage(`${name}：「${full}」不在 ${l.shop} 允许的类目里（店铺设置的「允许的类目」）`);
	const problems =
		String(l.problems ?? "")
			.split("\n")
			.filter((x) => x && !CATEGORY_PROBLEM.test(x))
			.join("\n") || null;
	const [done] = await sql`update listings set category_path = ${sql.json(found.path)}, category_id = ${category}, category_name = ${full},
		attributes = null, attributes_text = null, days_to_ship = null, problems = ${problems}, updated_at = now()
		where id = ${id} and product_id is null and listed_at is null returning id`;
	if (!done) throw new Usage(`${name}刚建了商品：不改类目`);
	const r = await listingsCheck(sql, [id]);
	return {
		id,
		name,
		category: full,
		categoryPath: found.path,
		before: (l.category_name as string | null) ?? null,
		cancelled: Boolean(l.cancelled),
		step: r.steps.get(id)?.step ?? null,
	};
}

/** checked：查过了（false 是查不了，problems 是原因）；issues：挑出的问题（带编号，图写图的名字） */
type CheckResult = { id: string; name: string; checked: boolean; cached?: boolean; problems?: string[]; issues: AuditIssue[] };
const checkLine = (c: CheckResult) => {
	if (!c.checked) return `${c.name} Gemini 文字检查：查不了：${(c.problems ?? []).join("；")}`;
	const dropped = c.issues.filter((x) => x.status === "已去掉");
	return [
		`${c.name} Gemini 文字检查：${c.issues.length ? `挑出 ${c.issues.length} 条（只提示，写在说明里）` : "没挑出问题"}${c.cached ? "（查过）" : ""}`,
		...c.issues.map((x) => `  ${issueLine(x)}`),
		...(dropped.length ? [`  x2 去掉的图人说要用才放回来：x2 listing keep --id ${c.id} --images ${dropped.map((x) => x.name ?? x.image).join(",")}`] : []),
	].join("\n");
};

/** 现在这份商品稿组成的商品（人删的图不查） */
async function productNow(sql: Sql, id: string) {
	const [l] = await sql`select * from listings where id = ${id}`;
	if (!l) return null;
	const [row] = await sql`select * from shop_settings where shop = ${l.shop}`;
	return { l, kept: (l.kept_images ?? []) as string[], r: productOf(l, settingsOf(row)) };
}

/** 挑出后加文案的详情图、不是封面的主图：x2 去掉以后最多再查几轮 */
const MAX_RECHECK = 2;

/** Gemini 文字检查：内容没变的不重查（检查键记在商品稿的 audit 里）。看的是加水印之前的图（unmarked）。
 * 挑出的图 x2 能去掉的去掉（不进已删除的图），重组商品再查 */
async function textChecks(sql: Sql, ids: string[]): Promise<CheckResult[]> {
	const out: CheckResult[] = [];
	for (const id of ids) {
		let c = await productNow(sql, id);
		if (!c) {
			out.push({ id, name: `商品稿 ${id}`, checked: false, problems: ["没有这份商品稿"], issues: [] });
			continue;
		}
		const name = listingName(c.l);
		if (!c.r.product) {
			out.push({ id, name, checked: false, problems: c.r.problems, issues: [] });
			continue;
		}
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
				c = (await productNow(sql, id))!;
			}
			if (!c.r.product) {
				out.push({ id, name, checked: false, problems: c.r.problems, issues: [] });
				continue;
			}
			// x2 去掉的图（这一次的、以前的）也记进检查结果：人看得到，要用可以保留
			a = { ...a!, images: [...auditDropped(c.l.images), ...a!.images] };
			await sql`update listings set audit = ${sql.json(a as any)}, updated_at = now() where id = ${id}`;
		}
		const issues = auditIssues(a!, c.kept, imageNames(c.l.images ?? {}, specsOf(c.l.variants)));
		out.push({ id, name, checked: true, ...(cached ? { cached } : {}), issues });
	}
	return out;
}
