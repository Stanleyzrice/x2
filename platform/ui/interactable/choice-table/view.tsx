// 每次只提交一行的决定，服务端合并保存。收到成功才改变已选状态，页面重读不会用旧快照撤销刚保存的选择。
import { ExternalLinkIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLightbox } from "@/components/lightbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, type Item as PageItem } from "../../api.ts";
import type { Answer, Decision, Props } from "./schema.ts";

export function View({ props, item }: { props: Props; item: PageItem }) {
	const saved = item.answer as Answer | null;
	const [decisions, setDecisions] = useState<Answer>(saved ?? {});
	const seen = useRef(item.answeredAt);
	useEffect(() => {
		if (seen.current === item.answeredAt) return;
		seen.current = item.answeredAt;
		setDecisions(saved ?? {});
	}, [item.answeredAt, saved]);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<Decision | "all">("all");
	const [busy, setBusy] = useState<string | null>(null);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const gallery = props.rows.flatMap((r) => (r.image ? [{ src: r.image, alt: r.name, label: `${r.code ?? r.id} · ${r.name} · ${r.description ?? ""}` }] : []));
	const { open, lightbox } = useLightbox(gallery);
	const imageIndexes = new Map(props.rows.filter((r) => r.image).map((r, i) => [r.id, i]));
	const counts = { pending: 0, yes: 0, no: 0 };
	for (const r of props.rows) counts[decisions[r.id] ?? "pending"]++;
	const choices: { key: Decision | "all"; label: string; count: number }[] = [
		{ key: "all", label: "全部", count: props.rows.length },
		{ key: "pending", label: "待选择", count: counts.pending },
		{ key: "yes", label: props.positiveLabel, count: counts.yes },
		{ key: "no", label: props.negativeLabel, count: counts.no },
	];
	const needle = query.trim().toLocaleLowerCase();
	const rows = props.rows.filter(
		(r) =>
			(filter === "all" || (decisions[r.id] ?? "pending") === filter) &&
			(!needle || [r.code, r.id, r.name, r.description, item.notes?.[r.id], ...r.tags, ...r.cells].join(" ").toLocaleLowerCase().includes(needle)),
	);
	const choose = async (r: Props["rows"][number], value: Decision) => {
		if (busy) return;
		setBusy(r.id);
		setError("");
		try {
			await api.answer(item.id, { [r.id]: value });
			setDecisions((current) => ({ ...current, [r.id]: value }));
			setMessage(`${r.code ?? r.name} 已保存：${value === "pending" ? "待选择" : value === "yes" ? props.positiveLabel : props.negativeLabel}`);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="flex flex-col gap-4 p-4 md:p-5">
			{props.question && <p className="max-w-4xl whitespace-pre-wrap text-sm text-muted-foreground">{props.question}</p>}
			<div className="flex flex-wrap items-center gap-2">
				{choices.map((c) => (
					<Button key={c.key} size="sm" variant={filter === c.key ? "default" : "outline"} aria-pressed={filter === c.key} onClick={() => setFilter(c.key)}>
						{c.label} <span className="tabular-nums">{c.count}</span>
					</Button>
				))}
				<div className="relative ml-auto w-full sm:w-72">
					<SearchIcon className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
					<Input aria-label="搜索商品" placeholder="搜索编号、商品、规格" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-8" />
				</div>
			</div>
			<div className="flex min-h-5 flex-wrap items-center gap-3 text-xs text-muted-foreground" aria-live="polite">
				<span>
					显示 {rows.length} / {props.rows.length} 款 · 点击后自动保存，可随时改选
				</span>
				{busy ? <span>保存中…</span> : message && <span>{message}</span>}
			</div>
			{error && (
				<p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">
					保存失败：{error}
				</p>
			)}
			<div className="overflow-x-auto rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>商品图片与规格</TableHead>
							<TableHead>链接</TableHead>
							{props.columns.map((c) => (
								<TableHead key={c} className="whitespace-nowrap">
									{c}
								</TableHead>
							))}
							<TableHead className="sticky right-0 z-10 min-w-36 bg-background">你的选择</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((r) => {
							const value = decisions[r.id] ?? "pending";
							return (
								<TableRow key={r.id}>
									<TableCell className="min-w-72 max-w-96 align-top">
										<div className="flex gap-3">
											{r.image ? (
												<button
													type="button"
													aria-label={`放大 ${r.code ?? ""} ${r.name}`}
													className="shrink-0 cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-ring"
													onClick={() => open(imageIndexes.get(r.id)!)}
												>
													<img src={r.image} alt={r.name} loading="lazy" referrerPolicy="no-referrer" className="size-24 rounded-md bg-muted object-contain" />
												</button>
											) : (
												<span className="flex size-24 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">图片暂定</span>
											)}
											<div className="flex min-w-0 flex-col gap-1.5">
												{r.code && <span className="font-mono text-xs text-muted-foreground">{r.code}</span>}
												<p className="whitespace-normal text-sm font-medium">{r.name}</p>
												{r.description && (
													<p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground" title={r.description}>
														{r.description}
													</p>
												)}
												{r.tags.length > 0 && (
													<div className="flex flex-wrap gap-1">
														{r.tags.map((t) => (
															<Badge key={t} variant="secondary">
																{t}
															</Badge>
														))}
													</div>
												)}
											</div>
										</div>
										{props.editableNotes && (
											<DescriptionEditor
												itemId={item.id}
												rowId={r.id}
												label={props.noteLabel ?? "自定义描述"}
												name={r.code ?? r.name}
												saved={item.notes?.[r.id] ?? ""}
												updatedAt={item.notesAt ?? ""}
											/>
										)}
									</TableCell>
									<TableCell className="min-w-32 space-y-3 align-top">
										{r.link ? (
											<a
												href={r.link}
												target="_blank"
												rel="noreferrer"
												className="inline-flex items-start gap-1 whitespace-normal break-all text-sm text-primary underline-offset-4 hover:underline"
											>
												<ExternalLinkIcon className="mt-0.5 size-3.5 shrink-0" />
												{r.linkText ?? props.linkLabel}
											</a>
										) : (
											<Badge variant="outline">暂定</Badge>
										)}
										{r.links?.map((link) => (
											<a
												key={link.url}
												href={link.url}
												target="_blank"
												rel="noreferrer"
												className="flex items-start gap-1 whitespace-normal break-all text-sm text-primary underline-offset-4 hover:underline"
											>
												<ExternalLinkIcon className="mt-0.5 size-3.5 shrink-0" />
												{link.label}
											</a>
										))}
									</TableCell>
									{r.cells.map((v, i) => (
										<TableCell key={props.columns[i]} className="min-w-32 max-w-60 whitespace-pre-wrap align-top text-sm tabular-nums">
											{v ?? "—"}
										</TableCell>
									))}
									<TableCell className="sticky right-0 z-10 bg-background align-top shadow-[-5px_0_8px_-6px_rgba(0,0,0,0.2)]">
										<div className="flex flex-col items-start gap-2">
											<div className="flex gap-1.5">
												<Button
													size="sm"
													variant={value === "yes" ? "default" : "outline"}
													aria-label={`${r.code ?? r.name}：${props.positiveLabel}`}
													aria-pressed={value === "yes"}
													disabled={Boolean(busy)}
													onClick={() => choose(r, "yes")}
												>
													{props.positiveLabel}
												</Button>
												<Button
													size="sm"
													variant={value === "no" ? "destructive" : "outline"}
													aria-label={`${r.code ?? r.name}：${props.negativeLabel}`}
													aria-pressed={value === "no"}
													disabled={Boolean(busy)}
													onClick={() => choose(r, "no")}
												>
													{props.negativeLabel}
												</Button>
											</div>
											<span className="text-xs text-muted-foreground">
												{value === "pending" ? "待选择" : `已选：${value === "yes" ? props.positiveLabel : props.negativeLabel}`}
											</span>
											{value !== "pending" && (
												<Button
													size="xs"
													variant="ghost"
													disabled={Boolean(busy)}
													aria-label={`撤回 ${r.code ?? r.name} 的选择`}
													onClick={() => choose(r, "pending")}
												>
													撤回选择
												</Button>
											)}
										</div>
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
				{!rows.length && <p className="p-8 text-center text-sm text-muted-foreground">没有符合筛选的商品</p>}
			</div>
			{lightbox}
		</div>
	);
}

function DescriptionEditor({
	itemId,
	rowId,
	label,
	name,
	saved,
	updatedAt,
}: {
	itemId: string;
	rowId: string;
	label: string;
	name: string;
	saved: string;
	updatedAt: string;
}) {
	const [value, setValue] = useState(saved);
	const [focused, setFocused] = useState(false);
	const [status, setStatus] = useState<"saved" | "dirty" | "saving" | "error">("saved");
	const [error, setError] = useState("");
	const draft = useRef(saved);
	const confirmed = useRef(saved);
	const savedAt = useRef(updatedAt);
	const pending = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	// 同一行一次只送一个请求；输入过程中旧请求完成后，再送最新文本，避免旧内容最后落库。
	const save = async () => {
		if (pending.current || draft.current === confirmed.current) return;
		pending.current = true;
		setStatus("saving");
		setError("");
		try {
			do {
				const text = draft.current;
				const result = await api.note(itemId, rowId, text);
				confirmed.current = text;
				savedAt.current = result.updatedAt;
			} while (draft.current !== confirmed.current);
			setStatus("saved");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setStatus("error");
		} finally {
			pending.current = false;
		}
	};
	const saveRef = useRef(save);
	saveRef.current = save;

	useEffect(() => {
		if (focused || pending.current || draft.current !== confirmed.current || updatedAt < savedAt.current) return;
		draft.current = saved;
		confirmed.current = saved;
		savedAt.current = updatedAt;
		setValue(saved);
		setStatus("saved");
	}, [saved, updatedAt, focused]);

	useEffect(
		() => () => {
			clearTimeout(timer.current);
			void saveRef.current();
		},
		[],
	);

	const id = `description-${itemId}-${rowId}`;
	return (
		<div className="mt-3 flex flex-col gap-1.5">
			<label htmlFor={id} className="text-xs font-medium">
				{label}
			</label>
			<Textarea
				id={id}
				aria-label={`${name} ${label}`}
				value={value}
				maxLength={4000}
				rows={3}
				placeholder="填写你的描述、想法或备注…"
				className="min-h-24 resize-y bg-background text-sm"
				onFocus={() => setFocused(true)}
				onChange={(e) => {
					draft.current = e.target.value;
					setValue(e.target.value);
					setStatus("dirty");
					setError("");
					clearTimeout(timer.current);
					timer.current = setTimeout(() => void saveRef.current(), 700);
				}}
				onBlur={() => {
					setFocused(false);
					clearTimeout(timer.current);
					void saveRef.current();
				}}
			/>
			<span className="text-xs text-muted-foreground" aria-live="polite">
				{status === "saving"
					? "保存中…"
					: status === "dirty"
						? "未保存"
						: status === "error"
							? "保存失败，内容已保留"
							: value
								? "已保存"
								: "停止输入后自动保存"}
			</span>
			{error && (
				<div role="alert" className="text-xs text-destructive">
					{error}
					<Button size="xs" variant="ghost" onClick={() => void saveRef.current()}>
						重试保存
					</Button>
				</div>
			)}
		</div>
	);
}

export const tab = (p: Props) => p.title ?? "逐行选择";
