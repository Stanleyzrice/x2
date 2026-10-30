// 一格：照列的类型显示；人能改的照类型给控件，改完就存（勾、选马上存，字离开输入框时存）。datagrid 的表格和卡片都用它
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import type { Column, Grid, Pic } from "../../api.ts";

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
	if (col.type === "grid" && value) return <GridCell grid={value as Grid} compact={compact} />;
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

function GridCell({ grid, compact }: { grid: Grid; compact?: boolean | undefined }) {
	if (compact) return <span className="whitespace-nowrap">{grid.summary}</span>;
	const images = grid.rows.some((r) => r.image);
	return (
		<div className="flex flex-col gap-2">
			<div className="text-sm text-muted-foreground">{grid.caption}</div>
			{grid.columns.length > 0 && grid.rows.length > 0 && (
				<div className="max-h-[28rem] overflow-auto rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								{images && <TableHead className="w-16">{grid.imageLabel}</TableHead>}
								{grid.columns.map((c) => (
									<TableHead key={c.label} className={c.numeric ? "text-right" : undefined}>
										{c.label}
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{grid.rows.map((r) => (
								<TableRow key={r.key}>
									{images && (
										<TableCell>
											{r.image && <img src={r.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="size-10 max-w-none rounded object-cover" />}
										</TableCell>
									)}
									{r.cells.map((v, k) => (
										<TableCell key={grid.columns[k]?.label ?? k} className={grid.columns[k]?.numeric ? "text-right tabular-nums" : undefined}>
											{v}
										</TableCell>
									))}
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
			{grid.note && <div className="text-sm text-muted-foreground">{grid.note}</div>}
		</div>
	);
}
