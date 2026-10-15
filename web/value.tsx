// 一格：照列的类型显示；人能改的照类型给控件，改完就存（勾、选马上存，字离开输入框时存）。表格和卡片都用它
import { Badge, Button, Checkbox, Input, InputArea, Link, Select } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
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
