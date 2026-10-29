// 一格：照列的类型显示；人能改的照类型给控件，改完就存（勾、选马上存，字离开输入框时存）。datagrid 的表格和卡片都用它
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { SpecsTable } from "../../../skills/listing/variants.ts";
import type { Column, Pic } from "../api.ts";

export type Save = (value: unknown) => void;

const time = (v: string) => new Date(v).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const empty = (v: unknown) => v === null || v === undefined || v === "";

const jsonText = (v: unknown) =>
	v && typeof v === "object" && !Array.isArray(v)
		? Object.entries(v)
				.map(([k, x]) => `${k}：${typeof x === "string" ? x : JSON.stringify(x)}`)
				.join("\n")
		: JSON.stringify(v);

export function Show({ col, value, compact }: { col: Column; value: unknown; compact?: boolean }) {
	if (col.type === "pics") return <Pics pics={(value ?? []) as Pic[]} compact={compact} />;
	if (col.type === "specs" && value) return <Specs specs={value as SpecsTable} compact={compact} />;
	if (empty(value)) return <span className="text-muted-foreground">—</span>;
	if (col.type === "bool") return <Checkbox checked={Boolean(value)} disabled aria-label={col.label} />;
	if (col.type === "time") return <span className="whitespace-nowrap">{time(String(value))}</span>;
	if (col.type === "number") return <span className="tabular-nums">{Number(value).toLocaleString("zh-CN")}</span>;
	if (col.type === "image")
		return (
			<img
				src={String(value)}
				alt={col.label}
				referrerPolicy="no-referrer"
				className={compact ? "size-10 rounded object-cover" : "size-24 rounded object-cover"}
			/>
		);
	if (col.type === "link")
		return (
			<a href={String(value)} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
				打开
			</a>
		);
	const text = col.type === "json" ? jsonText(value) : String(value);
	return <span className={`whitespace-pre-wrap break-words ${compact ? "line-clamp-3" : ""}`}>{text}</span>;
}

export function Edit({ col, value, save }: { col: Column; value: unknown; save: Save }) {
	const [draft, setDraft] = useState(String(value ?? ""));
	useEffect(() => setDraft(String(value ?? "")), [value]);
	const commit = () => {
		if (draft !== String(value ?? "")) save(col.type === "number" ? (draft === "" ? null : Number(draft)) : draft);
	};

	if (col.type === "bool") return <Checkbox checked={Boolean(value)} onCheckedChange={(c) => save(c)} aria-label={col.label} />;
	if (col.type === "pics") return <Pics pics={(value ?? []) as Pic[]} save={save} />;
	if (col.edit?.options)
		return (
			<Select value={(value as string | null) ?? null} onValueChange={(v) => save(v)}>
				<SelectTrigger className="w-48" aria-label={col.label}>
					<SelectValue placeholder="—" />
				</SelectTrigger>
				<SelectContent>
					{col.edit.options.map((o) => (
						<SelectItem key={o} value={o}>
							{o}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		);
	if (col.type === "time")
		return (
			<Input
				type="date"
				aria-label={col.label}
				className="w-44"
				value={value ? String(value).slice(0, 10) : ""}
				onChange={(e) => save(e.target.value || null)}
			/>
		);
	if (col.type === "number")
		return <Input type="number" step="any" aria-label={col.label} className="w-40" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />;
	return <Textarea aria-label={col.label} className="min-h-9" rows={1} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} />;
}

const STATE: Record<Pic["state"], string> = { used: "", removed: "已删除", dropped: "x2 去掉", extra: "超出张数" };

function Pics({ pics, compact, save }: { pics: Pic[]; compact?: boolean | undefined; save?: Save }) {
	if (compact) {
		const cover = pics.find((p) => p.role === "main" && p.state === "used");
		return cover ? <img src={cover.url} alt={cover.label} className="size-14 rounded object-cover" /> : <span className="text-muted-foreground">—</span>;
	}
	return (
		<div className="flex flex-wrap gap-3">
			{pics.map((p) => (
				<figure key={`${p.label}:${p.id}`} className="w-32" title={p.why}>
					<img src={p.url} alt={p.label} loading="lazy" className={`size-32 rounded-lg border object-cover ${p.state === "used" ? "" : "opacity-30"}`} />
					<figcaption className="mt-1 flex items-center justify-between gap-1 text-xs">
						<span className="truncate">{p.label}</span>
						{STATE[p.state] && <Badge variant={p.state === "removed" ? "destructive" : "secondary"}>{STATE[p.state]}</Badge>}
						{save && p.role !== "option" && (p.state === "used" || p.state === "removed") && (
							<Button
								size="xs"
								variant={p.state === "removed" ? "secondary" : "destructive"}
								onClick={() => save({ id: p.id, removed: p.state !== "removed" })}
							>
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
const FIELDS: { label: string; of: (r: SpecRow) => string }[] = [
	{ label: "售价", of: (r) => price(r.priceTwd) },
	{ label: "进价", of: (r) => `¥${r.costRmb}` },
	{ label: "库存", of: (r) => String(r.stock) },
	{ label: "重量", of: (r) => (r.weightKg === null ? "缺重量" : `${r.weightKg} kg`) },
];

function Specs({ specs, compact }: { specs: SpecsTable; compact?: boolean | undefined }) {
	const { rows, tiers, removed } = specs;
	const same = FIELDS.filter((f) => new Set(rows.map(f.of)).size <= 1);
	const varying = FIELDS.filter((f) => !same.includes(f));
	if (compact) {
		const prices = [...new Set(rows.map((r) => r.priceTwd))].filter((p) => p !== null) as number[];
		const range = prices.length ? (prices.length === 1 ? price(prices[0]!) : `${price(Math.min(...prices))}–${Math.max(...prices)}`) : "未定价";
		return (
			<span className="whitespace-nowrap">
				{rows.length > 1 || tiers.length ? `${rows.length} 个规格 · ` : ""}
				{range}
			</span>
		);
	}
	const images = rows.some((r) => r.image);
	return (
		<div className="flex flex-col gap-2">
			<div className="text-sm text-muted-foreground">
				{[`${rows.length} 个规格`, ...same.map((f) => `${f.label}${rows.length > 1 ? "都是" : ""} ${rows[0] ? f.of(rows[0]) : "—"}`)].join(" · ")}
			</div>
			{tiers.length > 0 && (
				<div className="max-h-[28rem] overflow-auto rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								{images && <TableHead className="w-16">规格图</TableHead>}
								{tiers.map((t) => (
									<TableHead key={t}>{t}</TableHead>
								))}
								{varying.map((f) => (
									<TableHead key={f.label} className="text-right">
										{f.label}
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((r) => (
								<TableRow key={r.sku}>
									{images && (
										<TableCell>
											{r.image && <img src={r.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-10 max-w-none rounded object-cover" />}
										</TableCell>
									)}
									{r.options.map((o, a) => (
										<TableCell key={tiers[a]}>{o}</TableCell>
									))}
									{varying.map((f) => (
										<TableCell key={f.label} className="text-right tabular-nums">
											{f.of(r)}
										</TableCell>
									))}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
			{removed.length > 0 && <div className="text-sm text-muted-foreground">已移除：{removed.map((x) => `${x.name}（${x.count} 个规格）`).join("、")}</div>}
		</div>
	);
}
