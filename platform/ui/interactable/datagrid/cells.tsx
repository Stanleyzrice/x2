// 一格：照列的类型显示；人能改的照类型给控件，改完就存（勾、选马上存，字离开输入框时存）。datagrid 的表格和卡片都用它
import { useEffect, useState } from "react";
import { type LightboxImage, useLightbox } from "@/components/lightbox";
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
	if (col.type === "image") return <ImageCell src={String(value)} label={col.label} compact={compact} />;
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

function ImageCell({ src, label, compact }: { src: string; label: string; compact?: boolean | undefined }) {
	const { open, lightbox } = useLightbox([{ src, alt: label, label }]);
	return (
		<>
			<button
				type="button"
				aria-label={`放大${label}`}
				className="cursor-zoom-in rounded focus-visible:outline-2 focus-visible:outline-ring"
				onClick={(e) => {
					e.stopPropagation();
					open(0);
				}}
			>
				<img src={src} alt={label} referrerPolicy="no-referrer" className={compact ? "size-10 rounded object-cover" : "size-24 rounded object-cover"} />
			</button>
			{lightbox}
		</>
	);
}

function Pics({ pics, compact, save }: { pics: Pic[]; compact?: boolean | undefined; save?: Save }) {
	const { open, lightbox } = useLightbox(pics.map((p) => ({ src: p.url, alt: p.label, label: [p.label, STATE[p.state]].filter(Boolean).join(" · ") })));
	if (compact) {
		const coverIndex = pics.findIndex((p) => p.role === "main" && p.state === "used");
		const cover = pics[coverIndex];
		return cover ? (
			<>
				<button
					type="button"
					aria-label={`放大${cover.label}`}
					className="cursor-zoom-in rounded focus-visible:outline-2 focus-visible:outline-ring"
					onClick={(e) => {
						e.stopPropagation();
						open(coverIndex);
					}}
				>
					<img src={cover.url} alt={cover.label} referrerPolicy="no-referrer" className="size-14 rounded object-cover" />
				</button>
				{lightbox}
			</>
		) : (
			<span className="text-muted-foreground">—</span>
		);
	}
	return (
		<div className="flex flex-wrap gap-3">
			{pics.map((p, index) => (
				<figure key={`${p.label}:${p.id}`} className="w-32" title={p.why}>
					<button
						type="button"
						aria-label={`放大${p.label}`}
						className="cursor-zoom-in rounded-lg focus-visible:outline-2 focus-visible:outline-ring"
						onClick={(e) => {
							e.stopPropagation();
							open(index);
						}}
					>
						<img
							src={p.url}
							alt={p.label}
							loading="lazy"
							referrerPolicy="no-referrer"
							className={`size-32 rounded-lg border object-cover ${p.state === "used" ? "" : "opacity-30"}`}
						/>
					</button>
					<figcaption className="mt-1 flex items-center justify-between gap-1 text-xs">
						<span className="truncate">{p.label}</span>
						{STATE[p.state] && <Badge variant={p.state === "removed" ? "destructive" : "secondary"}>{STATE[p.state]}</Badge>}
						{save && p.role !== "option" && (p.state === "used" || p.state === "removed") && (
							<Button
								size="xs"
								variant={p.state === "removed" ? "secondary" : "destructive"}
								onClick={(e) => {
									e.stopPropagation();
									save({ id: p.id, removed: p.state !== "removed" });
								}}
							>
								{p.state === "removed" ? "放回" : "删"}
							</Button>
						)}
					</figcaption>
				</figure>
			))}
			{lightbox}
		</div>
	);
}

function GridCell({ grid, compact }: { grid: Grid; compact?: boolean | undefined }) {
	const labelOf = (row: Grid["rows"][number]) =>
		grid.columns.flatMap((col, i) => (col.numeric ? [] : [`${col.label}：${row.cells[i] ?? "—"}`])).join(" · ") || grid.imageLabel || "规格图";
	const gallery: LightboxImage[] = [];
	const imageIndex = new Map<string, number>();
	for (const row of grid.rows) {
		if (!row.image || imageIndex.has(row.image)) continue;
		imageIndex.set(row.image, gallery.length);
		const sameImageRows = grid.rows.filter((r) => r.image === row.image);
		const label =
			grid.columns
				.flatMap((col, i) => (!col.numeric && sameImageRows.every((r) => r.cells[i] === row.cells[i]) ? [`${col.label}：${row.cells[i] ?? "—"}`] : []))
				.join(" · ") ||
			grid.imageLabel ||
			"规格图";
		gallery.push({ src: row.image, alt: label, label });
	}
	const { open, lightbox } = useLightbox(gallery);
	if (compact) return <span className="whitespace-nowrap">{grid.summary}</span>;
	const images = gallery.length > 0;
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
											{r.image && (
												<button
													type="button"
													aria-label={`放大${labelOf(r)}`}
													className="cursor-zoom-in rounded focus-visible:outline-2 focus-visible:outline-ring"
													onClick={(e) => {
														e.stopPropagation();
														const index = imageIndex.get(r.image ?? "");
														if (index !== undefined) open(index);
													}}
												>
													<img src={r.image} alt={labelOf(r)} loading="lazy" referrerPolicy="no-referrer" className="size-10 max-w-none rounded object-cover" />
												</button>
											)}
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
			{lightbox}
		</div>
	);
}
