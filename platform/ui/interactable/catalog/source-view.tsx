// 人工选品的入口与备选列表：采集会话由独立页面管理，备选查看与发布复用 Catalog 的表格、详情面板和确认入口。

import { ArrowUpRightIcon, BoxesIcon, LoaderCircleIcon, PackageSearchIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errorOf, remember, saved } from "@/lib/state";
import { api, type Item, usePoll } from "../../api.ts";
import type { Props } from "./schema.ts";
import { Collector } from "./source-collection.tsx";
import { SourceSheet } from "./source-details.tsx";
import { SourcePromptButton } from "./source-prompt.tsx";
import { currentPublishResult, publishReceiptOf, publishUnresolved, sourceCanPublish, sourceCanSelect } from "./source-state.ts";
import type { PublishReceipt, SourceDeletion, SourceItem, SourceList, SourcePreparation, SourceReceipt, SourceStatus } from "./source-types.ts";

export const sourceStatus: Record<SourceStatus, string> = {
	collected: "已采集",
	"needs-input": "待补充",
	ready: "可上架",
	listed: "已上架",
	unknown: "结果待核对",
};
export function SourcesView({ props, item }: { props: Props; item: Item }) {
	return props.mode === "collect" ? <Collector item={item} /> : <Candidates item={item} defaultShop={props.shop} />;
}

function ErrorMessage({ children }: { children: string | null | undefined }) {
	return children ? (
		<p role="alert" className="rounded-lg border border-destructive/30 bg-background p-3 text-sm text-destructive">
			{children}
		</p>
	) : null;
}

function Candidates({ item, defaultShop }: { item: Item; defaultShop: string }) {
	const [shop, setShop] = useState(defaultShop);
	const [search, setSearch] = useState("");
	const [query, setQuery] = useState("");
	const [platform, setPlatform] = useState("all");
	const [status, setStatus] = useState("all");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [detailId, setDetailId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const pending = useRef(false);
	const receiptKey = `x2-source-publish:${item.id}:${shop}`;
	const [receipts, setReceipts] = useState<Record<string, PublishReceipt | null>>({});
	const receipt = receipts[shop] === undefined ? publishReceiptOf(saved(receiptKey)) : receipts[shop];
	const [result, receiptError, reloadResult] = usePoll(
		() => (receipt ? api.act<SourceReceipt>(item.id, "sourcePublishResult", { targetShop: shop, requestId: receipt.requestId }) : Promise.resolve(null)),
		receipt?.state === "completed" ? 15_000 : 2500,
		[item.id, shop, receipt?.requestId ?? null],
	);
	const input = { targetShop: shop, query, platform, status };
	const lastList = useRef<SourceList | null>(null);
	const initial = api.peekSources(item.id, input) ?? (lastList.current?.shop === shop ? lastList.current : null);
	const [received, loadError, reload] = usePoll(() => api.sources(item.id, input, true), 5000, [item.id, shop, query, platform, status], initial);
	const data = received?.shop === shop ? received : initial;
	useEffect(() => {
		if (received?.shop === shop) lastList.current = received;
	}, [received, shop]);
	useEffect(() => {
		const timer = setTimeout(() => setQuery(search), 250);
		return () => clearTimeout(timer);
	}, [search]);
	const rows = data?.items ?? [];
	const eligible = rows.filter(sourceCanSelect);
	const picked = eligible.filter((row) => selected.has(row.id));
	const publishable = picked.filter(sourceCanPublish);
	const canDeletePicked = picked.length > 0 && picked.every((row) => row.deletable);
	const working = busy || deleting;
	const activeResult = currentPublishResult(receipt, result);
	const unresolved = publishUnresolved(receipt, result);
	const canPublishAll = Boolean(data && data.counts.collected + data.counts.ready + data.counts.needsInput > 0);
	const saveReceipt = (next: PublishReceipt | null) => {
		setReceipts((before) => ({ ...before, [shop]: next }));
		remember(receiptKey, next ? JSON.stringify(next) : null);
	};
	const toggle = (id: string, checked: boolean) =>
		setSelected((before) => {
			const next = new Set(before);
			if (checked) next.add(id);
			else next.delete(id);
			return next;
		});
	const publish = async (all: boolean) => {
		if (pending.current || unresolved) return;
		pending.current = true;
		setBusy(true);
		setError(null);
		let submitted = false;
		const requestId = crypto.randomUUID();
		try {
			const sourceIds = all ? undefined : publishable.map((row) => row.id);
			const input = { targetShop: shop, ...(sourceIds ? { sourceIds } : {}) };
			const prepared = await api.act<SourcePreparation>(item.id, "sourcePrepare", input);
			api.invalidateSources();
			reload();
			if (!prepared.items.some((row) => row.status === "ready")) {
				setError(prepared.problems.flatMap((row) => row.problems).join("；") || "没有可上架的商品，请补齐必填资料。");
				return;
			}
			const preview = await api.prepare(item.id, "sourcePublish", { ...input, requestId });
			if (preview.trialRequired) throw new Error("当前写操作需要首次试单，请先按现有上架流程完成试单。");
			saveReceipt({ requestId, token: preview.token, state: "running" });
			submitted = true;
			await api.confirm(preview.token);
			const completed = await api.act<SourceReceipt>(item.id, "sourcePublishResult", { targetShop: shop, requestId });
			saveReceipt({ requestId, token: preview.token, state: completed.state });
			setSelected(new Set());
			reloadResult();
		} catch (e) {
			const message = errorOf(e);
			setError(message);
			if (submitted) {
				saveReceipt({ requestId, state: "unknown", error: message });
				reloadResult();
			}
		} finally {
			pending.current = false;
			setBusy(false);
			api.invalidateSources();
			reload();
		}
	};
	const askDelete = (sourceIds: string[]) => {
		if (pending.current || !sourceIds.length) return;
		setError(null);
		setDeleteIds(sourceIds);
	};
	const remove = async () => {
		if (pending.current || !deleteIds?.length) return;
		pending.current = true;
		setDeleting(true);
		setError(null);
		try {
			const removed = await api.act<SourceDeletion>(item.id, "sourceDelete", { targetShop: shop, sourceIds: deleteIds });
			api.invalidateSources();
			const ids = new Set([...removed.deleted, ...removed.alreadyDeleted]);
			setSelected((before) => new Set([...before].filter((id) => !ids.has(id))));
			if (detailId && ids.has(detailId)) setDetailId(null);
			setDeleteIds(null);
			reload();
		} catch (e) {
			setError(errorOf(e));
		} finally {
			pending.current = false;
			setDeleting(false);
		}
	};
	return (
		<main className="mx-auto max-w-7xl space-y-5 p-4 md:p-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
						<BoxesIcon className="size-4" />
						人工选品
					</div>
					<h2 className="text-2xl font-semibold tracking-tight">上架备选区</h2>
				</div>
				<Button variant="outline" render={<a href="#manual-collection" />}>
					<PackageSearchIcon />
					继续采集
				</Button>
			</div>
			<div className="grid gap-3 sm:grid-cols-[1fr_180px_180px]">
				<div className="relative">
					<SearchIcon className="pointer-events-none absolute left-3 top-2 size-4 text-muted-foreground" />
					<Input className="pl-9" aria-label="搜索备选商品" placeholder="搜索商品或货源链接" value={search} onChange={(e) => setSearch(e.target.value)} />
				</div>
				<Select value={platform} onValueChange={(value) => setPlatform(String(value))}>
					<SelectTrigger className="w-full" aria-label="采集平台">
						<SelectValue>{platform === "all" ? "全部平台" : "1688"}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">全部平台</SelectItem>
						<SelectItem value="1688">1688</SelectItem>
					</SelectContent>
				</Select>
				<Select value={status} onValueChange={(value) => setStatus(String(value))}>
					<SelectTrigger className="w-full" aria-label="备选商品状态">
						<SelectValue>{status === "all" ? "全部状态" : sourceStatus[status as SourceStatus]}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">全部状态</SelectItem>
						{Object.entries(sourceStatus).map(([value, label]) => (
							<SelectItem key={value} value={value}>
								{label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="flex flex-wrap items-center gap-3 rounded-xl border bg-background p-3">
				<span className="text-sm font-medium">已选 {picked.length} 件</span>
				<Select
					value={shop}
					onValueChange={(value) => {
						setShop(String(value));
						setSelected(new Set());
						setDetailId(null);
						setError(null);
					}}
					disabled={working}
				>
					<SelectTrigger aria-label="上架目标店铺">
						<SelectValue>{shop}</SelectValue>
					</SelectTrigger>
					<SelectContent>
						{(data?.shops ?? [{ shop: defaultShop, shopId: "" }]).map((entry) => (
							<SelectItem key={entry.shop} value={entry.shop}>
								{entry.shop}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<div className="grow" />
				<Button size="sm" variant="ghost" onClick={reload} disabled={working} aria-label="刷新备选区">
					<RefreshCwIcon />
				</Button>
				{picked.length > 0 && (
					<Button variant="outline" disabled={working || !canDeletePicked} onClick={() => askDelete(picked.map((row) => row.id))}>
						删除选中（{picked.length}）
					</Button>
				)}
				<Button variant="outline" disabled={working || unresolved || !canPublishAll} onClick={() => void publish(true)}>
					全部上架
				</Button>
				<Button disabled={working || !publishable.length || unresolved} onClick={() => void publish(false)}>
					{busy && <LoaderCircleIcon className="animate-spin" />}
					{busy ? "正在处理…" : `上架选中（${publishable.length}）`}
				</Button>
				<SourcePromptButton item={item} shop={shop} sourceIds={picked.map((row) => row.id)} disabled={working} />
			</div>
			<ErrorMessage>{error ?? loadError}</ErrorMessage>
			{receipt && (
				<PublishResult
					result={activeResult}
					receipt={receipt}
					error={receiptError}
					busy={busy}
					reload={() => {
						reloadResult();
						reload();
					}}
				/>
			)}
			{!data && !loadError ? (
				<Skeleton className="h-72 w-full" />
			) : (
				<SourceTable
					rows={rows}
					selected={selected}
					busy={working}
					toggle={toggle}
					toggleAll={(checked) => setSelected(checked ? new Set(eligible.map((row) => row.id)) : new Set())}
					detail={setDetailId}
					remove={(id) => askDelete([id])}
				/>
			)}
			{data && (
				<p className="text-xs text-muted-foreground">
					当前查询 {data.total} 件 · 可上架 {data.counts.ready} 件 · 待补充 {data.counts.needsInput} 件 · 已上架 {data.counts.listed} 件
					{data.counts.unknown ? ` · 待核对 ${data.counts.unknown} 件` : ""}
				</p>
			)}
			<SourceSheet sourceId={detailId} targetShop={shop} item={item} onClose={() => setDetailId(null)} onSaved={reload} />
			<Dialog open={deleteIds !== null} onOpenChange={(open) => !open && !deleting && setDeleteIds(null)}>
				<DialogContent className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>删除 {deleteIds?.length ?? 0} 件备选？</DialogTitle>
						<DialogDescription className="sr-only">确认从上架备选区移除选中的商品。</DialogDescription>
					</DialogHeader>
					<ErrorMessage>{error}</ErrorMessage>
					<DialogFooter>
						<Button variant="outline" onClick={() => setDeleteIds(null)} disabled={deleting}>
							取消
						</Button>
						<Button onClick={() => void remove()} disabled={deleting}>
							{deleting && <LoaderCircleIcon className="animate-spin" />}
							{deleting ? "删除中…" : "删除"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</main>
	);
}

function SourceTable({
	rows,
	selected,
	busy,
	toggle,
	toggleAll,
	detail,
	remove,
}: {
	rows: SourceItem[];
	selected: Set<string>;
	busy: boolean;
	toggle: (id: string, checked: boolean) => void;
	toggleAll: (checked: boolean) => void;
	detail: (id: string) => void;
	remove: (id: string) => void;
}) {
	const eligible = rows.filter(sourceCanSelect);
	const picked = eligible.filter((row) => selected.has(row.id));
	return (
		<div className="overflow-hidden rounded-xl border bg-background">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="w-10">
							<Checkbox
								aria-label="全选当前查询中的备选商品"
								checked={Boolean(eligible.length && picked.length === eligible.length)}
								indeterminate={picked.length > 0 && picked.length < eligible.length}
								disabled={busy || !eligible.length}
								onCheckedChange={(checked) => toggleAll(checked === true)}
							/>
						</TableHead>
						<TableHead>商品</TableHead>
						<TableHead>货源链接</TableHead>
						<TableHead>规格</TableHead>
						<TableHead>状态</TableHead>
						<TableHead>操作</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((row) => (
						<TableRow key={row.id}>
							<TableCell>
								<Checkbox
									aria-label={`选择 ${row.title}`}
									checked={selected.has(row.id) && sourceCanSelect(row)}
									disabled={busy || !sourceCanSelect(row)}
									onCheckedChange={(checked) => toggle(row.id, checked === true)}
								/>
							</TableCell>
							<TableCell>
								<button
									type="button"
									className="flex max-w-md items-center gap-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
									onClick={() => detail(row.id)}
								>
									{row.image ? (
										<img
											src={row.image}
											alt={row.title}
											referrerPolicy="no-referrer"
											loading="lazy"
											className="size-16 shrink-0 rounded-lg border object-contain"
										/>
									) : (
										<span className="flex size-16 shrink-0 items-center justify-center rounded-lg border bg-muted/30">
											<PackageSearchIcon className="size-6 text-muted-foreground" />
										</span>
									)}
									<span className="line-clamp-2 text-sm font-medium">{row.title || "未取得商品标题"}</span>
								</button>
							</TableCell>
							<TableCell>
								<a href={row.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm underline underline-offset-4">
									{row.platform}
									<ArrowUpRightIcon className="size-3" />
								</a>
								<p className="mt-1 max-w-44 truncate text-xs text-muted-foreground">{row.url}</p>
							</TableCell>
							<TableCell className="text-sm">{row.skuCount ? `${row.skuCount} 规格` : "待补规格"}</TableCell>
							<TableCell>
								<Badge variant="secondary">{sourceStatus[row.status]}</Badge>
								{row.editedAt && (
									<Badge variant="outline" className="ml-1">
										已人工编辑
									</Badge>
								)}
								{row.problems.length > 0 && <p className="mt-1 max-w-52 text-xs text-muted-foreground">{row.problems[0]}</p>}
								{row.errors.length > 0 && <p className="mt-1 max-w-52 text-xs text-destructive">{row.errors[0]}</p>}
							</TableCell>
							<TableCell>
								<Button variant="link" size="sm" onClick={() => detail(row.id)}>
									查看详情
								</Button>
								<Button variant="link" size="sm" disabled={busy || !row.deletable} title={row.deleteProblem ?? undefined} onClick={() => remove(row.id)}>
									删除
								</Button>
							</TableCell>
						</TableRow>
					))}
					{!rows.length && (
						<TableRow>
							<TableCell colSpan={6} className="py-16 text-center text-sm text-muted-foreground">
								没有符合条件的备选商品，采集后会显示在这里。
							</TableCell>
						</TableRow>
					)}
				</TableBody>
			</Table>
		</div>
	);
}

function PublishResult({
	result,
	receipt,
	error,
	busy,
	reload,
}: {
	result: SourceReceipt | null;
	receipt: PublishReceipt;
	error: string | null;
	busy: boolean;
	reload: () => void;
}) {
	const state = result?.state ?? receipt.state;
	const items = result?.items ?? [];
	return (
		<section className="space-y-3 rounded-xl border bg-background p-4" aria-live="polite">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h3 className="font-semibold">
					{busy || state === "running"
						? "正在处理本次上架"
						: state === "completed"
							? "本次上架结果"
							: state === "unknown"
								? "本次上架结果待核对"
								: "上次上架尚未提交"}
				</h3>
				<Button variant="outline" size="sm" onClick={reload}>
					<RefreshCwIcon />
					查询结果
				</Button>
			</div>
			{items.length > 0 && (
				<p className="text-sm">
					已上架 {items.filter((row) => row.status === "listed").length} · 留在备选区 {items.filter((row) => row.status !== "listed").length}
				</p>
			)}
			{state === "unknown" && <p className="text-sm text-muted-foreground">当前结果尚未核清，已暂停再次发布，避免重复上架。请查询结果或使用现有核对流程。</p>}
			{!busy && <ErrorMessage>{error ?? receipt.error}</ErrorMessage>}
			{items.map((row) => (
				<div key={row.id} className="flex flex-wrap items-center gap-2 border-t pt-2 text-sm">
					<span className="min-w-0 flex-1 truncate">{row.title}</span>
					<Badge variant="secondary">{sourceStatus[row.status]}</Badge>
					{row.productId ? (
						<a href={`https://seller.shopee.tw/portal/product/${row.productId}`} target="_blank" rel="noreferrer" className="underline underline-offset-4">
							查看 Shopee（虾皮）商品
						</a>
					) : (
						row.problems[0] && <span className="max-w-md text-xs text-muted-foreground">{row.problems[0]}</span>
					)}
				</div>
			))}
		</section>
	);
}
