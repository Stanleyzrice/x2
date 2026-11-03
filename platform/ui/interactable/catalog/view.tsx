// Catalog 工作台：查询固定店铺快照；上下架先预览精确目标再确认，结果未知保留请求并只读核对。
import { ArrowUpRightIcon, BoxesIcon, LayoutGridIcon, ListIcon, PackageSearchIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useLightbox } from "@/components/lightbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, type Item as PageItem } from "../../api.ts";
import type { Props } from "./schema.ts";
import type { CatalogResult, Product } from "./types.ts";

const money = (n: number | null) =>
	n === null ? "未知" : new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 2 }).format(n);
const price = (p: Product) =>
	p.priceMin === null || p.priceMax === null ? "未知" : p.priceMin === p.priceMax ? money(p.priceMin) : `${money(p.priceMin)} – ${money(p.priceMax)}`;
const time = (value: string | null | undefined) => (value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未采集");
const STOCK = { in_stock: "有库存", sold_out: "售罄", unknown: "库存未知" };
const PENDING = new Set(["待执行", "已提交", "结果未知", "不一致"]);
type StatusChange = NonNullable<Product["statusChange"]>;
type Receipt = StatusChange & { productId: string };
type StatusResult = { shop: string; productId: string; statusChange: StatusChange };
type StatusPreview = {
	token: string;
	display: string;
	expiresAt: string;
	trialRequired: boolean;
	productId: string;
	requestId: string;
	targetState: "listed" | "unlisted";
};

function savedReceipts(key: string): Record<string, Receipt> {
	try {
		const saved: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
		if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
		return Object.fromEntries(
			Object.entries(saved as Record<string, unknown>).filter((entry): entry is [string, Receipt] => {
				const value = entry[1] as Partial<Receipt> | null;
				return Boolean(
					value &&
						typeof value === "object" &&
						typeof value.productId === "string" &&
						value.productId === entry[0] &&
						typeof value.requestId === "string" &&
						/^[a-f0-9-]{36}$/i.test(value.requestId) &&
						typeof value.targetState === "string" &&
						["listed", "unlisted"].includes(value.targetState) &&
						typeof value.status === "string" &&
						(value.error === null || typeof value.error === "string"),
				);
			}),
		);
	} catch {
		return {};
	}
}

export function View({ props, item }: { props: Props; item: PageItem }) {
	return <Catalog key={`${item.id}:${props.shop}`} props={props} item={item} />;
}

function Catalog({ props, item }: { props: Props; item: PageItem }) {
	const [search, setSearch] = useState("");
	const [query, setQuery] = useState("");
	const [stock, setStock] = useState("all");
	const [status, setStatus] = useState<string>(props.defaultStatus);
	const [page, setPage] = useState(1);
	const [layout, setLayout] = useState<"table" | "cards">("table");
	const [received, setData] = useState<{ key: string; value: CatalogResult } | null>(null);
	const queryKey = JSON.stringify([query, status, stock, page]);
	const data = received?.key === queryKey ? received.value : null;
	const [error, setError] = useState<string | null>(null);
	const [syncError, setSyncError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [loading, setLoading] = useState(true);
	const [version, setVersion] = useState(0);
	const [selected, setSelected] = useState<Product | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [notice, setNotice] = useState<Receipt | null>(null);
	const [statusBusy, setStatusBusy] = useState<string | null>(null);
	const [preview, setPreview] = useState<StatusPreview | null>(null);
	const [trial, setTrial] = useState(false);
	const storageKey = `x2-catalog-status:${item.id}:${props.shop}`;
	const [receipts, setReceipts] = useState(() => savedReceipts(storageKey));
	const receiptRef = useRef(receipts);
	const remember = useCallback(
		(receipt: Receipt) => {
			if (JSON.stringify(receiptRef.current[receipt.productId]) === JSON.stringify(receipt)) return false;
			const next = { ...receiptRef.current, [receipt.productId]: receipt };
			localStorage.setItem(storageKey, JSON.stringify(next));
			receiptRef.current = next;
			setReceipts(next);
			return true;
		},
		[storageKey],
	);
	const applyResult = useCallback(
		(result: StatusResult) => {
			if (result.shop !== props.shop) throw new Error("状态结果店铺不符，请重新读取");
			const receipt = { productId: result.productId, ...result.statusChange };
			if (remember(receipt) && !PENDING.has(receipt.status)) {
				setNotice(receipt);
				setPage(1);
				setVersion((v) => v + 1);
			}
			return receipt;
		},
		[props.shop, remember],
	);
	useEffect(() => {
		const pending = Object.values(receipts).filter((r) => PENDING.has(r.status));
		if (!pending.length || statusBusy) return;
		let stopped = false;
		const read = async () => {
			for (const receipt of pending) {
				if (stopped) return;
				try {
					const result = await api.act<StatusResult>(item.id, "statusResult", { productId: receipt.productId, requestId: receipt.requestId });
					if (!stopped) applyResult(result);
				} catch (e) {
					if (!stopped) setActionError((e as Error).message);
				}
			}
		};
		void read();
		const timer = setInterval(() => void read(), 15_000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [item.id, receipts, statusBusy, applyResult]);
	useEffect(() => {
		const timer = setTimeout(() => {
			setQuery(search.trim());
			setPage(1);
		}, 250);
		return () => clearTimeout(timer);
	}, [search]);
	useEffect(() => {
		let stopped = false;
		let request = version;
		setLoading(true);
		const read = () => {
			const id = ++request;
			api.act<CatalogResult>(item.id, "products", { query, status, stock, page, pageSize: 50 }).then(
				(result) => {
					if (!stopped && id === request) {
						setData({ key: queryKey, value: result });
						setError(null);
						setLoading(false);
					}
				},
				(e: Error) => {
					if (!stopped && id === request) {
						setError(e.message);
						setLoading(false);
					}
				},
			);
		};
		read();
		const timer = setInterval(read, 15_000);
		window.addEventListener("focus", read);
		return () => {
			stopped = true;
			clearInterval(timer);
			window.removeEventListener("focus", read);
		};
	}, [item.id, query, status, stock, page, version, queryKey]);
	const refresh = async () => {
		setRefreshing(true);
		setSyncError(null);
		try {
			const result = await api.act<CatalogResult & { ok: boolean; error: string | null }>(item.id, "sync");
			if (!result.ok) setSyncError(result.error);
			setPage(1);
			setVersion((v) => v + 1);
		} catch (e) {
			setSyncError((e as Error).message);
		} finally {
			setRefreshing(false);
		}
	};
	const open = (product: Product) => setSelected(product);
	const changeFor = (product: Product) => {
		const local = receipts[product.productId],
			remote = product.statusChange;
		if (remote && local?.requestId === remote.requestId) return PENDING.has(local.status) ? remote : local;
		return remote ?? local;
	};
	const chooseStatus = async (product: Product, targetState: "listed" | "unlisted") => {
		if (statusBusy || PENDING.has(changeFor(product)?.status ?? "") || PENDING.has(receipts[product.productId]?.status ?? "")) return;
		setStatusBusy(product.productId);
		setActionError(null);
		setNotice(null);
		try {
			const requestId = crypto.randomUUID();
			const result = await api.prepare(item.id, "setStatus", { productId: product.productId, targetState, requestId });
			setTrial(false);
			setPreview({
				...result,
				trialRequired: (result as { trialRequired?: boolean }).trialRequired ?? true,
				productId: product.productId,
				targetState,
				requestId,
			});
		} catch (e) {
			setActionError((e as Error).message);
		} finally {
			setStatusBusy(null);
		}
	};
	const reconcile = async (productId: string, change: StatusChange) => {
		if (statusBusy) return;
		setStatusBusy(productId);
		setActionError(null);
		try {
			applyResult(await api.act<StatusResult>(item.id, "reconcileStatus", { productId, requestId: change.requestId }));
		} catch (e) {
			setActionError((e as Error).message);
		} finally {
			setStatusBusy(null);
		}
	};
	const confirm = async () => {
		if (!preview || statusBusy || (preview.trialRequired && !trial)) return;
		const current = preview;
		setActionError(null);
		try {
			remember({ productId: current.productId, requestId: current.requestId, targetState: current.targetState, status: "已提交", error: null });
		} catch {
			setActionError("无法保存待核对请求，未提交。请检查浏览器储存空间后重新确认。");
			return;
		}
		setStatusBusy(current.productId);
		setPreview(null);
		try {
			await api.confirm(current.token, current.trialRequired && trial);
			applyResult(await api.act<StatusResult>(item.id, "statusResult", { productId: current.productId, requestId: current.requestId }));
		} catch (e) {
			const message = (e as Error).message;
			try {
				remember({ productId: current.productId, requestId: current.requestId, targetState: current.targetState, status: "结果未知", error: message });
			} catch {
				/* 提交前保存的请求仍保留，继续显示待核对状态。 */
			}
			setActionError(`${message}；请求已保留，只核对结果，不自动重发。`);
		} finally {
			setStatusBusy(null);
			setVersion((v) => v + 1);
		}
	};
	const renderStatus = (product: Product) => (
		<StatusControl
			product={product}
			change={changeFor(product)}
			disabled={statusBusy !== null || preview !== null}
			pendingLocal={PENDING.has(receipts[product.productId]?.status ?? "")}
			choose={(state) => void chooseStatus(product, state)}
			reconcile={() => {
				const change = changeFor(product);
				if (change) void reconcile(product.productId, change);
			}}
		/>
	);
	const detailsComplete = status === "1" ? data?.listedDetailsComplete : data?.snapshot?.detailsComplete;
	return (
		<div className="flex min-h-full flex-col gap-5 p-4 md:p-6">
			<header className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
						<BoxesIcon className="size-4" /> SHOPEE · CATALOG
					</div>
					<h2 className="text-2xl font-semibold tracking-tight">{props.title ?? props.shop}</h2>
					<p className="mt-1 text-sm text-muted-foreground">店铺商品与 SKU · 从侧栏切换店铺</p>
				</div>
				<Button onClick={refresh} disabled={refreshing}>
					<RefreshCwIcon className={refreshing ? "animate-spin" : ""} />
					{refreshing ? "正在读取 Shopee…" : "刷新目录"}
				</Button>
			</header>
			<div className="grid gap-3 sm:grid-cols-3">
				<Metric label="在售商品" value={data?.snapshot ? String(data.listedCount) : "—"} note="当前已上架的商品，包含售罄商品" />
				<Metric label="当前查询" value={data ? String(data.total) : "—"} note={`${status === "1" ? "在售" : "未上架（下架）"}范围 · 商品名 / SKU / 库存筛选`} />
				<Metric label="采集时间" value={time(data?.snapshot?.capturedAt)} note="最近成功读取的 Shopee 数据" compact />
			</div>
			{actionError && (
				<div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
					{actionError}
				</div>
			)}
			{notice && (
				<div role="status" className="rounded-xl border bg-muted/30 p-4 text-sm">
					商品 {notice.productId} · {notice.targetState === "listed" ? "上架" : "下架"}：{notice.status}
					{notice.error ? ` · ${notice.error}` : ""}
				</div>
			)}
			{Object.values(receipts).some((r) => PENDING.has(r.status)) && (
				<div role="status" className="space-y-2 rounded-xl border bg-muted/30 p-4 text-sm">
					<p className="font-medium">待核对的状态修改</p>
					{Object.values(receipts)
						.filter((r) => PENDING.has(r.status))
						.map((r) => (
							<div key={r.requestId} className="flex flex-wrap items-center justify-between gap-2">
								<span>
									商品 {r.productId} · {r.targetState === "listed" ? "上架" : "下架"} · {r.status}
								</span>
								<Button size="sm" variant="outline" disabled={statusBusy !== null} onClick={() => void reconcile(r.productId, r)}>
									核对结果
								</Button>
							</div>
						))}
					<p className="text-xs text-muted-foreground">请求已保留，刷新页面后仍可核对；不会自动重新提交。</p>
				</div>
			)}
			{(error || syncError || data?.lastAttempt?.error) && (
				<div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
					<p className="font-medium text-destructive">{syncError ?? error ?? data?.lastAttempt?.error}</p>
					<p className="mt-1 text-muted-foreground">{data?.snapshot ? `当前仍展示 ${time(data.snapshot.capturedAt)} 的快照。` : "尚无可展示的成功快照。"}</p>
				</div>
			)}
			{data?.snapshot && (
				<div className="flex flex-wrap items-center gap-2 rounded-xl border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
					<Badge variant="outline">Shopee 快照</Badge>
					<Badge variant="secondary">{status === "1" ? "在售" : "已下架"}</Badge>
					<Badge variant={detailsComplete ? "secondary" : "outline"}>
						{detailsComplete ? "列表与规格完整" : status === "1" ? "在售列表完整 · 部分详情不可读取" : "列表完整 · 全目录部分详情不可读取"}
					</Badge>
					<span>
						读取范围 {time(data.snapshot.startedAt)} – {time(data.snapshot.capturedAt)}
					</span>
					{data.lastAttempt && <span>最近刷新 {time(data.lastAttempt.finishedAt)}</span>}
				</div>
			)}
			{(refreshing || data?.lastAttempt?.status === "running") && (
				<div role="status" className="flex items-center gap-3 rounded-xl border bg-muted/30 px-4 py-3 text-sm">
					<RefreshCwIcon className="size-4 animate-spin" />
					<div>
						<p className="font-medium">正在读取 Shopee，保留现有快照供查看</p>
						<p className="mt-0.5 text-xs text-muted-foreground">
							{data?.lastAttempt?.phase === "listing"
								? `商品列表第 ${data.lastAttempt.page ?? 1} 页`
								: data?.lastAttempt?.phase === "details"
									? `SKU 详情 ${data.lastAttempt.observed ?? 0} / ${data.lastAttempt.expectedCount ?? "未知"} 个商品`
									: "正在核对店铺身份与读取范围"}
						</p>
					</div>
				</div>
			)}
			<Card className="gap-0 overflow-hidden">
				<CardHeader className="border-b pb-4">
					<div className="flex flex-wrap items-center gap-3">
						<div className="relative min-w-48 flex-1">
							<SearchIcon className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
							<Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索商品、SKU、规格…" aria-label="搜索 Catalog" className="pl-8" />
						</div>
						<Filter
							value={status}
							label="商品状态"
							onChange={(value) => {
								setStatus(value);
								setPage(1);
							}}
							options={[
								{ value: "1", label: "在售" },
								{ value: "8", label: "未上架（下架）" },
							]}
						/>
						<Filter
							value={stock}
							label="库存状态"
							onChange={(value) => {
								setStock(value);
								setPage(1);
							}}
							options={[
								{ value: "all", label: "全部库存" },
								{ value: "in_stock", label: "有库存" },
								{ value: "sold_out", label: "售罄" },
								{ value: "unknown", label: "库存未知" },
							]}
						/>
						<div className="flex rounded-lg border p-0.5">
							<Button size="icon-sm" variant={layout === "table" ? "secondary" : "ghost"} aria-label="表格视图" onClick={() => setLayout("table")}>
								<ListIcon />
							</Button>
							<Button size="icon-sm" variant={layout === "cards" ? "secondary" : "ghost"} aria-label="卡片视图" onClick={() => setLayout("cards")}>
								<LayoutGridIcon />
							</Button>
						</div>
					</div>
				</CardHeader>
				<CardContent className="p-0">
					{loading && !data ? (
						<div className="space-y-3 p-5">
							<Skeleton className="h-12" />
							<Skeleton className="h-16" />
							<Skeleton className="h-16" />
						</div>
					) : !data?.snapshot ? (
						<Empty title="还没有目录快照" detail="点击刷新目录，查看当前店铺的商品与规格。" />
					) : !data.rows.length ? (
						<Empty title={`没有符合条件的${status === "1" ? "在售" : "未上架"}商品`} detail="尝试调整商品状态、关键词或库存筛选。" />
					) : layout === "table" ? (
						<ProductTable rows={data.rows} open={open} renderStatus={renderStatus} />
					) : (
						<div className="grid gap-4 p-4 sm:grid-cols-2 xl:grid-cols-3">
							{data.rows.map((p) => (
								<ProductCard key={p.productId} product={p} open={() => open(p)} renderStatus={renderStatus} />
							))}
						</div>
					)}
				</CardContent>
				<div className="flex items-center justify-between gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
					<span>
						{loading ? "更新查询…" : `${data?.total ?? 0} 个商品`} · 第 {page} 页
					</span>
					<div className="flex gap-2">
						<Button size="sm" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((n) => n - 1)}>
							上一页
						</Button>
						<Button size="sm" variant="outline" disabled={!data || page * data.pageSize >= data.total || loading} onClick={() => setPage((n) => n + 1)}>
							下一页
						</Button>
					</div>
				</div>
			</Card>
			<Details
				key={`${selected?.productId ?? "closed"}:${version}`}
				item={item.id}
				product={selected}
				close={() => setSelected(null)}
				renderStatus={renderStatus}
			/>
			<Dialog
				open={preview !== null}
				onOpenChange={(open) => {
					if (!open && !statusBusy) setPreview(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>确认商品{preview?.targetState === "listed" ? "上架" : "下架"}</DialogTitle>
					</DialogHeader>
					<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">{preview?.display}</pre>
					{preview?.trialRequired && (
						<label htmlFor={`catalog-trial-${item.id}`} className="flex items-start gap-2 text-sm">
							<Checkbox id={`catalog-trial-${item.id}`} checked={trial} onCheckedChange={(value) => setTrial(value === true)} />
							首次执行此方向：确认这一件商品，并在 Shopee 核对结果
						</label>
					)}
					<DialogFooter>
						<Button variant="outline" disabled={statusBusy !== null} onClick={() => setPreview(null)}>
							取消
						</Button>
						<Button disabled={statusBusy !== null || Boolean(preview?.trialRequired && !trial)} onClick={() => void confirm()}>
							确认{preview?.targetState === "listed" ? "上架" : "下架"}这一件
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function StatusControl({
	product,
	change,
	disabled,
	pendingLocal,
	choose,
	reconcile,
}: {
	product: Product;
	change: StatusChange | null | undefined;
	disabled: boolean;
	pendingLocal: boolean;
	choose: (state: "listed" | "unlisted") => void;
	reconcile: () => void;
}) {
	const pending = change && PENDING.has(change.status);
	const editable = product.status === 1 || product.status === 8;
	return (
		<div className="min-w-28 space-y-1.5">
			{editable ? (
				<Select
					value={product.status === 1 ? "listed" : "unlisted"}
					disabled={disabled || pendingLocal || Boolean(pending)}
					onValueChange={(value) => {
						if ((value === "listed" || value === "unlisted") && value !== (product.status === 1 ? "listed" : "unlisted")) choose(value);
					}}
					items={[
						{ value: "listed", label: "在售" },
						{ value: "unlisted", label: "已下架" },
					]}
				>
					<SelectTrigger aria-label={`商品状态 ${product.productId}`} className="min-w-28">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="listed">在售</SelectItem>
						<SelectItem value="unlisted">已下架</SelectItem>
					</SelectContent>
				</Select>
			) : (
				<Badge variant="outline">{product.statusLabel}</Badge>
			)}
			{pending && (
				<div className="space-y-1">
					<p className="text-xs text-muted-foreground">{change.status}</p>
					<Button size="sm" variant="outline" disabled={disabled} onClick={reconcile}>
						核对结果
					</Button>
				</div>
			)}
			{change?.error && <p className="max-w-56 text-xs text-destructive">{change.error}</p>}
		</div>
	);
}

function Metric({ label, value, note, compact }: { label: string; value: string; note: string; compact?: boolean }) {
	return (
		<Card className="gap-2 py-4">
			<CardHeader className="px-4">
				<CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
			</CardHeader>
			<CardContent className="px-4">
				<div className={compact ? "text-sm font-medium" : "text-2xl font-semibold tabular-nums"}>{value}</div>
				<p className="mt-1 text-xs text-muted-foreground">{note}</p>
			</CardContent>
		</Card>
	);
}

function Filter({
	value,
	label,
	options,
	onChange,
}: {
	value: string;
	label: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
}) {
	return (
		<Select value={value} onValueChange={(v) => v !== null && onChange(String(v))} items={options}>
			<SelectTrigger aria-label={label} className="min-w-28">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((o) => (
					<SelectItem key={o.value} value={o.value}>
						{o.label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

function Cover({ product, large }: { product: Product; large?: boolean }) {
	return (
		<div className={`${large ? "aspect-square w-full" : "size-14 shrink-0"} overflow-hidden rounded-lg border bg-muted`}>
			{product.cover ? (
				<img src={product.cover} alt={product.name} loading="lazy" className="h-full w-full object-cover" />
			) : (
				<div className="flex h-full items-center justify-center text-muted-foreground">
					<BoxesIcon className="size-6" />
				</div>
			)}
		</div>
	);
}

function ProductTable({ rows, open, renderStatus }: { rows: Product[]; open: (product: Product) => void; renderStatus: (product: Product) => ReactNode }) {
	return (
		<div className="overflow-x-auto">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead className="min-w-72">商品</TableHead>
						<TableHead>状态</TableHead>
						<TableHead>售价 TWD</TableHead>
						<TableHead>库存</TableHead>
						<TableHead>1688 来源</TableHead>
						<TableHead className="w-20">详情</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.map((p) => (
						<TableRow key={p.productId}>
							<TableCell className="whitespace-normal">
								<div className="flex items-center gap-3">
									<Cover product={p} />
									<div className="min-w-0 max-w-96">
										<button
											type="button"
											className="line-clamp-2 max-w-96 whitespace-normal break-words text-left font-medium hover:underline"
											onClick={() => open(p)}
										>
											{p.name || p.productId}
										</button>
										<p className="mt-1 break-all text-xs text-muted-foreground">
											{p.parentSku ?? "主 SKU 未提供"} · {p.productId}
										</p>
									</div>
								</div>
							</TableCell>
							<TableCell>{renderStatus(p)}</TableCell>
							<TableCell className="whitespace-nowrap tabular-nums">{price(p)}</TableCell>
							<TableCell>
								<div className="tabular-nums">{p.stockTotal ?? "未知"}</div>
								<span className="text-xs text-muted-foreground">{STOCK[p.stockState]}</span>
							</TableCell>
							<TableCell>
								<Sources product={p} compact />
							</TableCell>
							<TableCell>
								<Button size="sm" variant="ghost" onClick={() => open(p)}>
									查看
								</Button>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

function ProductCard({ product: p, open, renderStatus }: { product: Product; open: () => void; renderStatus: (product: Product) => ReactNode }) {
	return (
		<Card className="gap-3 overflow-hidden p-3">
			<button type="button" onClick={open} aria-label={`查看 ${p.name}`}>
				<Cover product={p} large />
			</button>
			<div>
				<div className="flex flex-wrap gap-1.5">
					{renderStatus(p)}
					<Badge variant="secondary">{STOCK[p.stockState]}</Badge>
				</div>
				<button type="button" onClick={open} className="mt-2 line-clamp-2 text-left text-sm font-medium hover:underline">
					{p.name}
				</button>
				<p className="mt-1 break-all text-xs text-muted-foreground">{p.parentSku ?? p.productId}</p>
				<div className="mt-2 font-semibold tabular-nums">{price(p)}</div>
				<div className="mt-2">
					<Sources product={p} compact />
				</div>
			</div>
		</Card>
	);
}

function Sources({ product: p, compact }: { product: Product; compact?: boolean }) {
	return (
		<div className="flex flex-col gap-1.5">
			{p.suppliers.length ? (
				p.suppliers.map((s) => (
					<div key={`${s.kind}:${s.offerId}`} className="min-w-0">
						{!compact && <p className="mb-1 text-xs text-muted-foreground">{s.kind === "listing" ? "上品来源" : "已选货源"}</p>}
						<a href={s.url} target="_blank" rel="noreferrer" className="block break-all text-xs text-primary underline-offset-2 hover:underline">
							{compact ? (s.kind === "listing" ? "上品来源" : "已选货源") : s.url}
							<ArrowUpRightIcon className="ml-1 inline size-3" />
						</a>
						{s.broken && <p className="text-xs text-destructive">不可用：{s.broken}</p>}
					</div>
				))
			) : (
				<span className="text-xs text-muted-foreground">链接待补</span>
			)}
			{p.supplierWarnings.map((warning) => (
				<p key={warning} className="max-w-64 text-xs text-muted-foreground">
					{warning}
				</p>
			))}
		</div>
	);
}

function Details({
	item,
	product,
	close,
	renderStatus,
}: {
	item: string;
	product: Product | null;
	close: () => void;
	renderStatus: (product: Product) => ReactNode;
}) {
	const [loaded, setLoaded] = useState<Product | null>(null);
	const [error, setError] = useState<string | null>(null);
	const id = product?.productId;
	useEffect(() => {
		let stopped = false;
		setLoaded(null);
		setError(null);
		if (id)
			api.act<{ product: Product }>(item, "product", { productId: id }).then(
				(r) => {
					if (!stopped) setLoaded(r.product);
				},
				(e: Error) => {
					if (!stopped) setError(e.message);
				},
			);
		return () => {
			stopped = true;
		};
	}, [item, id]);
	const p = loaded ?? product;
	const modelImages = (p?.models ?? []).flatMap((m, row) => (m.image ? [{ src: m.image, alt: m.name, label: m.name, row }] : []));
	const lightbox = useLightbox(modelImages);
	return (
		<Sheet open={Boolean(product)} onOpenChange={(open) => !open && close()}>
			<SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
				<SheetHeader>
					<SheetTitle>{p?.name ?? "商品详情"}</SheetTitle>
					<SheetDescription>{p ? `商品 ${p.productId} · ${p.parentSku ?? "主 SKU 未提供"}` : "当前目录快照"}</SheetDescription>
				</SheetHeader>
				{p && (
					<div className="space-y-5 p-4">
						<div className="flex items-start gap-4">
							<div className="w-32 shrink-0">
								<Cover product={p} large />
							</div>
							<div className="space-y-2">
								{renderStatus(p)}
								<p className="text-xl font-semibold">{price(p)}</p>
								<p className="text-sm text-muted-foreground">
									库存 {p.stockTotal ?? "未知"} · {STOCK[p.stockState]}
								</p>
							</div>
						</div>
						<Sources product={p} />
						{(error || p.detailError || p.imageError) && (
							<p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">
								{error ?? p.detailError ?? p.imageError}
							</p>
						)}
						<div>
							<h3 className="mb-3 text-sm font-semibold">SKU 与规格</h3>
							{p.models?.length ? (
								<div className="overflow-x-auto rounded-lg border">
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>规格 / SKU</TableHead>
												<TableHead>价格 TWD</TableHead>
												<TableHead>库存</TableHead>
											</TableRow>
										</TableHeader>
										<TableBody>
											{p.models.map((m, i) => (
												<TableRow key={m.modelId ?? `unknown-${i}`}>
													<TableCell className="whitespace-normal">
														<div className="flex items-center gap-3">
															{m.image ? (
																<button
																	type="button"
																	className="size-14 shrink-0 overflow-hidden rounded-lg border bg-muted"
																	aria-label={`查看规格图片 ${m.name}`}
																	onClick={() => lightbox.open(modelImages.findIndex((photo) => photo.row === i))}
																>
																	<img src={m.image} alt={m.name} loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-contain" />
																</button>
															) : (
																<div className="flex size-14 shrink-0 items-center justify-center rounded-lg border bg-muted text-xs text-muted-foreground">
																	图片待补
																</div>
															)}
															<div className="min-w-0">
																<p className="font-medium">{m.name}</p>
																<p className="mt-1 break-all text-xs text-muted-foreground">{m.sku ?? "SKU 未提供"}</p>
																<p className="text-xs text-muted-foreground">Model ID {m.modelId ?? "未知"}</p>
															</div>
														</div>
													</TableCell>
													<TableCell className="whitespace-nowrap">{money(m.price)}</TableCell>
													<TableCell>{m.stock ?? "未知"}</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</div>
							) : (
								<p className="text-sm text-muted-foreground">网站未提供可展示的规格明细。</p>
							)}
						</div>
					</div>
				)}
			</SheetContent>
			{lightbox.lightbox}
		</Sheet>
	);
}

function Empty({ title, detail }: { title: string; detail: string }) {
	return (
		<div className="flex flex-col items-center px-5 py-16 text-center">
			<PackageSearchIcon className="mb-4 size-10 text-muted-foreground/60" />
			<h3 className="font-medium">{title}</h3>
			<p className="mt-2 max-w-sm text-sm text-muted-foreground">{detail}</p>
		</div>
	);
}

export const tab = (p: Props) => p.title ?? `${p.shop} Catalog`;
