// 采购记录只展示服务端保存的事实与金额；同步走后台任务，轮询只读 DB，不在组件内重算成本或读取外站。

import { ChevronLeftIcon, ChevronRightIcon, DownloadIcon, ExternalLinkIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLightbox } from "@/components/lightbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorOf } from "@/lib/state";
import { api, type Item as PageItem, usePoll } from "../../api.ts";
import { BrowserConnection } from "../../browser-connection.tsx";
import { ResizableSheetContent } from "../../resizable-sheet.tsx";
import type { Props } from "./schema.ts";

import type { RecordRow } from "./types.ts";

type MarkReceipt = { revision: number; reported: boolean };

const time = (v: string | null) => (v ? new Date(v).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "未知");

export function View({ props, item }: { props: Props; item: PageItem }) {
	const [account, setAccount] = useState("all");
	const [query, setQuery] = useState("");
	const [search, setSearch] = useState("");
	const [paidFrom, setPaidFrom] = useState("");
	const [paidTo, setPaidTo] = useState("");
	const [offset, setOffset] = useState(0);
	const [selected, setSelected] = useState<RecordRow | null>(null);
	const [starting, setStarting] = useState(false);
	const [connecting, setConnecting] = useState(false);
	const [refreshError, setRefreshError] = useState<string | null>(null);
	const [exporting, setExporting] = useState(false);
	const [exportError, setExportError] = useState<string | null>(null);
	const [markError, setMarkError] = useState<string | null>(null);
	const [marking, setMarking] = useState<Record<string, "saving" | MarkReceipt>>({});
	const markingRef = useRef(new Set<string>());
	useEffect(() => {
		const timer = setTimeout(() => {
			setSearch(query);
			setOffset(0);
		}, 250);
		return () => clearTimeout(timer);
	}, [query]);
	const input = { ...(props.accounts ? { accounts: props.accounts } : {}), ...(account === "all" ? {} : { account }), search, paidFrom, paidTo, offset };
	const scopeKey = JSON.stringify([item.id, input]);
	const readScope = useRef<string | null>(null);
	const [loaded, error, reload] = usePoll(
		() => {
			// 首次打开当前筛选先使用短时快照，后续轮询与聚焦仍读取最新标记和进度。
			const force = readScope.current === scopeKey;
			readScope.current = scopeKey;
			return api.reimbursementRecords(item.id, input, force);
		},
		5000,
		[item.id, props.accounts, account, search, paidFrom, paidTo, offset],
		api.peekReimbursementRecords(item.id, input),
	);
	const expected = { account: account === "all" ? null : account, accounts: props.accounts ?? null, search, paidFrom, paidTo, offset };
	const data = loaded && JSON.stringify(loaded.query) === JSON.stringify(expected) ? loaded : null;
	useEffect(() => {
		if (!data) return;
		setMarking((old) => {
			let changed = false;
			const next = { ...old };
			for (const row of data.rows) {
				const key = `${row.account}:${row.orderId}`,
					receipt = old[key];
				if (receipt && receipt !== "saving" && row.reportRevision >= receipt.revision) {
					delete next[key];
					markingRef.current.delete(key);
					changed = true;
				}
			}
			return changed ? next : old;
		});
	}, [data]);
	const markReported = async (row: RecordRow, reported: boolean) => {
		const key = `${row.account}:${row.orderId}`;
		if (markingRef.current.has(key)) return;
		markingRef.current.add(key);
		setMarking((old) => ({ ...old, [key]: "saving" }));
		setMarkError(null);
		try {
			const result = await api.act<{ account: string; orderId: string; reported: boolean; revision: number; updatedAt: string }>(item.id, "markReported", {
				account: row.account,
				orderId: row.orderId,
				reported,
				revision: row.reportRevision,
			});
			if (result.account !== row.account || result.orderId !== row.orderId || result.reported !== reported)
				throw new Error("报帐标记返回的订单身份或状态不一致，请重新读取");
			setMarking((old) => ({ ...old, [key]: { revision: result.revision, reported: result.reported } }));
			api.invalidateReimbursementRecords(item.id);
			reload();
		} catch (e) {
			setMarkError(errorOf(e));
			markingRef.current.delete(key);
			setMarking((old) => {
				const next = { ...old };
				delete next[key];
				return next;
			});
			api.invalidateReimbursementRecords(item.id);
			reload();
		}
	};
	const refresh = (targetAccount?: string) => {
		setStarting(true);
		setRefreshError(null);
		const refreshAccount = targetAccount ?? (account === "all" ? undefined : account);
		return api
			.act(item.id, "refresh", refreshAccount ? { account: refreshAccount } : {})
			.catch((e: Error) => setRefreshError(e.message))
			.finally(() => {
				api.invalidateReimbursementRecords(item.id);
				reload();
				setStarting(false);
			});
	};
	const connected = async (actual: { id: string }) => {
		if (props.accounts && !props.accounts.includes(actual.id)) throw new Error("当前登录账号不在本页允许的采购账号范围内，请切换账号后重新检测。");
		await refresh(actual.id);
	};
	const download = async () => {
		setExporting(true);
		setExportError(null);
		try {
			const file = await api.act<{ filename: string; mime: string; base64: string }>(item.id, "export", {
				...(account === "all" ? {} : { account }),
				search,
				paidFrom,
				paidTo,
			});
			const bytes = Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0));
			const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
			const link = document.createElement("a");
			link.href = url;
			link.download = file.filename;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (e) {
			setExportError(errorOf(e));
		} finally {
			setExporting(false);
		}
	};
	return (
		<div className="flex min-h-full flex-col gap-5 p-4 sm:p-6">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="text-xl font-semibold tracking-tight">采购报账</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						1688 已付款采购记录 · 原实付金额 CNY ·{" "}
						{props.schedule
							? `后台服务运行时每天 ${String(props.schedule.hour).padStart(2, "0")}:00 ${props.schedule.timeZone} 刷新`
							: "未配置后台刷新，可手动刷新"}
					</p>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button
						variant="outline"
						onClick={download}
						title="导出当前筛选内未勾选已报帐的订单，包含所有分页"
						disabled={exporting || !data || query !== search || Object.values(marking).some((state) => state === "saving")}
					>
						<DownloadIcon />
						{exporting ? "正在导出…" : "导出未报账"}
					</Button>
					<Button variant="outline" onClick={() => void refresh()} disabled={starting || connecting || data?.accounts.some((a) => a.status === "running")}>
						<RefreshCwIcon className={starting ? "animate-spin" : ""} />
						{starting ? "正在刷新…" : "刷新采购记录"}
					</Button>
				</div>
			</header>
			<BrowserConnection
				expectedAccount={account === "all" ? (props.accounts?.length === 1 ? props.accounts[0] : undefined) : account}
				disabled={starting || connecting || data?.accounts.some((a) => a.status === "running")}
				onCheckingChange={setConnecting}
				onConnected={connected}
			/>
			{exportError && (
				<p role="alert" className="text-sm text-destructive">
					{exportError}
				</p>
			)}
			{(error || refreshError || data?.global?.error) && (
				<div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
					{refreshError ?? error ?? data?.global?.error}。上次成功记录继续保留。
				</div>
			)}
			{markError ? (
				<div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
					{markError}。正在重新读取记录，未自动重试标记。
				</div>
			) : null}
			{data?.global?.status === "running" && (
				<p role="status" className="text-sm text-muted-foreground">
					正在识别账号或读取完整采购历史，进度见下方账号；完成后返回刷新结果。
				</p>
			)}
			{data && (
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
					{data.accounts.map((a) => (
						<Card key={a.id} className="gap-2 py-3">
							<CardHeader className="px-4">
								<CardTitle className="flex items-center justify-between gap-2 text-sm">
									{a.name}
									<Badge variant={a.status === "failed" || a.status === "interrupted" ? "destructive" : "secondary"}>
										{a.status === "running"
											? "同步中"
											: a.status === "succeeded"
												? "已同步"
												: a.status === "failed"
													? "同步失败"
													: a.status === "interrupted"
														? "任务中断"
														: "尚未同步"}
									</Badge>
								</CardTitle>
							</CardHeader>
							<CardContent className="space-y-1 px-4 text-xs text-muted-foreground">
								<p>最后成功：{time(a.lastSuccessAt)}</p>
								{a.status === "running" && (
									<p role="status">
										已读取 {a.page ?? 0} / {a.pages ?? "未知"} 页 · {a.observed ?? 0} / {a.total ?? "未知"} 单
									</p>
								)}
								{a.unknownCount !== null && a.unknownCount > 0 && <p>{a.unknownCount} 单缺少付款时间证据，未列为已付款</p>}
								{a.error && <p className="text-destructive">{a.error}</p>}
								{(a.status === "failed" || a.status === "interrupted" || a.error) && (
									<BrowserConnection
										expectedAccount={a.id}
										disabled={starting || connecting || data.accounts.some((entry) => entry.status === "running")}
										onCheckingChange={setConnecting}
										onConnected={connected}
									/>
								)}
							</CardContent>
						</Card>
					))}
				</div>
			)}
			<div className="flex flex-wrap items-center gap-3">
				<Select
					value={account}
					onValueChange={(v) => {
						setAccount(String(v ?? "all"));
						setOffset(0);
					}}
				>
					<SelectTrigger className="w-56" aria-label="采购账号">
						<SelectValue>{account === "all" ? "全部采购账号" : (data?.accounts.find((a) => a.id === account)?.name ?? account)}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">全部采购账号</SelectItem>
						{data?.accounts.map((a) => (
							<SelectItem key={a.id} value={a.id}>
								{a.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<div className="relative min-w-48 grow">
					<SearchIcon className="absolute top-2.5 left-3 size-4 text-muted-foreground" />
					<Input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="pl-9"
						placeholder="搜索订单号、供应商、商品或规格"
						aria-label="搜索采购记录"
					/>
				</div>
				<span className="text-sm text-muted-foreground">{data ? `${data.total} 单` : "读取中…"}</span>
			</div>
			<div className="flex flex-wrap items-end gap-3">
				<div className="space-y-1.5">
					<Label htmlFor={`paid-from-${item.id}`}>付款起始日</Label>
					<Input
						id={`paid-from-${item.id}`}
						type="date"
						value={paidFrom}
						max={paidTo || undefined}
						onChange={(e) => {
							setPaidFrom(e.target.value);
							setOffset(0);
						}}
						className="w-44"
					/>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor={`paid-to-${item.id}`}>付款截止日</Label>
					<Input
						id={`paid-to-${item.id}`}
						type="date"
						value={paidTo}
						min={paidFrom || undefined}
						onChange={(e) => {
							setPaidTo(e.target.value);
							setOffset(0);
						}}
						className="w-44"
					/>
				</div>
				<Button
					variant="ghost"
					disabled={!paidFrom && !paidTo}
					onClick={() => {
						setPaidFrom("");
						setPaidTo("");
						setOffset(0);
					}}
				>
					全部历史
				</Button>
				<span className="pb-2 text-xs text-muted-foreground">按 Asia/Shanghai 付款日期，包含起止日</span>
			</div>
			{data && (
				<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
					<Card className="gap-2 py-4">
						<CardHeader className="px-4">
							<CardTitle className="text-sm font-medium text-muted-foreground">{data.summary.complete ? "原实付合计 CNY" : "已知原实付合计 CNY"}</CardTitle>
						</CardHeader>
						<CardContent className="space-y-1 px-4">
							<p className="text-2xl font-semibold tracking-tight tabular-nums">{data.summary.amountDisplay ?? "金额未知"}</p>
							<p className="text-xs text-muted-foreground">当前筛选的全部匹配订单，包含其他分页</p>
						</CardContent>
					</Card>
					<Card className="gap-2 py-4">
						<CardHeader className="px-4">
							<CardTitle className="text-sm font-medium text-muted-foreground">
								{data.pendingSummary.complete ? "待报帐金额 CNY" : "已知待报帐金额 CNY"}
							</CardTitle>
						</CardHeader>
						<CardContent className="space-y-1 px-4">
							<p className="text-2xl font-semibold tracking-tight tabular-nums">{data.pendingSummary.amountDisplay ?? "金额未知"}</p>
							<p className="text-xs text-muted-foreground">按本页人工标记统计，包含当前筛选的其他分页</p>
							<p className="text-xs text-muted-foreground">
								未报帐 {data.pendingSummary.orderCount} 单 · {data.pendingSummary.missingCount} 单金额未知
							</p>
						</CardContent>
					</Card>
					<Card className="gap-2 py-4">
						<CardHeader className="px-4">
							<CardTitle className="text-sm font-medium text-muted-foreground">匹配订单</CardTitle>
						</CardHeader>
						<CardContent className="space-y-1 px-4">
							<p className="text-2xl font-semibold tabular-nums">
								{data.summary.orderCount} <span className="text-sm font-normal text-muted-foreground">单</span>
							</p>
							<p className="text-xs text-muted-foreground">
								{data.summary.knownCount} 单金额已知 · {data.summary.missingCount} 单金额未知
							</p>
						</CardContent>
					</Card>
				</div>
			)}
			{!data ? (
				<Skeleton className="h-64 w-full" />
			) : !data.rows.length ? (
				<div className="rounded-xl border border-dashed p-12 text-center">
					<h3 className="font-medium">暂无已付款采购记录</h3>
					<p className="mt-2 text-sm text-muted-foreground">
						{!data.accounts.length ? "连接已登录 1688 的 Chrome 后点击刷新，首次读取完整历史。" : "可调整筛选，或刷新账号的完整采购历史。"}
					</p>
				</div>
			) : (
				<div className="overflow-x-auto rounded-xl border">
					<Table>
						<TableHeader>
							<TableRow>
								{["采购账号", "1688 订单号", "采购商品", "供应商", "付款时间", "原实付 CNY", "订单状态", "明细", "已报帐"].map((h) => (
									<TableHead key={h} className={h === "已报帐" ? "sticky right-0 z-10 border-l bg-muted text-center whitespace-nowrap" : "whitespace-nowrap"}>
										{h}
									</TableHead>
								))}
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.rows.map((r) => (
								<TableRow key={`${r.account}:${r.orderId}`}>
									<TableCell>{r.accountName}</TableCell>
									<TableCell className="font-mono text-xs">{r.orderId}</TableCell>
									<TableCell className="min-w-64 max-w-80 whitespace-normal">
										<PurchasedItems items={r.items} compact />
									</TableCell>
									<TableCell className="max-w-40 whitespace-normal break-words">
										{r.supplier ?? <span className="text-muted-foreground">未提供</span>}
									</TableCell>
									<TableCell className="whitespace-nowrap text-xs">{time(r.paidAt)}</TableCell>
									<TableCell className="whitespace-nowrap font-medium tabular-nums">{r.paidDisplay ?? "金额未知"}</TableCell>
									<TableCell>
										<Badge variant="outline">{r.statusLabel ?? r.status ?? "未知"}</Badge>
										{r.absentFromLatest && <span className="mt-1 block text-xs text-muted-foreground">历史保留 · 本轮未返回</span>}
									</TableCell>
									<TableCell>
										<Button variant="ghost" size="sm" onClick={() => setSelected(r)}>
											查看明细
										</Button>
									</TableCell>
									<TableCell className="sticky right-0 z-10 min-w-20 border-l bg-background text-center whitespace-normal">
										<div className="flex flex-col items-center gap-1">
											<Checkbox
												aria-label={`已报帐：${r.accountName} ${r.orderId}`}
												checked={r.reported}
												disabled={Boolean(marking[`${r.account}:${r.orderId}`])}
												onCheckedChange={(value) => void markReported(r, value === true)}
												title={r.reported ? `标记时间：${time(r.reportedAt)}` : "尚未标记报帐"}
											/>
											{marking[`${r.account}:${r.orderId}`] ? (
												<span role="status" className="text-[10px] text-muted-foreground">
													{marking[`${r.account}:${r.orderId}`] === "saving" ? "保存中…" : "读取更新…"}
												</span>
											) : null}
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
			{data && data.total > data.limit && (
				<div className="flex items-center justify-end gap-2">
					<Button size="sm" variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - data.limit))}>
						<ChevronLeftIcon />
						上一页
					</Button>
					<span className="text-xs text-muted-foreground">
						{offset + 1}–{Math.min(offset + data.limit, data.total)}
					</span>
					<Button size="sm" variant="outline" disabled={offset + data.limit >= data.total} onClick={() => setOffset(offset + data.limit)}>
						下一页
						<ChevronRightIcon />
					</Button>
				</div>
			)}
			<Sheet
				open={selected !== null}
				onOpenChange={(open) => {
					if (!open) setSelected(null);
				}}
			>
				<ResizableSheetContent storageKey="x2:reimbursement-detail-width:v1">
					<SheetHeader>
						<SheetTitle>采购订单明细</SheetTitle>
					</SheetHeader>
					{selected && (
						<div className="space-y-5 p-4">
							<div className="space-y-2 text-sm">
								<p className="break-all font-mono">{selected.orderId}</p>
								<p>
									{selected.accountName} · {selected.supplier ?? "供应商未提供"}
								</p>
								<p>付款：{time(selected.paidAt)}</p>
								<p>
									原实付：<strong>{selected.paidDisplay ?? "未知"}</strong>
								</p>
								<p className="text-xs text-muted-foreground">
									商品金额 {selected.goodsDisplay ?? "未知"} · 运费 {selected.freightDisplay ?? "未知"} · 优惠 {selected.discountDisplay ?? "未知"}
								</p>
								<p className="text-xs text-muted-foreground">采集时间：{time(selected.capturedAt)}；退款状态不冲减此处原实付。</p>
								<a className="inline-flex items-center gap-1 underline underline-offset-4" href={selected.url} target="_blank" rel="noreferrer">
									打开 1688 原订单
									<ExternalLinkIcon className="size-3" />
								</a>
							</div>
							<div className="rounded-lg border p-3">
								<PurchasedItems items={selected.items} />
							</div>
						</div>
					)}
				</ResizableSheetContent>
			</Sheet>
		</div>
	);
}

function PurchasedItems({ items, compact = false }: { items: RecordRow["items"]; compact?: boolean }) {
	const pictures = items.flatMap((item, itemIndex) => {
		if (!item.image) return [];
		try {
			const url = new URL(item.image);
			if (!["http:", "https:"].includes(url.protocol)) return [];
			return [
				{
					src: url.href,
					alt: item.name ?? "采购商品",
					label: [item.name ?? "采购商品", item.offerId ? `商品 ID ${item.offerId}` : "商品 ID 未提供", item.spec].filter(Boolean).join(" · "),
					itemIndex,
				},
			];
		} catch {
			return [];
		}
	});
	const { open, lightbox } = useLightbox(pictures);
	return (
		<>
			{items.length > 1 && compact ? <p className="mb-2 text-xs text-muted-foreground">共 {items.length} 条商品</p> : null}
			<div className={compact ? "max-h-48 divide-y overflow-y-auto" : "divide-y"}>
				{items.map((item, index) => {
					const pictureIndex = pictures.findIndex((p) => p.itemIndex === index),
						picture = pictures[pictureIndex];
					return (
						<div key={item.lineId ?? `${item.offerId}:${item.skuId}:${index}`} className="flex items-start gap-3 py-2 first:pt-0 last:pb-0">
							{picture ? (
								<button
									type="button"
									aria-label={`放大${picture.label}`}
									className="shrink-0 cursor-zoom-in rounded-md border focus-visible:outline-2 focus-visible:outline-ring"
									onClick={() => open(pictureIndex)}
								>
									<img
										src={picture.src}
										alt={picture.alt}
										loading="lazy"
										referrerPolicy="no-referrer"
										className={compact ? "size-11 rounded-md object-contain" : "size-20 rounded-md object-contain"}
									/>
								</button>
							) : (
								<span
									className={`${compact ? "size-11" : "size-20"} flex shrink-0 items-center justify-center rounded-md border bg-muted text-center text-[10px] text-muted-foreground`}
								>
									暂无图片
								</span>
							)}
							<div className="min-w-0 grow space-y-1 whitespace-normal break-words">
								<p className={`text-sm font-medium ${compact ? "line-clamp-2" : ""}`}>{item.name ?? "商品名未提供"}</p>
								<p className={`text-xs text-muted-foreground ${compact ? "line-clamp-2" : ""}`}>{item.spec ?? "规格未提供"}</p>
								{item.offerId && /^\d+$/.test(item.offerId) ? (
									<a
										href={`https://detail.1688.com/offer/${encodeURIComponent(item.offerId)}.html`}
										target="_blank"
										rel="noreferrer"
										className="inline-flex max-w-full items-center gap-1 break-all font-mono text-xs underline underline-offset-4"
									>
										{item.offerId}
										<ExternalLinkIcon className="size-3 shrink-0" />
									</a>
								) : (
									<p className="break-all text-xs text-muted-foreground">商品 ID {item.offerId ?? "未知"}</p>
								)}
								{!compact ? (
									<>
										<p className="text-sm">
											采购数量 {item.quantity ?? "未知"} · 单价 {item.unitPriceDisplay ?? "未知"}
										</p>
										<p className="text-xs text-muted-foreground">SKU {item.skuId ?? "未知"}</p>
									</>
								) : null}
							</div>
						</div>
					);
				})}
				{!items.length ? <p className="text-xs text-muted-foreground">网站未提供商品明细。</p> : null}
			</div>
			{lightbox}
		</>
	);
}

export const tab = (p: Props) => p.title ?? "采购报账";
