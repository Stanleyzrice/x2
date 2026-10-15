// 一格：照列的类型显示；人能改的照类型给控件，改完就存（勾、选马上存，字离开输入框时存）。表格和卡片都用它
import { Badge, Button, Checkbox, Input, InputArea, Link, Select, Table } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import type { SpecsTable } from "../src/listing/variants.ts";
import type { Pic } from "../src/web/tables.ts";
import type { Column } from "./api.ts";

export type Save = (value: unknown) => void;

const time = (v: string) => new Date(v).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const empty = (v: unknown) => v === null || v === undefined || v === "";

/** JSON：对象一行一个「键：值」 */
const jsonText = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v)
	? Object.entries(v).map(([k, x]) => `${k}：${typeof x === "string" ? x : JSON.stringify(x)}`).join("\n")
	: JSON.stringify(v));

/** 只看的一格；compact 是表格里（长字截断、图小） */
export function Show({ col, value, compact }: { col: Column; value: unknown; compact?: boolean }) {
	if (col.type === "pics") return <Pics pics={(value ?? []) as Pic[]} compact={compact} />;
	if (col.type === "specs" && value) return <Specs specs={value as SpecsTable} compact={compact} />;
	if (empty(value)) return <span className="text-kumo-inactive">—</span>;
	if (col.type === "bool") return <Checkbox checked={Boolean(value)} disabled aria-label={col.label} />;
	if (col.type === "time") return <span className="whitespace-nowrap">{time(String(value))}</span>;
	if (col.type === "number") return <span className="tabular-nums">{Number(value).toLocaleString("zh-CN")}</span>;
	if (col.type === "image") return <img src={String(value)} alt={col.label} referrerPolicy="no-referrer" className={compact ? "size-10 rounded object-cover" : "size-24 rounded object-cover"} />;
	if (col.type === "link") return <Link href={String(value)} target="_blank">打开</Link>;
	const text = col.type === "json" ? jsonText(value) : String(value);
	return <span className={`whitespace-pre-wrap break-words ${compact ? "line-clamp-3" : ""}`}>{text}</span>;
}

/** 改的一格 */
export function Edit({ col, value, save }: { col: Column; value: unknown; save: Save }) {
	const [draft, setDraft] = useState(value ?? "");
	useEffect(() => setDraft(value ?? ""), [value]);
	const commit = () => { if (String(draft) !== String(value ?? "")) save(col.type === "number" ? (draft === "" ? null : Number(draft)) : draft); };

	if (col.type === "bool") return <Checkbox checked={Boolean(value)} onCheckedChange={(c) => save(c)} aria-label={col.label} />;
	if (col.type === "pics") return <Pics pics={(value ?? []) as Pic[]} save={save} />;
	if (col.edit?.options) {
		return <Select aria-label={col.label} className="w-48" value={value ?? null} placeholder="—" onValueChange={(v) => save(v)}
			items={Object.fromEntries(col.edit.options.map((o) => [o, o]))} />;
	}
	if (col.type === "time") return <Input type="date" aria-label={col.label} value={value ? String(value).slice(0, 10) : ""} onChange={(e) => save(e.target.value || null)} />;
	if (col.type === "number") {
		return <Input type="number" step="any" aria-label={col.label} className="w-40" value={String(draft)} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />;
	}
	return <InputArea aria-label={col.label} autoResize minRows={1} maxRows={12} value={String(draft)} onValueChange={setDraft} onBlur={commit} />;
}

const STATE: Record<Pic["state"], string> = { used: "", removed: "已删除", dropped: "x2 去掉", extra: "超出张数" };

/** 商品稿的图：主图、详情图、规格图。能改时主图、详情图能删、能放回；x2 去掉的写着原因（要用告诉 agent） */
function Pics({ pics, compact, save }: { pics: Pic[]; compact?: boolean; save?: Save }) {
	if (compact) {
		const cover = pics.find((p) => p.role === "main" && p.state === "used");
		return cover ? <img src={cover.url} alt={cover.label} className="size-16 rounded object-cover" /> : <span className="text-kumo-inactive">—</span>;
	}
	return (
		<div className="flex flex-wrap gap-3">
			{pics.map((p) => (
				<figure key={`${p.label}:${p.id}`} className="w-36" title={p.why}>
					<img src={p.url} alt={p.label} loading="lazy" className={`size-36 rounded-lg border border-kumo-line object-cover ${p.state === "used" ? "" : "opacity-30"}`} />
					<figcaption className="mt-1 flex items-center justify-between gap-1 text-xs">
						<span className="truncate">{p.label}</span>
						{STATE[p.state] && <Badge variant={p.state === "removed" ? "red" : "neutral"}>{STATE[p.state]}</Badge>}
						{save && p.role !== "option" && (p.state === "used" || p.state === "removed") && (
							<Button size="xs" variant={p.state === "removed" ? "secondary" : "secondary-destructive"} onClick={() => save({ id: p.id, removed: p.state !== "removed" })}>
								{p.state === "removed" ? "放回" : "删"}
							</Button>
						)}
					</figcaption>
				</figure>
			))}
		</div>
	);
}

type SpecRow = SpecsTable["rows"][number];
const price = (p: number | null) => (p === null ? "未定价" : `NT$${p}`);
/** 规格表里的数：都一样的写在上面一行，不一样的才成一列 */
const FIELDS: { label: string; of: (r: SpecRow) => string }[] = [
	{ label: "售价", of: (r) => price(r.priceTwd) },
	{ label: "进价", of: (r) => `¥${r.costRmb}` },
	{ label: "库存", of: (r) => String(r.stock) },
	{ label: "重量", of: (r) => (r.weightKg === null ? "缺重量" : `${r.weightKg} kg`) },
];

/** 规格和价格：一个规格一行（规格图、每层的选项、不一样的数），都一样的数写在上面；表格里只写个数和售价 */
function Specs({ specs, compact }: { specs: SpecsTable; compact?: boolean }) {
	const { rows, tiers, removed } = specs;
	const same = FIELDS.filter((f) => new Set(rows.map(f.of)).size <= 1);
	const varying = FIELDS.filter((f) => !same.includes(f));
	if (compact) {
		const prices = [...new Set(rows.map((r) => r.priceTwd))].filter((p) => p !== null) as number[];
		const range = prices.length ? (prices.length === 1 ? price(prices[0]!) : `${price(Math.min(...prices))}–${Math.max(...prices)}`) : "未定价";
		return <span className="whitespace-nowrap">{rows.length > 1 || tiers.length ? `${rows.length} 个规格 · ` : ""}{range}</span>;
	}
	const images = rows.some((r) => r.image);
	return (
		<div className="flex flex-col gap-2">
			<div className="text-sm text-kumo-subtle">
				{[`${rows.length} 个规格`, ...same.map((f) => `${f.label}${rows.length > 1 ? "都是" : ""} ${rows[0] ? f.of(rows[0]) : "—"}`)].join(" · ")}
			</div>
			{tiers.length > 0 && (
				<div className="max-h-[28rem] overflow-auto rounded-lg border border-kumo-line">
					<Table>
						<Table.Header>
							<Table.Row>
								{images && <Table.Head className="w-16 whitespace-nowrap">规格图</Table.Head>}
								{tiers.map((t) => <Table.Head key={t} className="whitespace-nowrap">{t}</Table.Head>)}
								{varying.map((f) => <Table.Head key={f.label} className="whitespace-nowrap text-right">{f.label}</Table.Head>)}
							</Table.Row>
						</Table.Header>
						<Table.Body>
							{rows.map((r) => (
								<Table.Row key={r.sku}>
									{images && <Table.Cell>{r.image && <img src={r.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-10 max-w-none rounded object-cover" />}</Table.Cell>}
									{r.options.map((o, a) => <Table.Cell key={tiers[a]}>{o}</Table.Cell>)}
									{varying.map((f) => <Table.Cell key={f.label} className="text-right tabular-nums">{f.of(r)}</Table.Cell>)}
								</Table.Row>
							))}
						</Table.Body>
					</Table>
				</div>
			)}
			{removed.length > 0 && <div className="text-sm text-kumo-subtle">已移除：{removed.map((x) => `${x.name}（${x.count} 个规格）`).join("、")}</div>}
		</div>
	);
}
